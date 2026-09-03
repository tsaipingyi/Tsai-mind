import { createDb } from './db.js';
import { loadConfig } from './config.js';
import { createToken, listTokens, revokeToken, type Scope } from './auth.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const usage = `usage:
  token:create --label "Claude Code" [--scopes read,write,decide] [--expires 2027-01-01]
  token:list
  token:revoke <id>`;

async function main() {
  const cmd = process.argv[2];
  const config = loadConfig();
  const sql = createDb(config.databaseUrl);
  try {
    switch (cmd) {
      case 'token:create': {
        const label = arg('--label');
        if (!label) throw new Error('--label is required');
        const scopes = (arg('--scopes') ?? 'read,write').split(',').map((s) => s.trim()).filter(Boolean) as Scope[];
        const expiresAt = arg('--expires') ?? null;
        const { token, summary } = await createToken(sql, { label, scopes, expiresAt });
        console.log(`Token created (id ${summary.id}, scopes ${summary.scopes.join(',')}). Shown once, store it now:\n\n  ${token}\n`);
        break;
      }
      case 'token:list': {
        const tokens = await listTokens(sql);
        if (tokens.length === 0) console.log('no tokens');
        for (const t of tokens) {
          const state = t.revokedAt ? 'revoked' : t.expiresAt && t.expiresAt < new Date().toISOString() ? 'expired' : 'active';
          console.log(`${t.id}  ${state.padEnd(8)}  ${t.scopes.join(',').padEnd(18)}  last used ${t.lastUsedAt ?? 'never'}  ${t.label}`);
        }
        break;
      }
      case 'token:revoke': {
        const id = process.argv[3];
        if (!id) throw new Error('token id is required');
        console.log((await revokeToken(sql, id)) ? `revoked ${id}` : `no active token with id ${id}`);
        break;
      }
      default:
        console.log(usage);
        process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
