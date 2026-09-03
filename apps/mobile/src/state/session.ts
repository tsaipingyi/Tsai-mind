import { create } from 'zustand';
import { api, configure, DEFAULT_SERVER, normalizeServerUrl, onUnauthorized } from '../api/client';
import type { Account } from '../api/types';
import { clientId, kv, secure } from '../lib/storage';
import { startRealtime, stopRealtime } from '../sync/realtime';

const TOKEN_KEY = 'tsaimind.token';
const SERVER_KEY = 'tsaimind.server';

interface SessionState {
  token: string | null;
  serverUrl: string;
  account: Account | null;
  scopes: string[];
  /** true until the stored token has been read (and validated once if online) */
  checking: boolean;
  bootstrap: () => Promise<void>;
  login: (serverUrl: string, token: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  token: null,
  serverUrl: DEFAULT_SERVER,
  account: null,
  scopes: [],
  checking: true,

  bootstrap: async () => {
    await clientId();
    const [token, server] = await Promise.all([secure.getItem(TOKEN_KEY), kv.getItem(SERVER_KEY)]);
    const serverUrl = normalizeServerUrl(server ?? DEFAULT_SERVER);
    configure({ baseUrl: serverUrl, token });
    if (!token) {
      set({ checking: false, serverUrl });
      return;
    }
    set({ token, serverUrl });
    try {
      const me = await api.me();
      set({ account: me.account, scopes: me.scopes });
    } catch {
      // offline: keep the token so the app opens from snapshots; a 401 logs out via onUnauthorized
    }
    set({ checking: false });
    startRealtime(token);
  },

  login: async (serverUrl, token) => {
    const url = normalizeServerUrl(serverUrl);
    const t = token.trim();
    const me = await api.me({ token: t, baseUrl: url });
    configure({ baseUrl: url, token: t });
    await Promise.all([secure.setItem(TOKEN_KEY, t), kv.setItem(SERVER_KEY, url)]);
    set({ token: t, serverUrl: url, account: me.account, scopes: me.scopes, checking: false });
    startRealtime(t);
  },

  logout: async () => {
    stopRealtime();
    configure({ token: null });
    await secure.removeItem(TOKEN_KEY).catch(() => undefined);
    set({ token: null, account: null, scopes: [], checking: false });
    // keep serverUrl so the login form is prefilled
    void get;
  },
}));

onUnauthorized(() => {
  if (useSession.getState().token) void useSession.getState().logout();
});
