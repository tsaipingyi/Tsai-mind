/**
 * Demo-mode installer. Imported FIRST by main.tsx so it runs before the session store reads the token.
 * Wraps window.fetch: any request to `/api/*` on this origin is answered by the in-memory DemoServer;
 * everything else (Google Fonts…) goes to the network as usual.
 */
import { DEMO_TOKEN, isDemo } from './flag';
import { TOKEN_KEY } from '../api/client';
import { DemoServer, newId } from './mockApi';

export let demoServer: DemoServer | null = null;

export function installDemo(): void {
  if (!isDemo || demoServer) return;
  // crypto.randomUUID is missing on insecure origins (plain http on a LAN IP); the editor needs it for op ids
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (c && typeof c.randomUUID !== 'function') c.randomUUID = newId as () => `${string}-${string}-${string}-${string}-${string}`;

  demoServer = new DemoServer();
  try {
    if (!localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, DEMO_TOKEN);
  } catch {
    /* ignore */
  }

  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let u: URL | null = null;
    try {
      u = new URL(raw, location.href);
    } catch {
      u = null;
    }
    const sameOrigin = !!u && (u.origin === location.origin || (u.protocol === 'file:' && location.protocol === 'file:'));
    if (u && sameOrigin && u.pathname.startsWith('/api/')) {
      const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
      const body = init?.body;
      return demoServer!.handle({ method, url: u.href, body: typeof body === 'string' ? body : undefined, signal: init?.signal ?? null });
    }
    return original(input, init);
  }) as typeof window.fetch;
}

installDemo();
