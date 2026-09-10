import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudConfig } from './vite.cloud.config';

/**
 * Normal dev/build config. On Vercel (`VERCEL=1`, set by its build environment) the framework
 * preset runs a bare `vite build`, so this file switches to the cloud (single-file, browser-local
 * persistence) build, builds @tsai-mind/core first if its dist is missing, and copies the output to
 * the repository root as well — whichever Root Directory / Output Directory the project uses,
 * a `dist-cloud` folder exists afterwards.
 */
// Vercel exposes VERCEL/VERCEL_ENV only when "system environment variables" are enabled; CI is
// always set there. TSAI_MIND_CLOUD=1 forces the cloud build anywhere; TSAI_MIND_LOCAL_BUILD=1 forces
// the normal one.
const env = process.env;
const onVercel = !env.TSAI_MIND_LOCAL_BUILD && !!(env.TSAI_MIND_CLOUD || env.VERCEL || env.VERCEL_ENV || env.VERCEL_URL || env.NOW_BUILDER || env.CI);

function ensureCoreBuilt(): void {
  const dist = resolve(__dirname, '../../packages/core/dist/index.js');
  if (existsSync(dist)) return;
  execSync('pnpm --filter @tsai-mind/core build', { cwd: resolve(__dirname, '../..'), stdio: 'inherit' });
}

function copyToRepoRoot(): Plugin {
  return {
    name: 'tsai-mind-copy-dist-cloud',
    closeBundle() {
      const from = resolve(__dirname, 'dist-cloud');
      if (!existsSync(from)) return;
      // leave the same bundle everywhere Vercel might look: apps/web/dist, apps/web/dist-cloud, <repo>/dist-cloud
      for (const to of [resolve(__dirname, '../../dist-cloud'), resolve(__dirname, 'dist')]) {
        rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true });
      }
      console.log('[tsai-mind] Vercel build: cloud bundle written to dist, dist-cloud and <repo>/dist-cloud');
    },
  };
}

const local: UserConfig = {
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/realtime': { target: 'ws://127.0.0.1:3000', ws: true },
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: { sourcemap: true },
};

if (onVercel) {
  console.log('[tsai-mind] VERCEL detected: building the cloud bundle');
  ensureCoreBuilt();
}

export default defineConfig(onVercel ? { ...cloudConfig, plugins: [...(cloudConfig.plugins ?? []), copyToRepoRoot()] } : local);
