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
const onVercel = !!process.env.VERCEL;

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
      const to = resolve(__dirname, '../../dist-cloud');
      if (!existsSync(from)) return;
      rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { recursive: true });
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

if (onVercel) ensureCoreBuilt();

export default defineConfig(onVercel ? { ...cloudConfig, plugins: [...(cloudConfig.plugins ?? []), copyToRepoRoot()] } : local);
