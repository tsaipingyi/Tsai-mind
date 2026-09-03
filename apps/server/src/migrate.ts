import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './db.js';
import { createDb } from './db.js';
import { loadConfig } from './config.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Apply every migrations/*.sql file that is not yet recorded in schema_migrations. Returns the applied names. */
export async function migrate(sql: Sql, log: (msg: string) => void = () => {}): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await sql`select name from schema_migrations`).map((r) => r.name as string));
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    log(`applied migration ${file}`);
    applied.push(file);
  }
  return applied;
}

/** Ensure the single account row exists. */
export async function ensureAccount(sql: Sql, email: string, name: string, timezone: string): Promise<void> {
  const rows = await sql`select id from account limit 1`;
  if (rows.length === 0) {
    await sql`insert into account (email, name, timezone) values (${email}, ${name}, ${timezone})`;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const config = loadConfig();
  const sql = createDb(config.databaseUrl);
  try {
    const applied = await migrate(sql, console.log);
    await ensureAccount(sql, config.accountEmail, config.accountName, config.tzName);
    console.log(applied.length ? `done (${applied.length} applied)` : 'nothing to apply');
  } finally {
    await sql.end();
  }
}
