// Single-file cloud build: `pnpm --filter @tsai-mind/web build:cloud` → dist-cloud/index.html
// The whole app + in-page server inlined into one HTML file for publishing as a claude.ai Artifact
// (capabilities: db, sample, downloads). VITE_CLOUD=true turns on src/cloud.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  base: './',
  define: { 'import.meta.env.VITE_CLOUD': JSON.stringify('true') },
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: 'dist-cloud',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    reportCompressedSize: false,
  },
});
