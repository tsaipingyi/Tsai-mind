import { createDb } from './db.js';
import { loadConfig } from './config.js';
import { createInterface } from 'node:readline/promises';
import { createToken, listTokens, revokeToken, setOwnerPassword, type Scope } from './auth.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const usage = `usage:
  token:create --label "Claude Code" [--scopes read,write,decide] [--expires 2027-01-01]
  token:list
  token:revoke <id>
  password:set [--password <pw>]     owner password for the OAuth authorize page (prompts when omitted)`;

/** Read a line from the terminal without echoing it. */
async function promptHidden(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const mutable = rl as unknown as { _writeToOutput: (s: string) => void };
  process.stdout.write(label);
  mutable._writeToOutput = () => {};
  try {
    const v = await rl.question('');
    process.stdout.write('\n');
    return v;
  } finally {
    rl.close();
  }
}

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
      case 'password:set': {
        let password = arg('--password');
        if (!password) {
          password = await promptHidden('New password: ');
          const again = await promptHidden('Repeat: ');
          if (password !== again) throw new Error('passwords do not match');
        }
        await setOwnerPassword(sql, password);
        console.log('owner password set');
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
