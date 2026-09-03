import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createDb, type Sql } from '../src/db.js';
import { ensureAccount, migrate } from '../src/migrate.js';
import { Hub } from '../src/realtime.js';
import { buildApp } from '../src/app.js';
import { createToken, setOwnerPassword, type Scope } from '../src/auth.js';
import type { Ctx } from '../src/service/context.js';
import { capturingTransport, createPushSender } from '../src/push.js';
import type { ExpoPushMessage } from 'expo-server-sdk';

export const TEST_DB_URL = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/tsaimind_test';

export interface TestServer {
  app: FastifyInstance;
  ctx: Ctx;
  sql: Sql;
  baseUrl: string;
  /** Wipe all data and recreate the account row. */
  reset(): Promise<void>;
  token(scopes?: Scope[]): Promise<string>;
  /** Set the owner password used by the OAuth authorize page. */
  setPassword(password: string): Promise<void>;
  /** Pushes captured by the injected transport (cleared by reset()). */
  pushes: ExpoPushMessage[];
  /** JSON request helper with bearer auth. */
  api<T = unknown>(method: string, path: string, opts?: { body?: unknown; token?: string | null; raw?: boolean }): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const config = { ...loadConfig(), databaseUrl: TEST_DB_URL, port: 0, host: '127.0.0.1', tzName: 'Asia/Taipei' };
  const sql = createDb(config.databaseUrl);
  await migrate(sql);
  const capture = capturingTransport();
  const ctx: Ctx = { sql, hub: new Hub(), config, log: { info: () => {}, warn: () => {}, error: () => {} }, push: createPushSender({ transport: capture.transport, log: { info: () => {}, warn: () => {}, error: () => {} } }) };
  const app = await buildApp(ctx, { logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  ctx.config.publicUrl = baseUrl;

  const reset = async () => {
    await sql`truncate table activity, op, change, note, dependency, plan_batch, notification, device, node, project, contact, access_token, oauth_refresh_token, oauth_code, oauth_client, account restart identity cascade`;
    await ensureAccount(sql, config.accountEmail, config.accountName, config.tzName);
    capture.reset();
  };
  let defaultToken: string | null = null;
  const token = async (scopes: Scope[] = ['read', 'write', 'decide']) => (await createToken(sql, { label: 'test', scopes })).token;
  const api: TestServer['api'] = async (method, path, opts = {}) => {
    if (opts.token === undefined && !defaultToken) defaultToken = await token();
    const t = opts.token === undefined ? defaultToken : opts.token;
    const res = await fetch(baseUrl + path, {
      method,
      headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    if (!opts.raw) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body: body as never };
  };
  return {
    app, ctx, sql, baseUrl, reset, token, api,
    setPassword: (password: string) => setOwnerPassword(sql, password),
    pushes: capture.messages,
    close: async () => {
      await app.close();
      await sql.end();
    },
    // reset the cached default token after each reset()
    ...({} as object),
  } as TestServer & { _t?: never };
}

/** Helper to build a client op. */
export function op<T extends Record<string, unknown>>(projectId: string, fields: T, actor: 'user' | 'claude' = 'user') {
  return { opId: crypto.randomUUID(), clientId: 'test', projectId, actor, at: new Date().toISOString(), ...fields };
}

export const SAMPLE_OUTLINE = `- 设计 9/1–9/12 done
  - 视觉稿 9/1–9/8 done
- 开发 9/8–9/30 in_progress
  - 前端页面 9/8–9/24 60%
  - 接口联调 9/15–9/30 blocked 10%
- ◆ 上线 10/10`;
