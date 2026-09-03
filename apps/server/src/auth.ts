import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from './db.js';

export type Scope = 'read' | 'write' | 'decide';
export const ALL_SCOPES: readonly Scope[] = ['read', 'write', 'decide'];

export interface AuthInfo {
  tokenId: string;
  label: string;
  scopes: Scope[];
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return `tm_${randomBytes(32).toString('base64url')}`;
}

export interface TokenSummary {
  id: string;
  label: string;
  scopes: string[];
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
    insert into access_token (token_hash, label, scopes, expires_at)
    values (${hashToken(token)}, ${opts.label}, ${sql.array(scopes, 1009)}, ${opts.expiresAt ?? null})
    returning *`;
  return { token, summary: toSummary(rows[0]!) };
}

export async function listTokens(sql: Sql): Promise<TokenSummary[]> {
  const rows = await sql`select * from access_token order by created_at`;
  return rows.map(toSummary);
}

export async function revokeToken(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`update access_token set revoked_at = now() where id = ${id} and revoked_at is null returning id`;
  return rows.length > 0;
}

/** Throttle last_used_at writes to once a minute per token. */
const lastTouched = new Map<string, number>();

/** Verify a bearer token. Returns null when it is unknown, expired or revoked. */
export async function authenticate(sql: Sql, token: string | undefined): Promise<AuthInfo | null> {
  if (!token || !token.startsWith('tm_')) return null;
  const rows = await sql`
    select id, label, scopes, expires_at, revoked_at from access_token where token_hash = ${hashToken(token)}`;
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
  return { tokenId: id, label: row.label as string, scopes: row.scopes as Scope[] };
}

export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : undefined;
}

export function hasScope(auth: AuthInfo, scope: Scope): boolean {
  return auth.scopes.includes(scope);
}
