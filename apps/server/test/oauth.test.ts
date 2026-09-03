import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestServer, type TestServer } from './helpers.js';

let s: TestServer;

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const PASSWORD = 'correct horse battery';

const form = (data: Record<string, string | string[]>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return p.toString();
};

async function post(path: string, data: Record<string, string | string[]>, headers: Record<string, string> = {}) {
  const res = await fetch(s.baseUrl + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form(data) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, headers: res.headers, body: body as never, text };
}

async function registerClient(extra: Record<string, unknown> = {}) {
  const res = await fetch(`${s.baseUrl}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', ...extra }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'read write decide', state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256', resource: `${s.baseUrl}/mcp`, ...extra }).toString();
}

/** Full consent: returns the authorization code the server redirected with. */
async function consent(clientId: string, challenge: string, scopes: string[] = ['read', 'write'], password = PASSWORD) {
  const r = await post('/oauth/authorize', { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, requested_scope: 'read write decide', scope: scopes, state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256', password, action: 'allow' });
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe('xyz');
  return loc.searchParams.get('code')!;
}

beforeAll(async () => {
  s = await startTestServer();
});
afterAll(async () => {
  await s.close();
});
beforeEach(async () => {
  await s.reset();
});

describe('OAuth metadata', () => {
  it('serves protected-resource and authorization-server metadata', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await s.api<Record<string, unknown>>('GET', path, { token: null });
      expect(r.status).toBe(200);
      expect(r.body.resource).toBe(`${s.baseUrl}/mcp`);
      expect(r.body.authorization_servers).toEqual([s.baseUrl]);
      expect(r.body.scopes_supported).toEqual(['read', 'write', 'decide']);
      expect(r.body.bearer_methods_supported).toEqual(['header']);
    }
    const as = await s.api<Record<string, unknown>>('GET', '/.well-known/oauth-authorization-server', { token: null });
    expect(as.status).toBe(200);
    expect(as.body.issuer).toBe(s.baseUrl);
    expect(as.body.authorization_endpoint).toBe(`${s.baseUrl}/oauth/authorize`);
    expect(as.body.token_endpoint).toBe(`${s.baseUrl}/oauth/token`);
    expect(as.body.registration_endpoint).toBe(`${s.baseUrl}/oauth/register`);
    expect(as.body.revocation_endpoint).toBe(`${s.baseUrl}/oauth/revoke`);
    expect(as.body.response_types_supported).toEqual(['code']);
    expect(as.body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(as.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.body.token_endpoint_auth_methods_supported).toEqual(['none', 'client_secret_post']);
  });

  it('answers 401 on /mcp with a WWW-Authenticate pointing at the resource metadata', async () => {
    const res = await fetch(`${s.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${s.baseUrl}/.well-known/oauth-protected-resource"`);
    const bad = await fetch(`${s.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tm_nope' }, body: '{}' });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('resource_metadata=');
  });
});

describe('dynamic client registration', () => {
  it('registers a public client and echoes its metadata', async () => {
    const r = await registerClient();
    expect(r.status).toBe(201);
    expect(typeof r.body.client_id).toBe('string');
    expect(r.body.client_secret).toBeUndefined();
    expect(r.body.client_name).toBe('Claude');
    expect(r.body.redirect_uris).toEqual([REDIRECT]);
    expect(r.body.token_endpoint_auth_method).toBe('none');
    expect(typeof r.body.client_id_issued_at).toBe('number');
  });
  it('issues a secret for client_secret_post clients', async () => {
    const r = await registerClient({ token_endpoint_auth_method: 'client_secret_post' });
    expect(r.status).toBe(201);
    expect(typeof r.body.client_secret).toBe('string');
  });
  it('rejects missing or non-https redirect URIs', async () => {
    expect((await registerClient({ redirect_uris: [] })).status).toBe(400);
    expect((await registerClient({ redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
    expect((await registerClient({ redirect_uris: ['http://localhost:8080/cb'] })).status).toBe(201);
    expect((await registerClient({ redirect_uris: ['http://127.0.0.1/cb'] })).status).toBe(201);
  });
});

describe('authorization code flow', () => {
  it('runs the full flow: authorize page → password → code → tokens → refresh → revoke', async () => {
    await s.setPassword(PASSWORD);
    const clientId = (await registerClient()).body.client_id as string;
    const { verifier, challenge } = pkce();

    // authorize page
    const page = await fetch(`${s.baseUrl}/oauth/authorize?${authorizeQuery(clientId, challenge)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Claude');
    expect(html).toContain('允许替我确认变更');
    expect(html).toContain('name="password"');
    expect(html).not.toContain('<script src=');
    // the consent form must round-trip the original request, including response_type
    expect(html).toContain('<input type="hidden" name="response_type" value="code">');
    // decide is offered as an opt-in even when the client only asked for read/write
    const pageRW = await (await fetch(`${s.baseUrl}/oauth/authorize?${authorizeQuery(clientId, challenge, { scope: 'read write' })}`)).text();
    expect(pageRW).toMatch(/name="scope" value="decide"(?![^>]*checked)/);

    // wrong password re-renders with an error
    const wrong = await post('/oauth/authorize', { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, requested_scope: 'read write decide', scope: ['read', 'write'], state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256', password: 'nope', action: 'allow' });
    expect(wrong.status).toBe(401);
    expect(wrong.text).toContain('密码不对');
    expect(wrong.headers.get('location')).toBeNull();

    // right password → 302 with code + state
    const code1 = await consent(clientId, challenge);

    // wrong verifier → invalid_grant (and burns the code)
    const bad = await post('/oauth/token', { grant_type: 'authorization_code', code: code1, redirect_uri: REDIRECT, client_id: clientId, code_verifier: 'not-the-verifier' });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toBe('invalid_grant');
    const reused = await post('/oauth/token', { grant_type: 'authorization_code', code: code1, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    expect((reused.body as { error: string }).error).toBe('invalid_grant');

    // fresh code, right verifier → tokens
    const code2 = await consent(clientId, challenge);
    const ok = await post('/oauth/token', { grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    expect(ok.status).toBe(200);
    const tokens = ok.body as { access_token: string; token_type: string; expires_in: number; refresh_token: string; scope: string };
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe('read write');
    expect(tokens.access_token.startsWith('tm_')).toBe(true);

    // access token works on the REST API ...
    const me = await s.api<{ scopes: string[]; tokenKind: string }>('GET', '/api/me', { token: tokens.access_token });
    expect(me.status).toBe(200);
    expect(me.body.scopes).toEqual(['read', 'write']);
    expect(me.body.tokenKind).toBe('oauth');
    // ... and on /mcp through the official client
    const client = new Client({ name: 'oauth-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('list_projects');
    await client.close();

    // token list shows both kinds with the client name
    const list = await s.api<{ kind: string; clientName: string | null; label: string }[]>('GET', '/api/tokens', { token: tokens.access_token });
    expect(list.body.find((t) => t.kind === 'oauth')?.clientName).toBe('Claude');
    expect(JSON.stringify(list.body)).not.toContain(tokens.access_token);

    // refresh rotates: old refresh token dies, old access token dies
    const refreshed = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(refreshed.status).toBe(200);
    const t2 = refreshed.body as typeof tokens;
    expect(t2.access_token).not.toBe(tokens.access_token);
    expect(t2.refresh_token).not.toBe(tokens.refresh_token);
    expect(t2.scope).toBe('read write');
    expect((await s.api('GET', '/api/me', { token: t2.access_token })).status).toBe(200);
    expect((await s.api('GET', '/api/me', { token: tokens.access_token })).status).toBe(401);
    const replay = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(replay.status).toBe(400);
    expect((replay.body as { error: string }).error).toBe('invalid_grant');

    // revoke → 401
    const rev = await post('/oauth/revoke', { token: t2.access_token, client_id: clientId });
    expect(rev.status).toBe(200);
    expect((await s.api('GET', '/api/me', { token: t2.access_token })).status).toBe(401);
    const afterRevoke = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: clientId });
    expect(afterRevoke.status).toBe(400);
  });

  it('grants decide only when the owner ticks it', async () => {
    await s.setPassword(PASSWORD);
    const clientId = (await registerClient()).body.client_id as string;
    const { verifier, challenge } = pkce();
    const code = await consent(clientId, challenge, ['read', 'write', 'decide']);
    const ok = await post('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    expect((ok.body as { scope: string }).scope).toBe('read write decide');
    const me = await s.api<{ scopes: string[] }>('GET', '/api/me', { token: (ok.body as { access_token: string }).access_token });
    expect(me.body.scopes).toEqual(['read', 'write', 'decide']);
  });

  it('redirects with access_denied when the owner refuses', async () => {
    await s.setPassword(PASSWORD);
    const clientId = (await registerClient()).body.client_id as string;
    const { challenge } = pkce();
    const r = await post('/oauth/authorize', { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'st', code_challenge: challenge, code_challenge_method: 'S256', action: 'deny' });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st');
  });

  it('refuses when no owner password is set', async () => {
    const clientId = (await registerClient()).body.client_id as string;
    const { challenge } = pkce();
    const page = await fetch(`${s.baseUrl}/oauth/authorize?${authorizeQuery(clientId, challenge)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('还没有设置密码');
    expect(html).not.toContain('name="password"');
    const r = await post('/oauth/authorize', { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', password: 'x', action: 'allow', scope: ['read'] });
    expect(r.status).toBe(200);
    expect(r.headers.get('location')).toBeNull();
  });

  it('rejects unknown clients and mismatched redirect URIs without redirecting', async () => {
    const { challenge } = pkce();
    const unknown = await fetch(`${s.baseUrl}/oauth/authorize?${authorizeQuery('00000000-0000-0000-0000-000000000000', challenge)}`);
    expect(unknown.status).toBe(400);
    const clientId = (await registerClient()).body.client_id as string;
    const mismatch = await fetch(`${s.baseUrl}/oauth/authorize?${authorizeQuery(clientId, challenge, { redirect_uri: 'https://claude.ai/other' })}`, { redirect: 'manual' });
    expect(mismatch.status).toBe(400);
    const noPkce = await fetch(`${s.baseUrl}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's' })}`, { redirect: 'manual' });
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('checks client secrets and code ownership at the token endpoint', async () => {
    await s.setPassword(PASSWORD);
    const confidential = (await registerClient({ token_endpoint_auth_method: 'client_secret_post' })).body as { client_id: string; client_secret: string };
    const other = (await registerClient()).body.client_id as string;
    const { verifier, challenge } = pkce();
    const code = await consent(confidential.client_id, challenge);
    const noSecret = await post('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: confidential.client_id, code_verifier: verifier });
    expect(noSecret.status).toBe(401);
    expect((noSecret.body as { error: string }).error).toBe('invalid_client');
    const wrongClient = await post('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: other, code_verifier: verifier });
    expect((wrongClient.body as { error: string }).error).toBe('invalid_grant');
    const code2 = await consent(confidential.client_id, challenge);
    const ok = await post('/oauth/token', { grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: confidential.client_id, client_secret: confidential.client_secret, code_verifier: verifier });
    expect(ok.status).toBe(200);
    const unsupported = await post('/oauth/token', { grant_type: 'password', client_id: other });
    expect(unsupported.status).toBe(400);
    expect((unsupported.body as { error: string }).error).toBe('unsupported_grant_type');
  });
});
