/**
 * Demo mode: the whole app runs against an in-memory mock of the server (see ./mockApi.ts).
 * Enabled by the `build:demo` bundle (VITE_DEMO=true), by `?demo` in the URL, or by "demo" in the hash.
 * Once enabled via the URL it sticks for the tab (sessionStorage) so a HashRouter navigation + reload keeps it.
 *
 * Cloud mode (`build:cloud`, see ../cloud/mode.ts) is a superset: `isDemo` is true there too — same
 * HashRouter, no-op realtime, fetch wrapper and fixed token — with persistence and the real Claude
 * layered on top. Use `isCloud` to tell the two apart (e.g. the demo banner only shows in plain demo).
 */
import { isCloud } from '../cloud/mode';

const DEMO_KEY = 'tsaimind.demo';

export const isDemo: boolean = (() => {
  try {
    if (import.meta.env.VITE_DEMO === 'true' || isCloud) return true;
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

export { isCloud };
export const DEMO_TOKEN = 'demo';
export const DEMO_BANNER = '演示模式：数据只在本页内存里，刷新即重置。Claude 的回答是脚本化的。';
