// Single-file cloud build: `pnpm --filter @tsai-mind/web build:cloud` → dist-cloud/index.html
// The whole app + in-page server inlined into one HTML file for publishing as a claude.ai Artifact
// (capabilities: db, sample, downloads). VITE_CLOUD=true turns on src/cloud.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** After the bundle is written, mirror it to <repo>/dist-cloud so a static host that looks at the
 * repository root (Vercel with Output Directory "dist-cloud") finds it too. */
function mirrorToRepoRoot(): Plugin {
  return {
    name: 'tsai-mind-mirror-dist-cloud',
    closeBundle() {
      const from = resolve(__dirname, 'dist-cloud');
      const to = resolve(__dirname, '../../dist-cloud');
      if (!existsSync(from)) return;
      rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { recursive: true });
      console.log('[tsai-mind] cloud bundle mirrored to ' + to);
    },
  };
}

const cloudConfig: UserConfig = {
  base: './',
  define: { 'import.meta.env.VITE_CLOUD': JSON.stringify('true') },
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true }), mirrorToRepoRoot()],
  build: {
    outDir: 'dist-cloud',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    reportCompressedSize: false,
  },
};
export { cloudConfig };
export default defineConfig(cloudConfig);
