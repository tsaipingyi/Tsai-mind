import { create } from 'zustand';
import { api, getToken, setToken } from '../api/client';
import type { Account } from '../api/types';

interface SessionState {
  token: string | null;
  account: Account | null;
  scopes: string[];
  /** true until the stored token has been validated once */
  checking: boolean;
  login: (token: string) => Promise<void>;
  logout: () => void;
  bootstrap: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  token: getToken(),
  account: null,
  scopes: [],
  checking: !!getToken(),
  login: async (token) => {
    const me = await api.me(token.trim());
    setToken(token.trim());
    set({ token: token.trim(), account: me.account, scopes: me.scopes, checking: false });
  },
  logout: () => {
    setToken(null);
    set({ token: null, account: null, scopes: [], checking: false });
  },
  bootstrap: async () => {
    const token = get().token;
    if (!token) {
      set({ checking: false });
      return;
    }
    try {
      const me = await api.me();
      set({ account: me.account, scopes: me.scopes, checking: false });
    } catch {
      // network error keeps the token (server may be down); 401 handler logs out
      set({ checking: false });
    }
  },
}));
