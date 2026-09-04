import { create } from 'zustand';
import { AppState, Platform } from 'react-native';
import { api, isNetworkError } from '../api/client';
import type { AccountSettings, NotificationSettings } from '../api/types';
import { kv } from '../lib/storage';
import { useSession } from './session';
import { useSync } from '../sync/runtime';
import { toast } from './toast';

export type { NotificationSettings } from '../api/types';

/**
 * Notification toggles + nudge template. The server copy (`account.settings`,
 * GET /api/me) is the source of truth; every change is written with
 * PATCH /api/me. A local copy is kept so the screen works offline: a change
 * that could not be sent is marked `dirty` and retried the next time the app
 * comes to the foreground or the network comes back.
 */
interface SettingsState {
  notifications: NotificationSettings;
  /** '' = server default template */
  nudgeTemplate: string;
  loaded: boolean;
  /** local edits not yet accepted by the server */
  dirty: boolean;
  syncing: boolean;
  load: () => Promise<void>;
  /** Take the server's copy (from GET /api/me) unless a local edit is still waiting to be sent. */
  applyServer: (settings: AccountSettings | null | undefined) => void;
  setNotification: (k: keyof NotificationSettings, v: boolean) => Promise<void>;
  setNudgeTemplate: (t: string) => Promise<void>;
  /** PATCH the pending local edits. Resolves true when nothing is left to send. */
  flush: () => Promise<boolean>;
}

const KEY = 'tsaimind.settings';
export const DEFAULT_NOTIFICATIONS: NotificationSettings = { dueSoon: true, overdue: true, nudgeDue: true, digest: true };
export const DEFAULT_NUDGE_TEMPLATE = '关于「{title}」，原定 {due}，现在进度 {progress}%，方便同步一下进展吗？';

interface Persisted {
  notifications: Partial<NotificationSettings>;
  nudgeTemplate?: string;
  dirty?: boolean;
}

export const useSettings = create<SettingsState>((set, get) => {
  const persist = () => {
    const { notifications, nudgeTemplate, dirty } = get();
    const p: Persisted = { notifications, nudgeTemplate, dirty };
    return kv.setItem(KEY, JSON.stringify(p)).catch(() => undefined);
  };

  const edit = async (partial: Partial<Pick<SettingsState, 'notifications' | 'nudgeTemplate'>>) => {
    set({ ...partial, dirty: true });
    await persist();
    await get().flush();
  };

  return {
    notifications: DEFAULT_NOTIFICATIONS,
    nudgeTemplate: '',
    loaded: false,
    dirty: false,
    syncing: false,

    load: async () => {
      try {
        const raw = await kv.getItem(KEY);
        if (raw) {
          const p = JSON.parse(raw) as Persisted;
          set({ notifications: { ...DEFAULT_NOTIFICATIONS, ...(p.notifications ?? {}) }, nudgeTemplate: p.nudgeTemplate ?? '', dirty: !!p.dirty });
        }
      } catch {
        /* ignore */
      }
      set({ loaded: true });
      if (get().dirty) void get().flush();
    },

    applyServer: (settings) => {
      if (get().dirty) {
        void get().flush();
        return;
      }
      const n = settings?.notifications ?? {};
      set({ notifications: { ...DEFAULT_NOTIFICATIONS, ...n }, nudgeTemplate: typeof settings?.nudgeTemplate === 'string' ? settings.nudgeTemplate : '' });
      void persist();
    },

    setNotification: (k, v) => edit({ notifications: { ...get().notifications, [k]: v } }),
    setNudgeTemplate: (t) => edit({ nudgeTemplate: t.trim() }),

    flush: async () => {
      const st = get();
      if (!st.dirty) return true;
      if (st.syncing || !useSession.getState().token) return false;
      set({ syncing: true });
      const settings: AccountSettings = { notifications: st.notifications, nudgeTemplate: st.nudgeTemplate };
      try {
        const r = await api.patchMe({ settings });
        // the user may have toggled again while the request was in flight
        const cur = get();
        const same = cur.nudgeTemplate === st.nudgeTemplate && (Object.keys(cur.notifications) as (keyof NotificationSettings)[]).every((k) => cur.notifications[k] === st.notifications[k]);
        set({ syncing: false, dirty: !same });
        if (r?.account) useSession.setState({ account: r.account });
        await persist();
        return same;
      } catch (e) {
        set({ syncing: false });
        if (!isNetworkError(e)) toast('通知设置暂时没保存到服务器，稍后会重试', 'error');
        return false;
      }
    },
  };
});

// server copy arrives with the account (login / bootstrap)
useSession.subscribe((s, prev) => {
  if (s.account && s.account !== prev.account) useSettings.getState().applyServer(s.account.settings);
});

// retry a pending PATCH when the network comes back or the app returns to the foreground
useSync.subscribe((s, prev) => {
  if (s.online && !prev.online) void useSettings.getState().flush();
});
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void useSettings.getState().flush();
  });
} else {
  const g = globalThis as { document?: { addEventListener?: (t: string, f: () => void) => void; visibilityState?: string } };
  g.document?.addEventListener?.('visibilitychange', () => {
    if (g.document?.visibilityState === 'visible') void useSettings.getState().flush();
  });
}
