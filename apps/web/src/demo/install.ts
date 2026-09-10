/**
 * Demo / cloud installer. Imported FIRST by main.tsx so it runs before the session store reads the token.
 * Wraps window.fetch: any request to `/api/*` on this origin is answered by the in-memory DemoServer;
 * everything else (Google Fonts…) goes to the network as usual.
 *
 * Cloud mode installs the same server, seeded empty, and layers persistence (artifact `db`) and the
 * `sample`-backed assistant on it (see ../cloud). Requests wait until the persisted state is loaded.
 */
import { DEMO_TOKEN, isDemo } from './flag';
import { isCloud } from '../cloud/mode';
import { TOKEN_KEY } from '../api/client';
import { DemoServer, newId } from './mockApi';
import { buildCloudSeed } from '../cloud/seed';

export let demoServer: DemoServer | null = null;
/** Resolves once the server can answer (immediately in demo mode; after the cloud boot in cloud mode). */
export let serverReady: Promise<void> = Promise.resolve();

export function installDemo(): void {
  if (!isDemo || demoServer) return;
  // crypto.randomUUID is missing on insecure origins (plain http on a LAN IP); the editor needs it for op ids
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (c && typeof c.randomUUID !== 'function') c.randomUUID = newId as () => `${string}-${string}-${string}-${string}-${string}`;

  const server = new DemoServer(isCloud ? buildCloudSeed() : undefined);
  demoServer = server;
  try {
    if (!localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, DEMO_TOKEN);
  } catch {
    /* ignore */
  }

  if (isCloud) {
    // dynamic on purpose: ../cloud pulls in the state stores, which must not evaluate before this body ran
    serverReady = import('../cloud').then(({ installCloud }) => installCloud(server)).catch((e) => console.warn('cloud: boot failed', e));
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
      const req = { method, url: u.href, body: typeof body === 'string' ? body : undefined, signal: init?.signal ?? null };
      return serverReady.then(() => server.handle(req));
    }
    return original(input, init);
  }) as typeof window.fetch;
}

installDemo();
