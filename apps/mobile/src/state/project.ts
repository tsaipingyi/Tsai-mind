import { create } from 'zustand';
import { TreeStore, computeRollup, addDays, computeCriticalPath, findDependencySlips } from '@tsai-mind/core';
import type { Change, Contact, Dependency, Derived, NodePatch, Op, Project, TNode } from '@tsai-mind/core';
import { api, errorMessage, isNetworkError } from '../api/client';
import type { PlanBatch, Slip } from '../api/types';
import { onRealtime, onRealtimeOpen } from '../sync/realtime';
import { noteOnline, queue, rememberNodes, setQueueHandlers, snapshots } from '../sync/runtime';
import { clientIdSync } from '../lib/storage';
import { uuid } from '../lib/ids';
import { toast } from './toast';

export interface LoadedProject {
  id: string;
  project: Project | null;
  store: TreeStore;
  /** bumps whenever the tree changes */
  rev: number;
  derived: Map<string, Derived>;
  contacts: Contact[];
  pending: Change[];
  batches: PlanBatch[];
  dependencies: Dependency[];
  /** Derived (core `computeCriticalPath`), root-first; recomputed on every tree change. */
  criticalPath: string[];
  /** Derived (core `findDependencySlips`), ids only. */
  slips: Slip[];
  serverSeq: number;
  loading: boolean;
  error: string | null;
  /** true when the tree came from the local snapshot because the server was unreachable */
  offline: boolean;
  loadedAt: number;
}

interface ProjectsState {
  projects: Record<string, LoadedProject>;
  load: (id: string, opts?: { force?: boolean }) => Promise<LoadedProject | null>;
  reload: (id: string) => Promise<void>;
  updateNode: (projectId: string, nodeId: string, patch: NodePatch) => boolean;
  deleteNode: (projectId: string, nodeId: string) => boolean;
  markDone: (projectId: string, nodeId: string) => boolean;
  postpone: (projectId: string, nodeId: string, days?: number) => boolean;
  removePending: (ids: string[]) => void;
  removeBatch: (id: string) => void;
  nudge: (projectId: string, nodeId: string) => Promise<string | null>;
  clearAll: () => void;
}

const sentOpIds = new Set<string>();
const loadSeq = new Map<string, number>();

function opBase(projectId: string): Pick<Op, 'opId' | 'clientId' | 'projectId' | 'actor' | 'at'> {
  return { opId: uuid(), clientId: clientIdSync(), projectId, actor: 'user', at: new Date().toISOString() };
}

function blank(id: string): LoadedProject {
  return {
    id,
    project: null,
    store: new TreeStore(),
    rev: 0,
    derived: new Map(),
    contacts: [],
    pending: [],
    batches: [],
    dependencies: [],
    criticalPath: [],
    slips: [],
    serverSeq: 0,
    loading: true,
    error: null,
    offline: false,
    loadedAt: 0,
  };
}

/** Schedule facts the screens show; the same core functions the server uses. */
export function computeSchedule(store: TreeStore, derived: Map<string, Derived>, deps: Dependency[]): { criticalPath: string[]; slips: Slip[] } {
  return {
    criticalPath: computeCriticalPath(store, derived),
    slips: findDependencySlips(store, derived, deps).map((s) => ({ fromNode: s.from.id, toNode: s.to.id, fromDue: s.fromDue, toStart: s.toStart, days: s.days })),
  };
}

/** Replay unsent local ops on top of a freshly built tree (best effort). */
function replayPending(store: TreeStore, projectId: string, skip: Set<string>): void {
  for (const op of queue.pending(projectId)) {
    if (skip.has(op.opId)) continue;
    sentOpIds.add(op.opId);
    store.apply(op);
  }
}

export const useProjects = create<ProjectsState>((set, get) => {
  const patch = (id: string, partial: Partial<LoadedProject>, bumpTree = false) => {
    const cur = get().projects[id] ?? blank(id);
    const store = partial.store ?? cur.store;
    const next: LoadedProject = { ...cur, ...partial, store };
    if (bumpTree || partial.store || partial.dependencies) {
      next.rev = cur.rev + 1;
      next.derived = computeRollup(store);
      Object.assign(next, computeSchedule(store, next.derived, next.dependencies));
      // a phase-3 server sends its own view of the schedule; prefer it when the tree came straight from it
      if (partial.criticalPath) next.criticalPath = partial.criticalPath;
      if (partial.slips) next.slips = partial.slips;
    }
    set({ projects: { ...get().projects, [id]: next } });
    return next;
  };

  const saveSnapshot = (id: string) => {
    const lp = get().projects[id];
    if (!lp?.project) return;
    void snapshots.save({
      project: lp.project,
      nodes: [...lp.store.nodes.values()],
      contacts: lp.contacts,
      pending: lp.pending,
      dependencies: lp.dependencies,
      serverSeq: lp.serverSeq,
      appliedOpIds: queue.pending(id).map((o) => o.opId),
    });
  };

  const dispatch = (op: Op): boolean => {
    const lp = get().projects[op.projectId];
    if (!lp) return false;
    const res = lp.store.apply(op);
    if (!res.ok) {
      toast(res.message, 'error');
      return false;
    }
    sentOpIds.add(op.opId);
    queue.enqueue(op);
    patch(op.projectId, {}, true);
    saveSnapshot(op.projectId);
    return true;
  };

  const applyRemote = (serverSeq: number, op: Op) => {
    const lp = get().projects[op.projectId];
    if (!lp || lp.loading) return;
    if (sentOpIds.has(op.opId)) {
      if (serverSeq > lp.serverSeq) patch(op.projectId, { serverSeq });
      return;
    }
    if (serverSeq <= lp.serverSeq) return;
    const res = lp.store.apply(op);
    if (res.ok) patch(op.projectId, { serverSeq }, true);
    else patch(op.projectId, { serverSeq });
    saveSnapshot(op.projectId);
  };

  const catchUp = async () => {
    for (const lp of Object.values(get().projects)) {
      if (lp.loading || !lp.project) continue;
      try {
        const ops = await api.getOps(lp.id, lp.serverSeq);
        for (const { serverSeq, op } of ops) applyRemote(serverSeq, op);
      } catch {
        /* ignore */
      }
    }
  };

  setQueueHandlers({
    onResults: (pid, results, seq) => {
      noteOnline();
      for (const r of results) if (r.ok && r.changeIds?.length) toast(`已提交 ${r.changeIds.length} 项待确认`);
      const lp = get().projects[pid];
      if (lp && seq > lp.serverSeq) patch(pid, { serverSeq: seq });
      if (queue.needsReload(pid)) {
        queue.clearReload(pid);
        void get().reload(pid);
      } else saveSnapshot(pid);
    },
    onOpFailed: (_pid, r) => {
      toast(`修改未保存：${r.message ?? r.error ?? '未知错误'}`, 'error');
    },
  });

  onRealtime((msg) => {
    if (msg.type === 'op') applyRemote(msg.serverSeq, msg.op);
    else if (msg.type === 'change') {
      const c = msg.change;
      const lp = get().projects[c.projectId];
      if (!lp) return;
      const others = lp.pending.filter((p) => p.id !== c.id);
      patch(c.projectId, { pending: c.status === 'pending' ? [...others, c] : others });
    } else if (msg.type === 'batch') {
      const b = msg.batch;
      const lp = get().projects[b.projectId];
      if (!lp) return;
      const others = lp.batches.filter((x) => x.id !== b.id);
      patch(b.projectId, { batches: b.status === 'draft' ? [...others, b] : others });
    }
  });
  onRealtimeOpen(() => void catchUp());

  const loadInto = async (id: string): Promise<LoadedProject | null> => {
    const mySeq = (loadSeq.get(id) ?? 0) + 1;
    loadSeq.set(id, mySeq);
    if (!get().projects[id]) set({ projects: { ...get().projects, [id]: blank(id) } });
    else patch(id, { loading: true, error: null });
    try {
      const d = await api.getProject(id);
      if (loadSeq.get(id) !== mySeq) return get().projects[id] ?? null;
      noteOnline();
      const store = new TreeStore(d.nodes);
      replayPending(store, id, new Set());
      const lp = patch(id, {
        project: d.project,
        store,
        contacts: d.contacts,
        pending: d.pendingChanges.filter((c) => c.status === 'pending'),
        dependencies: d.dependencies ?? [],
        ...(d.criticalPath ? { criticalPath: d.criticalPath } : {}),
        ...(d.slips ? { slips: d.slips } : {}),
        serverSeq: d.serverSeq,
        loading: false,
        error: null,
        offline: false,
        loadedAt: Date.now(),
      });
      void rememberNodes(id, d.nodes.map((n) => n.id));
      saveSnapshot(id);
      // draft batches (best effort)
      try {
        const found = (await api.listDraftBatches(id)).filter((b) => b.status === 'draft');
        if (loadSeq.get(id) === mySeq) patch(id, { batches: found });
      } catch {
        /* ignore */
      }
      return lp;
    } catch (e) {
      if (loadSeq.get(id) !== mySeq) return get().projects[id] ?? null;
      if (isNetworkError(e)) {
        const snap = await snapshots.load(id);
        if (snap) {
          const store = new TreeStore(snap.nodes);
          replayPending(store, id, new Set(snap.appliedOpIds));
          return patch(id, {
            project: snap.project,
            store,
            contacts: snap.contacts,
            pending: snap.pending,
            dependencies: snap.dependencies ?? [],
            serverSeq: snap.serverSeq,
            loading: false,
            error: null,
            offline: true,
            loadedAt: Date.now(),
          });
        }
      }
      patch(id, { loading: false, error: errorMessage(e) });
      return null;
    }
  };

  return {
    projects: {},

    load: async (id, opts = {}) => {
      const cur = get().projects[id];
      if (cur && !opts.force && !cur.loading && cur.project && !cur.offline && Date.now() - cur.loadedAt < 30_000) return cur;
      if (cur?.loading) {
        // wait for the in-flight load
        await new Promise<void>((resolve) => {
          const unsub = useProjects.subscribe((s) => {
            if (!s.projects[id]?.loading) {
              unsub();
              resolve();
            }
          });
        });
        return get().projects[id] ?? null;
      }
      return loadInto(id);
    },

    reload: async (id) => {
      await loadInto(id);
    },

    updateNode: (projectId, nodeId, p) => {
      const lp = get().projects[projectId];
      const n = lp?.store.live(nodeId);
      if (!lp || !n) return false;
      const eff: NodePatch = {};
      for (const [k, v] of Object.entries(p) as [keyof NodePatch, unknown][]) {
        const cur = n[k];
        const same = Array.isArray(v) && Array.isArray(cur) ? v.length === cur.length && v.every((x, i) => x === cur[i]) : v === cur;
        if (!same) (eff as Record<string, unknown>)[k] = v;
      }
      if (!Object.keys(eff).length) return true;
      return dispatch({ ...opBase(projectId), type: 'update_node', nodeId, patch: eff, baseVersion: n.version });
    },

    deleteNode: (projectId, nodeId) => {
      const lp = get().projects[projectId];
      const n = lp?.store.live(nodeId);
      if (!lp || !n || n.parentId === null) return false;
      return dispatch({ ...opBase(projectId), type: 'delete_node', nodeId });
    },

    markDone: (projectId, nodeId) => get().updateNode(projectId, nodeId, { status: 'done' }),

    postpone: (projectId, nodeId, days = 1) => {
      const lp = get().projects[projectId];
      const n = lp?.store.live(nodeId);
      if (!lp || !n) return false;
      const d = lp.derived.get(nodeId);
      const base = n.dueDate ?? d?.dueDate ?? null;
      if (!base) return false;
      const p: NodePatch = { dueDate: addDays(base, days) };
      if (d?.hasChildren && n.dateMode === 'auto') {
        p.dateMode = 'manual';
        p.startDate = n.startDate ?? d.startDate;
      }
      return get().updateNode(projectId, nodeId, p);
    },

    removePending: (ids) => {
      for (const lp of Object.values(get().projects)) {
        if (lp.pending.some((c) => ids.includes(c.id))) patch(lp.id, { pending: lp.pending.filter((c) => !ids.includes(c.id)) });
      }
    },

    removeBatch: (id) => {
      for (const lp of Object.values(get().projects)) {
        if (lp.batches.some((b) => b.id === id)) patch(lp.id, { batches: lp.batches.filter((b) => b.id !== id) });
      }
    },

    nudge: async (projectId, nodeId) => {
      try {
        const r = await api.nudge(nodeId);
        const lp = get().projects[projectId];
        const cur = lp?.store.get(nodeId);
        if (lp && cur) {
          lp.store.nodes.set(nodeId, { ...cur, lastNudgedAt: r.node?.lastNudgedAt ?? new Date().toISOString(), version: r.node?.version ?? cur.version });
          patch(projectId, {}, true);
          saveSnapshot(projectId);
        }
        return r.text;
      } catch (e) {
        toast(`催办失败：${errorMessage(e)}`, 'error');
        return null;
      }
    },

    clearAll: () => set({ projects: {} }),
  };
});

/** Find a loaded project that contains this node (live or deleted). */
export function findProjectOfNode(nodeId: string): LoadedProject | null {
  for (const lp of Object.values(useProjects.getState().projects)) if (lp.store.get(nodeId)) return lp;
  return null;
}

export function nodeOf(lp: LoadedProject | null | undefined, nodeId: string): TNode | undefined {
  return lp?.store.live(nodeId);
}
