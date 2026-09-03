import { create } from 'zustand';
import { kv } from '../lib/storage';

/**
 * Notification toggles. The server has no PATCH /api/me in the phase-1 contract,
 * so these are kept locally and applied client-side (the push handler drops
 * categories that are switched off). When the server grows a settings endpoint
 * this is the one place to sync from.
 */
export interface NotificationSettings {
  dueSoon: boolean;
  overdue: boolean;
  nudgeDue: boolean;
  digest: boolean;
}

interface SettingsState {
  notifications: NotificationSettings;
  loaded: boolean;
  load: () => Promise<void>;
  setNotification: (k: keyof NotificationSettings, v: boolean) => Promise<void>;
}

const KEY = 'tsaimind.settings';
const DEFAULTS: NotificationSettings = { dueSoon: true, overdue: true, nudgeDue: true, digest: true };

export const useSettings = create<SettingsState>((set, get) => ({
  notifications: DEFAULTS,
  loaded: false,
  load: async () => {
    try {
      const raw = await kv.getItem(KEY);
      if (raw) set({ notifications: { ...DEFAULTS, ...(JSON.parse(raw) as Partial<NotificationSettings>) } });
    } catch {
      /* ignore */
    }
    set({ loaded: true });
  },
  setNotification: async (k, v) => {
    const next = { ...get().notifications, [k]: v };
    set({ notifications: next });
    await kv.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
  },
}));
