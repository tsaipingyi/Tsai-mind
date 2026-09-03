/**
 * Minimal single-user OAuth 2.1 authorization server so claude.ai / Claude iOS custom connectors
 * can add the MCP endpoint: RFC 8414 + RFC 9728 metadata, RFC 7591 dynamic client registration,
 * authorization code + PKCE (S256), refresh token rotation, RFC 7009 revocation.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ALL_SCOPES,
  createOAuthAccessToken,
  hashPassword,
  hashToken,
  ownerPasswordHash,
  parseScopes,
  revokeToken,
  verifyPassword,
  type Scope,
} from './auth.js';
import type { Ctx } from './service/context.js';

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const REGISTRATIONS_PER_HOUR = 20;

export const OAUTH_SCOPES: readonly Scope[] = ALL_SCOPES;

export class OAuthError extends Error {
  constructor(
    public status: number,
    public code: string,
    description: string,
  ) {
    super(description);
  }
}

const invalidRequest = (d: string) => new OAuthError(400, 'invalid_request', d);
const invalidClient = (d: string) => new OAuthError(401, 'invalid_client', d);
const invalidGrant = (d: string) => new OAuthError(400, 'invalid_grant', d);

// ---------- helpers ----------

type Params = Record<string, string | string[] | undefined>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

/** Parse application/x-www-form-urlencoded into an object; repeated keys become arrays. */
export function parseForm(body: string): Params {
  const out: Params = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const cur = out[k];
    if (cur === undefined) out[k] = v;
    else if (Array.isArray(cur)) cur.push(v);
    else out[k] = [cur, v];
  }
  return out;
}

function isAllowedRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  return false;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function withParams(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** In-memory sliding-window limiter for registrations (per IP). */
const registrations = new Map<string, number[]>();
function allowRegistration(ip: string, now = Date.now()): boolean {
  const cutoff = now - 60 * 60 * 1000;
  const hits = (registrations.get(ip) ?? []).filter((t) => t > cutoff);
  if (hits.length >= REGISTRATIONS_PER_HOUR) {
    registrations.set(ip, hits);
    return false;
  }
  hits.push(now);
  registrations.set(ip, hits);
  return true;
}

interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  secretHash: string | null;
  tokenEndpointAuthMethod: string;
  grantTypes: string[];
  createdAt: string;
}

function rowToClient(r: Record<string, unknown>): OAuthClient {
  return {
    id: r.id as string,
    name: r.name as string,
    redirectUris: r.redirect_uris as string[],
    secretHash: (r.secret_hash as string | null) ?? null,
    tokenEndpointAuthMethod: r.token_endpoint_auth_method as string,
    grantTypes: r.grant_types as string[],
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

async function loadClient(ctx: Ctx, id: string | undefined): Promise<OAuthClient | null> {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await ctx.sql`select * from oauth_client where id = ${id}`;
  return rows[0] ? rowToClient(rows[0]) : null;
}

const SCOPE_LABELS: Record<Scope, string> = {
  read: '读取项目、节点、联系人和今天视图',
  write: '新建和修改节点、草案、备注（关键字段仍需你确认）',
  decide: '允许替我确认变更',
};

// ---------- authorize page ----------

interface PageInput {
  clientName: string;
  requestedScopes: Scope[];
  params: { response_type: 'code'; client_id: string; redirect_uri: string; state?: string; code_challenge: string; code_challenge_method: string; resource?: string; requested_scope: string };
  error?: string;
  noPassword?: boolean;
}

export function renderAuthorizePage(p: PageInput): string {
  const h = escapeHtml;
  const hidden = Object.entries(p.params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${h(k)}" value="${h(v!)}">`)
    .join('\n');
  const scopeRows = p.requestedScopes
    .map(
      (s) => `
      <label class="scope">
        <input type="checkbox" name="scope" value="${s}" ${s === 'decide' ? '' : 'checked'}>
        <span><b>${s}</b><small>${h(SCOPE_LABELS[s])}</small></span>
      </label>`,
    )
    .join('');
  const body = p.noPassword
    ? `<p class="error">还没有设置密码。请先在服务器上运行 <code>pnpm --filter @tsai-mind/server password:set</code>，再重新授权。</p>`
    : `
    ${p.error ? `<p class="error">${h(p.error)}</p>` : ''}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <fieldset>
        <legend>允许它做什么</legend>
        ${scopeRows}
      </fieldset>
      <label class="field">密码
        <input type="password" name="password" autocomplete="current-password" required autofocus>
      </label>
      <div class="actions">
        <button type="submit" name="action" value="deny" class="secondary">拒绝</button>
        <button type="submit" name="action" value="allow" class="primary">允许</button>
      </div>
    </form>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>授权 · Tsai Mind</title>
<style>
  :root { --paper:#FFFFFF; --paper-2:#FAFAFA; --ink:#1C1C1C; --ink-2:#6B6B6B; --line:#E5E5E5; --orange:#F26B1D; --orange-deep:#D4550C; --orange-soft:#FFF1E8; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family:"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif; font-size:15px; line-height:1.5; }
  main { max-width:420px; margin:48px auto; padding:0 20px; }
  .card { border:2px solid var(--orange); border-radius:12px; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:var(--ink-2); margin:0 0 20px; }
  .client { font-weight:600; }
  fieldset { border:1px solid var(--line); border-radius:8px; padding:8px 12px; margin:0 0 16px; }
  legend { color:var(--ink-2); font-size:13px; padding:0 4px; }
  .scope { display:flex; gap:10px; align-items:flex-start; padding:8px 0; border-top:1px solid var(--line); }
  .scope:first-of-type { border-top:0; }
  .scope input { margin-top:4px; accent-color:var(--orange); }
  .scope b { display:block; font-weight:600; }
  .scope small { color:var(--ink-2); }
  .field { display:block; margin:0 0 20px; color:var(--ink-2); font-size:13px; }
  .field input { display:block; width:100%; margin-top:6px; padding:10px 12px; font-size:15px; border:1px solid var(--line); border-radius:8px; color:var(--ink); background:var(--paper); }
  .field input:focus { outline:none; border-color:var(--orange); box-shadow:0 0 0 3px var(--orange-soft); }
  .actions { display:flex; gap:10px; justify-content:flex-end; }
  button { font:inherit; padding:10px 18px; border-radius:8px; cursor:pointer; }
  .primary { background:var(--orange); border:1px solid var(--orange); color:#fff; font-weight:600; }
  .primary:hover { background:var(--orange-deep); border-color:var(--orange-deep); }
  .secondary { background:var(--paper); border:1px solid var(--line); color:var(--ink); }
  .error { background:var(--orange-soft); border:1px solid var(--orange); border-radius:8px; padding:10px 12px; color:var(--orange-deep); }
  code { background:var(--paper-2); padding:1px 4px; border-radius:4px; }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Tsai Mind 授权</h1>
    <p class="sub"><span class="client">${h(p.clientName)}</span> 想要访问你的 Tsai Mind。</p>
    ${body}
  </div>
</main>
</body>
</html>`;
}

// ---------- routes ----------

export function registerOAuth(app: FastifyInstance, ctx: Ctx): void {
  const issuer = () => ctx.config.publicUrl.replace(/\/+$/, '');

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, parseForm(String(body)));
    } catch (err) {
      done(err as Error);
    }
  });

  const oauthErrorHandler = (err: unknown, _request: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof OAuthError) {
      if (err.code === 'invalid_client') reply.header('WWW-Authenticate', 'Basic realm="tsai-mind"');
      return reply.status(err.status).header('cache-control', 'no-store').send({ error: err.code, error_description: err.message });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: 'invalid_request', error_description: e.message ?? 'bad request' });
    ctx.log.error(err, 'oauth error');
    return reply.status(500).send({ error: 'server_error', error_description: 'internal error' });
  };

  // ----- metadata -----
  const protectedResource = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.header('cache-control', 'no-store').send({
      resource: `${issuer()}/mcp`,
      authorization_servers: [issuer()],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ['header'],
    });
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: issuer(),
    authorization_endpoint: `${issuer()}/oauth/authorize`,
    token_endpoint: `${issuer()}/oauth/token`,
    registration_endpoint: `${issuer()}/oauth/register`,
    revocation_endpoint: `${issuer()}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: [...OAUTH_SCOPES],
  }));

  // ----- RFC 7591 dynamic client registration -----
  app.post('/oauth/register', { errorHandler: oauthErrorHandler }, async (request, reply) => {
    if (!allowRegistration(request.ip)) throw new OAuthError(429, 'too_many_requests', 'registration rate limit exceeded (20/hour)');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const redirectUris = list(body.redirect_uris);
    if (redirectUris.length === 0) throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris is required');
    for (const uri of redirectUris) if (!isAllowedRedirect(uri)) throw new OAuthError(400, 'invalid_redirect_uri', `redirect_uri not allowed: ${uri} (https, or http://localhost)`);
    const grantTypes = list(body.grant_types);
    const grants = grantTypes.length ? grantTypes : ['authorization_code', 'refresh_token'];
    for (const g of grants) if (g !== 'authorization_code' && g !== 'refresh_token') throw new OAuthError(400, 'invalid_client_metadata', `unsupported grant_type: ${g}`);
    const authMethod = str(body.token_endpoint_auth_method) ?? 'none';
    if (authMethod !== 'none' && authMethod !== 'client_secret_post') throw new OAuthError(400, 'invalid_client_metadata', `unsupported token_endpoint_auth_method: ${authMethod}`);
    const name = (str(body.client_name) ?? '').trim().slice(0, 200) || '未命名客户端';

    const secret = authMethod === 'client_secret_post' ? randomBytes(32).toString('base64url') : null;
    const secretHash = secret ? await hashPassword(secret) : null;
    const rows = await ctx.sql`
      insert into oauth_client (name, redirect_uris, secret_hash, token_endpoint_auth_method, grant_types)
      values (${name}, ${ctx.sql.array(redirectUris, 1009)}, ${secretHash}, ${authMethod}, ${ctx.sql.array(grants, 1009)})
      returning *`;
    const client = rowToClient(rows[0]!);
    return reply.status(201).header('cache-control', 'no-store').send({
      client_id: client.id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      scope: OAUTH_SCOPES.join(' '),
    });
  });

  // ----- authorization endpoint -----
  interface AuthorizeParams {
    client: OAuthClient;
    redirectUri: string;
    state: string | undefined;
    codeChallenge: string;
    resource: string | undefined;
    scopes: Scope[];
  }

  /** Validate the request; the client + redirect_uri are checked before anything is sent to the redirect. */
  async function validateAuthorize(q: Params, reply: FastifyReply): Promise<AuthorizeParams | null> {
    const client = await loadClient(ctx, str(q.client_id));
    if (!client) {
      await reply.status(400).type('text/html; charset=utf-8').send(errorPage('未知的 client_id。请让客户端先完成注册。'));
      return null;
    }
    const redirectUri = str(q.redirect_uri);
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      await reply.status(400).type('text/html; charset=utf-8').send(errorPage('redirect_uri 与注册时的不一致。'));
      return null;
    }
    const state = str(q.state);
    const fail = async (error: string, description: string) => {
      await reply.redirect(withParams(redirectUri, { error, error_description: description, state }), 302);
      return null;
    };
    if (str(q.response_type) !== 'code') return fail('unsupported_response_type', 'response_type must be code');
    const codeChallenge = str(q.code_challenge);
    if (!codeChallenge) return fail('invalid_request', 'code_challenge is required (PKCE)');
    if ((str(q.code_challenge_method) ?? 'S256') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
    // GET carries the request in `scope`; the consent POST carries it in `requested_scope` (the checkboxes are `scope`).
    const requested = str(q.requested_scope) ?? list(q.scope).join(' ');
    let scopes: Scope[];
    try {
      scopes = parseScopes(requested, ['read', 'write']);
    } catch (err) {
      return fail('invalid_scope', (err as Error).message);
    }
    return { client, redirectUri, state, codeChallenge, resource: str(q.resource), scopes };
  }

  const errorPage = (msg: string) =>
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权失败 · Tsai Mind</title><style>body{font-family:"Noto Sans SC",system-ui,sans-serif;background:#fff;color:#1C1C1C;padding:48px 20px;max-width:420px;margin:0 auto}.error{background:#FFF1E8;border:1px solid #F26B1D;border-radius:8px;padding:12px;color:#D4550C}</style></head><body><h1>授权失败</h1><p class="error">${escapeHtml(msg)}</p></body></html>`;

  /** Scopes shown on the consent page: what the client asked for, plus `decide` as an opt-in the owner can tick. */
  const offeredScopes = (requested: Scope[]): Scope[] => (['read', 'write', 'decide'] as Scope[]).filter((s) => requested.includes(s) || s === 'decide');

  const pageParams = (p: AuthorizeParams) => ({
    response_type: 'code' as const,
    client_id: p.client.id, redirect_uri: p.redirectUri, state: p.state, code_challenge: p.codeChallenge, code_challenge_method: 'S256', resource: p.resource, requested_scope: p.scopes.join(' '),
  });

  app.get('/oauth/authorize', async (request, reply) => {
    const p = await validateAuthorize(request.query as Params, reply);
    if (!p) return reply;
    const noPassword = !(await ownerPasswordHash(ctx.sql));
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(renderAuthorizePage({ clientName: p.client.name, requestedScopes: offeredScopes(p.scopes), params: pageParams(p), noPassword }));
  });

  app.post('/oauth/authorize', async (request, reply) => {
    const body = (request.body ?? {}) as Params;
    const p = await validateAuthorize(body, reply);
    if (!p) return reply;
    const render = (error?: string, noPassword?: boolean) =>
      reply.status(error ? 401 : 200).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(renderAuthorizePage({ clientName: p.client.name, requestedScopes: offeredScopes(p.scopes), params: pageParams(p), error, noPassword }));

    if (str(body.action) === 'deny') return reply.redirect(withParams(p.redirectUri, { error: 'access_denied', error_description: 'the owner denied the request', state: p.state }), 302);

    const stored = await ownerPasswordHash(ctx.sql);
    if (!stored) return render(undefined, true);
    const password = str(body.password) ?? '';
    if (!(await verifyPassword(password, stored))) {
      ctx.log.warn({ ip: request.ip, client: p.client.id }, 'oauth: wrong password');
      return render('密码不对，请再试一次。');
    }
    const granted = offeredScopes(p.scopes).filter((s) => list(body.scope).includes(s));
    if (granted.length === 0) return render('至少要勾选一项权限。');

    const code = randomBytes(32).toString('base64url');
    await ctx.sql`
      insert into oauth_code (code_hash, client_id, redirect_uri, scopes, code_challenge, code_challenge_method, resource, expires_at)
      values (${hashToken(code)}, ${p.client.id}, ${p.redirectUri}, ${ctx.sql.array(granted, 1009)}, ${p.codeChallenge}, 'S256', ${p.resource ?? null}, ${new Date(Date.now() + CODE_TTL_MS).toISOString()})`;
    ctx.log.info({ client: p.client.id, scopes: granted }, 'oauth: code issued');
    return reply.redirect(withParams(p.redirectUri, { code, state: p.state }), 302);
  });

  // ----- token endpoint -----
  async function authenticateClient(request: FastifyRequest, body: Params): Promise<OAuthClient> {
    let clientId = str(body.client_id);
    let secret = str(body.client_secret);
    const basic = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? '');
    if (basic) {
      const [id, sec] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':');
      clientId = id ? decodeURIComponent(id) : clientId;
      secret = sec ? decodeURIComponent(sec) : secret;
    }
    const client = await loadClient(ctx, clientId);
    if (!client) throw invalidClient('unknown client');
    if (client.secretHash) {
      if (!secret || !(await verifyPassword(secret, client.secretHash))) throw invalidClient('bad client credentials');
    }
    return client;
  }

  async function issueTokens(client: OAuthClient, scopes: Scope[]) {
    const accessExp = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
    const refreshExp = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    const refresh = generateRefreshToken();
    const access = await ctx.sql.begin(async (tx) => {
      const a = await createOAuthAccessToken(tx, { clientId: client.id, label: client.name, scopes, expiresAt: accessExp });
      await tx`
        insert into oauth_refresh_token (token_hash, client_id, access_token_id, scopes, expires_at)
        values (${hashToken(refresh)}, ${client.id}, ${a.id}, ${tx.array(scopes, 1009)}, ${refreshExp.toISOString()})`;
      return a;
    });
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  app.post('/oauth/token', { errorHandler: oauthErrorHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Params;
    const grant = str(body.grant_type);
    reply.header('cache-control', 'no-store').header('pragma', 'no-cache');

    if (grant === 'authorization_code') {
      const client = await authenticateClient(request, body);
      if (!client.grantTypes.includes('authorization_code')) throw new OAuthError(400, 'unauthorized_client', 'client may not use authorization_code');
      const code = str(body.code);
      const verifier = str(body.code_verifier);
      const redirectUri = str(body.redirect_uri);
      if (!code) throw invalidRequest('code is required');
      if (!verifier) throw invalidRequest('code_verifier is required');
      const rows = await ctx.sql`
        update oauth_code set used_at = now()
        where code_hash = ${hashToken(code)} and used_at is null
        returning *`;
      const row = rows[0];
      if (!row) throw invalidGrant('unknown or already used code');
      if (row.client_id !== client.id) throw invalidGrant('code was issued to another client');
      if (new Date(row.expires_at as string).getTime() < Date.now()) throw invalidGrant('code expired');
      if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw invalidGrant('redirect_uri mismatch');
      if (s256(verifier) !== row.code_challenge) throw invalidGrant('PKCE verification failed');
      const scopes = row.scopes as Scope[];
      ctx.log.info({ client: client.id, scopes }, 'oauth: tokens issued');
      return issueTokens(client, scopes);
    }

    if (grant === 'refresh_token') {
      const client = await authenticateClient(request, body);
      if (!client.grantTypes.includes('refresh_token')) throw new OAuthError(400, 'unauthorized_client', 'client may not use refresh_token');
      const refresh = str(body.refresh_token);
      if (!refresh) throw invalidRequest('refresh_token is required');
      const rows = await ctx.sql`
        update oauth_refresh_token set revoked_at = now()
        where token_hash = ${hashToken(refresh)} and revoked_at is null
        returning *`;
      const row = rows[0];
      if (!row) throw invalidGrant('unknown, revoked or already rotated refresh token');
      if (row.client_id !== client.id) throw invalidGrant('refresh token belongs to another client');
      if (new Date(row.expires_at as string).getTime() < Date.now()) throw invalidGrant('refresh token expired');
      const granted = row.scopes as Scope[];
      let scopes = granted;
      const requested = str(body.scope);
      if (requested) {
        try {
          scopes = parseScopes(requested, granted);
        } catch (err) {
          throw new OAuthError(400, 'invalid_scope', (err as Error).message);
        }
        if (scopes.some((s) => !granted.includes(s))) throw new OAuthError(400, 'invalid_scope', 'scope exceeds the original grant');
      }
      if (row.access_token_id) await revokeToken(ctx.sql, row.access_token_id as string);
      return issueTokens(client, scopes);
    }

    throw new OAuthError(400, 'unsupported_grant_type', `unsupported grant_type: ${grant ?? '(none)'}`);
  });

  // ----- RFC 7009 revocation -----
  app.post('/oauth/revoke', { errorHandler: oauthErrorHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Params;
    const token = str(body.token);
    if (!token) throw invalidRequest('token is required');
    const hash = hashToken(token);
    // Client authentication is optional for public clients; when credentials are given they must be valid.
    if (str(body.client_id) || request.headers.authorization) await authenticateClient(request, body);
    await ctx.sql.begin(async (tx) => {
      const refresh = await tx`update oauth_refresh_token set revoked_at = now() where token_hash = ${hash} and revoked_at is null returning access_token_id`;
      for (const r of refresh) if (r.access_token_id) await revokeToken(tx, r.access_token_id as string);
      const access = await tx`update access_token set revoked_at = now() where token_hash = ${hash} and kind = 'oauth' and revoked_at is null returning id`;
      for (const a of access) await tx`update oauth_refresh_token set revoked_at = now() where access_token_id = ${a.id as string} and revoked_at is null`;
    });
    return reply.status(200).header('cache-control', 'no-store').send({});
  });
}

function generateRefreshToken(): string {
  return `tmr_${randomBytes(32).toString('base64url')}`;
}
