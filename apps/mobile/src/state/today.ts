import { create } from 'zustand';
import type { Contact } from '@tsai-mind/core';
import { ApiError, api, errorMessage } from '../api/client';
import { todaySections, type PendingChange, type TodayEntry, type TodayResponse, type TodaySections } from '../api/types';
import { noteOnline, snapshots } from '../sync/runtime';
import { toast } from './toast';
import { useProjects } from './project';
import { usePending } from './pending';

interface TodayState {
  sections: TodaySections | null;
  pending: PendingChange[];
  contacts: Contact[];
  loading: boolean;
  error: string | null;
  fromCache: boolean;
  load: () => Promise<void>;
  decide: (c: PendingChange, decision: 'approve' | 'reject') => Promise<void>;
  /** Returns the nudge text for the share sheet. */
  nudge: (e: TodayEntry) => Promise<string | null>;
  markDone: (e: TodayEntry) => Promise<void>;
  postpone: (e: TodayEntry) => Promise<void>;
}

const CACHE_KEY = 'today';

/** The new /done and /postpone endpoints may not exist on an older server: fall back to an Op through the project store. */
async function viaEndpointOrOp(call: () => Promise<unknown>, fallback: () => Promise<boolean>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return fallback();
    throw e;
  }
}

export const useToday = create<TodayState>((set, get) => {
  const removeEntry = (nodeId: string) => {
    const s = get().sections;
    if (!s) return;
    const f = (l: TodayEntry[]) => l.filter((x) => x.node.id !== nodeId);
    set({ sections: { overdue: f(s.overdue), dueToday: f(s.dueToday), dueTomorrow: f(s.dueTomorrow), nudgeDue: f(s.nudgeDue) } });
  };

  return {
    sections: null,
    pending: [],
    contacts: [],
    loading: false,
    error: null,
    fromCache: false,

    load: async () => {
      set({ loading: true });
      try {
        const [t, c] = await Promise.all([api.today(), api.listContacts().catch(() => get().contacts)]);
        noteOnline();
        const sections = todaySections(t);
        set({ sections, pending: t.pending ?? [], contacts: c, loading: false, error: null, fromCache: false });
        void snapshots.saveGeneric(CACHE_KEY, { t, c });
      } catch (e) {
        const cached = await snapshots.loadGeneric<{ t: TodayResponse; c: Contact[] }>(CACHE_KEY);
        if (cached && !get().sections) set({ sections: todaySections(cached.t), pending: cached.t.pending ?? [], contacts: cached.c, fromCache: true });
        set({ loading: false, error: errorMessage(e) });
      }
    },

    decide: async (c, decision) => {
      const ok = await usePending.getState().decide([c.id], decision);
      if (ok) {
        set({ pending: get().pending.filter((p) => p.id !== c.id) });
        void get().load();
      }
    },

    nudge: async (e) => {
      try {
        const r = await api.nudge(e.node.id);
        void get().load();
        return r.text;
      } catch (err) {
        toast(`催办失败：${errorMessage(err)}`, 'error');
        return null;
      }
    },

    markDone: async (e) => {
      removeEntry(e.node.id);
      try {
        await viaEndpointOrOp(
          () => api.markDone(e.node.id),
          async () => {
            const st = useProjects.getState();
            await st.load(e.projectId);
            return st.markDone(e.projectId, e.node.id);
          },
        );
        toast('已标记完成', 'ok');
      } catch (err) {
        toast(`操作失败：${errorMessage(err)}`, 'error');
      }
      void get().load();
    },

    postpone: async (e) => {
      removeEntry(e.node.id);
      try {
        await viaEndpointOrOp(
          () => api.postpone(e.node.id, 1),
          async () => {
            const st = useProjects.getState();
            await st.load(e.projectId);
            return st.postpone(e.projectId, e.node.id, 1);
          },
        );
        toast('已推迟一天', 'ok');
      } catch (err) {
        toast(`操作失败：${errorMessage(err)}`, 'error');
      }
      void get().load();
    },
  };
});
