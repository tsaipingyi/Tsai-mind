/**
 * Demo mode: the whole app runs against an in-memory mock of the server (see ./mockApi.ts).
 * Enabled by the `build:demo` bundle (VITE_DEMO=true), by `?demo` in the URL, or by "demo" in the hash.
 * Once enabled via the URL it sticks for the tab (sessionStorage) so a HashRouter navigation + reload keeps it.
 */
const DEMO_KEY = 'tsaimind.demo';

export const isDemo: boolean = (() => {
  try {
    if (import.meta.env.VITE_DEMO === 'true') return true;
    if (typeof location === 'undefined') return false;
    const fromUrl = /(^|[?&])demo(=|&|$)/.test(location.search) || /demo/.test(location.hash);
    if (fromUrl) {
      try {
        sessionStorage.setItem(DEMO_KEY, '1');
      } catch {
        /* ignore */
      }
      return true;
    }
    return sessionStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
})();

export const DEMO_TOKEN = 'demo';
export const DEMO_BANNER = '演示模式：数据只在本页内存里，刷新即重置。Claude 的回答是脚本化的。';
