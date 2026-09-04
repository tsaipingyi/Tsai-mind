// Single-file demo build: `pnpm --filter @tsai-mind/web build:demo` → dist-demo/index.html
// The whole app + in-memory mock server (src/demo) inlined into one HTML file; no backend needed.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  base: './',
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify('true') },
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    reportCompressedSize: false,
  },
});
