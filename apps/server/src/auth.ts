import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Sql, Tx } from './db.js';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;

export type Scope = 'read' | 'write' | 'decide';
export const ALL_SCOPES: readonly Scope[] = ['read', 'write', 'decide'];

export type TokenKind = 'pat' | 'oauth';

export interface AuthInfo {
  tokenId: string;
  label: string;
  scopes: Scope[];
  kind: TokenKind;
  clientId: string | null;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return `tm_${randomBytes(32).toString('base64url')}`;
}

export function parseScopes(raw: string | string[] | undefined, fallback: Scope[] = ['read', 'write']): Scope[] {
  const list = Array.isArray(raw) ? raw : (raw ?? '').split(/[\s,]+/);
  const out = [...new Set(list.map((s) => s.trim()).filter(Boolean))];
  if (out.length === 0) return [...fallback];
  for (const s of out) if (!ALL_SCOPES.includes(s as Scope)) throw new Error(`unknown scope: ${s}`);
  return ALL_SCOPES.filter((s) => out.includes(s));
}

// ---------- owner password (scrypt) ----------

const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export async function setOwnerPassword(sql: Sql, password: string): Promise<void> {
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const hash = await hashPassword(password);
  await sql`update account set password_hash = ${hash}`;
}

export async function ownerPasswordHash(sql: Sql | Tx): Promise<string | null> {
  const rows = await sql`select password_hash from account limit 1`;
  return (rows[0]?.password_hash as string | null | undefined) ?? null;
}

// ---------- access tokens ----------

export interface TokenSummary {
  id: string;
  label: string;
  scopes: string[];
  kind: TokenKind;
  clientId: string | null;
  clientName: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function toSummary(r: Record<string, unknown>): TokenSummary {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
  return {
    id: r.id as string,
    label: r.label as string,
    scopes: r.scopes as string[],
    kind: ((r.kind as TokenKind | undefined) ?? 'pat'),
    clientId: (r.client_id as string | null | undefined) ?? null,
    clientName: (r.client_name as string | null | undefined) ?? null,
    expiresAt: iso(r.expires_at),
    lastUsedAt: iso(r.last_used_at),
    revokedAt: iso(r.revoked_at),
    createdAt: iso(r.created_at)!,
  };
}

export async function createToken(
  sql: Sql,
  opts: { label: string; scopes?: Scope[]; expiresAt?: string | null },
): Promise<{ token: string; summary: TokenSummary }> {
  const token = generateToken();
  const scopes = opts.scopes && opts.scopes.length ? opts.scopes : (['read', 'write'] as Scope[]);
  for (const s of scopes) if (!ALL_SCOPES.includes(s)) throw new Error(`unknown scope: ${s}`);
  const rows = await sql`
    insert into access_token (token_hash, label, scopes, expires_at, kind)
    values (${hashToken(token)}, ${opts.label}, ${sql.array(scopes, 1009)}, ${opts.expiresAt ?? null}, 'pat')
    returning *`;
  return { token, summary: toSummary(rows[0]!) };
}

/** Issue an OAuth access token for a registered client. */
export async function createOAuthAccessToken(
  sql: Sql | Tx,
  opts: { clientId: string; label: string; scopes: Scope[]; expiresAt: Date },
): Promise<{ token: string; id: string }> {
  const token = generateToken();
  const rows = await sql`
    insert into access_token (token_hash, label, scopes, expires_at, kind, client_id)
    values (${hashToken(token)}, ${opts.label}, ${sql.array(opts.scopes, 1009)}, ${opts.expiresAt.toISOString()}, 'oauth', ${opts.clientId})
    returning id`;
  return { token, id: rows[0]!.id as string };
}

export async function listTokens(sql: Sql): Promise<TokenSummary[]> {
  const rows = await sql`
    select t.*, c.name as client_name from access_token t
    left join oauth_client c on c.id = t.client_id
    order by t.created_at`;
  return rows.map(toSummary);
}

export async function revokeToken(sql: Sql | Tx, id: string): Promise<boolean> {
  const rows = await sql`update access_token set revoked_at = now() where id = ${id} and revoked_at is null returning id`;
  return rows.length > 0;
}

/** Throttle last_used_at writes to once a minute per token. */
const lastTouched = new Map<string, number>();

/** Verify a bearer token (PAT or OAuth-issued). Returns null when it is unknown, expired or revoked. */
export async function authenticate(sql: Sql, token: string | undefined): Promise<AuthInfo | null> {
  if (!token || !token.startsWith('tm_')) return null;
  const rows = await sql`
    select id, label, scopes, kind, client_id, expires_at, revoked_at from access_token where token_hash = ${hashToken(token)}`;
  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at as string).getTime() < Date.now()) return null;
  const id = row.id as string;
  const now = Date.now();
  if ((lastTouched.get(id) ?? 0) < now - 60_000) {
    lastTouched.set(id, now);
    sql`update access_token set last_used_at = now() where id = ${id}`.catch(() => {});
  }
  return { tokenId: id, label: row.label as string, scopes: row.scopes as Scope[], kind: (row.kind as TokenKind) ?? 'pat', clientId: (row.client_id as string | null) ?? null };
}

export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : undefined;
}

export function hasScope(auth: AuthInfo, scope: Scope): boolean {
  return auth.scopes.includes(scope);
}
