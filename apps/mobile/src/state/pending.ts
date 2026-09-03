import { create } from 'zustand';
import { api, errorMessage } from '../api/client';
import type { PendingChange, PlanBatch, ProjectRow } from '../api/types';
import { onRealtime } from '../sync/realtime';
import { noteOnline, snapshots } from '../sync/runtime';
import { toast } from './toast';
import { useProjects } from './project';

interface PendingState {
  changes: PendingChange[];
  batches: PlanBatch[];
  projects: ProjectRow[];
  loading: boolean;
  error: string | null;
  loadedAt: number;
  load: () => Promise<void>;
  decide: (ids: string[], decision: 'approve' | 'reject') => Promise<boolean>;
  applyBatch: (id: string) => Promise<boolean>;
  discardBatch: (id: string) => Promise<boolean>;
}

const CACHE_KEY = 'pending';

export const usePending = create<PendingState>((set, get) => {
  onRealtime((msg) => {
    if (msg.type === 'change') {
      const c = msg.change;
      const others = get().changes.filter((p) => p.id !== c.id);
      set({ changes: c.status === 'pending' ? [...others, c] : others });
    } else if (msg.type === 'batch') {
      const b = msg.batch;
      const others = get().batches.filter((x) => x.id !== b.id);
      set({ batches: b.status === 'draft' ? [...others, b] : others });
    }
  });

  const after = async (projectIds: string[]) => {
    const st = useProjects.getState();
    for (const pid of new Set(projectIds)) if (st.projects[pid]) void st.reload(pid);
  };

  return {
    changes: [],
    batches: [],
    projects: [],
    loading: false,
    error: null,
    loadedAt: 0,

    load: async () => {
      set({ loading: true });
      try {
        const [changes, projects] = await Promise.all([api.pendingChanges(), api.listProjects().catch(() => get().projects)]);
        noteOnline();
        const lists = await Promise.all(projects.map((p) => api.listDraftBatches(p.id).catch(() => [] as PlanBatch[])));
        const batches = lists.flat().filter((b) => b.status === 'draft');
        set({ changes, batches, projects, loading: false, error: null, loadedAt: Date.now() });
        void snapshots.saveGeneric(CACHE_KEY, { changes, batches, projects });
      } catch (e) {
        const cached = await snapshots.loadGeneric<{ changes: PendingChange[]; batches: PlanBatch[]; projects: ProjectRow[] }>(CACHE_KEY);
        if (cached && !get().loadedAt) set({ ...cached, loading: false, error: errorMessage(e) });
        else set({ loading: false, error: errorMessage(e) });
      }
    },

    decide: async (ids, decision) => {
      if (!ids.length) return false;
      try {
        if (ids.length === 1) {
          if (decision === 'approve') await api.approveChange(ids[0]!);
          else await api.rejectChange(ids[0]!);
        } else await api.batchChanges(ids.map((id) => ({ id, decision })));
        const affected = get().changes.filter((c) => ids.includes(c.id)).map((c) => c.projectId);
        set({ changes: get().changes.filter((c) => !ids.includes(c.id)) });
        useProjects.getState().removePending(ids);
        toast(decision === 'approve' ? `已确认 ${ids.length} 项` : `已拒绝 ${ids.length} 项`, 'ok');
        void after(affected);
        return true;
      } catch (e) {
        toast(`操作失败：${errorMessage(e)}`, 'error');
        return false;
      }
    },

    applyBatch: async (id) => {
      try {
        await api.applyBatch(id);
        const b = get().batches.find((x) => x.id === id);
        set({ batches: get().batches.filter((x) => x.id !== id) });
        useProjects.getState().removeBatch(id);
        toast('草案已应用', 'ok');
        if (b) void after([b.projectId]);
        return true;
      } catch (e) {
        toast(`应用失败：${errorMessage(e)}`, 'error');
        return false;
      }
    },

    discardBatch: async (id) => {
      try {
        await api.discardBatch(id);
        set({ batches: get().batches.filter((x) => x.id !== id) });
        useProjects.getState().removeBatch(id);
        toast('草案已丢弃');
        return true;
      } catch (e) {
        toast(`丢弃失败：${errorMessage(e)}`, 'error');
        return false;
      }
    },
  };
});

export function pendingCount(s: PendingState): number {
  return s.changes.length + s.batches.length;
}
