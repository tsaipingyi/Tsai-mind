import { defineConfig } from 'vitest/config';

// Only the React-free sync modules are unit tested here; UI is verified through the web export + Playwright.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
