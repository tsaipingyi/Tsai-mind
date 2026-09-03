import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { ensureAccount, migrate } from './migrate.js';
import { Hub } from './realtime.js';
import { buildApp } from './app.js';
import type { Ctx } from './service/context.js';
import { createPushSender, expoTransport } from './push.js';
import { startScheduler } from './scheduler.js';

const config = loadConfig();
const sql = createDb(config.databaseUrl);
const push = createPushSender({ transport: expoTransport({ accessToken: config.expoAccessToken }), log: console });
const ctx: Ctx = { sql, hub: new Hub(), config, log: console, push };

await migrate(sql, (m) => console.log(m));
await ensureAccount(sql, config.accountEmail, config.accountName, config.tzName);

const app = await buildApp(ctx, { logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.listen({ port: config.port, host: config.host });
app.log.info(`Tsai Mind server on http://${config.host}:${config.port} (MCP at /mcp, OAuth at /oauth/*, timezone ${config.tzName})`);
const scheduler = config.scheduler ? startScheduler(ctx) : null;

const shutdown = async () => {
  app.log.info('shutting down');
  scheduler?.stop();
  await app.close();
  await sql.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
