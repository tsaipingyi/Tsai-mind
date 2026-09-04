import { create } from 'zustand';
import { TreeStore, computeCriticalPath, computeRollup, findDependencySlips, rankBetween } from '@tsai-mind/core';
import type { Change, Contact, Dependency, Derived, NewNodeInput, NodePatch, Op, Project, TNode } from '@tsai-mind/core';
import { api, errorMessage } from '../api/client';
import type { PlanBatch, Slip } from '../api/types';
import { onRealtime, onRealtimeOpen } from '../api/realtime';
import { toast } from './toast';
import { clientId } from '../lib/util';

export type ViewMode = 'map' | 'outline' | 'gantt' | 'board';
export type GanttZoom = 'day' | 'week' | 'month';

/** undefined = no filter, null = "me", string = contact id */
export type OwnerFilter = string | null | undefined;

interface ProjectState {
  projectId: string | null;
  project: Project | null;
  store: TreeStore;
  /** bumps whenever the tree changes; components depend on it to re-read the store */
  rev: number;
  derived: Map<string, Derived>;
  contacts: Contact[];
  pending: Change[];
  batches: PlanBatch[];
  dependencies: Dependency[];
  /** root-first chain of node ids (server value on load, recomputed locally after every edit) */
  criticalPath: string[];
  slips: Slip[];
  serverSeq: number;
  loading: boolean;
  error: string | null;

  selectedId: string | null;
  editingId: string | null;
  collapsed: Set<string>;
  ownerFilter: OwnerFilter;
  search: string;
  view: ViewMode;
  ganttZoom: GanttZoom;
  pendingPanelOpen: boolean;
  chatOpen: boolean;
  /** set by the sidebar/palette to ask a specific control to focus */
  focusRequest: { field: 'dueDate' | 'startDate' | 'progress' | 'title'; n: number } | null;

  load: (id: string) => Promise<void>;
  reload: () => Promise<void>;
  unload: () => void;

  select: (id: string | null) => void;
  setEditing: (id: string | null) => void;
  toggleCollapse: (id: string) => void;
  setOwnerFilter: (f: OwnerFilter) => void;
  setSearch: (s: string) => void;
  setView: (v: ViewMode) => void;
  setGanttZoom: (z: GanttZoom) => void;
  setPendingPanel: (open: boolean) => void;
  setChatOpen: (open: boolean) => void;
  /** pull ops the server has that we don't (used after Claude edits the project) */
  syncOps: () => Promise<void>;
  requestFocus: (field: 'dueDate' | 'startDate' | 'progress' | 'title') => void;

  updateNode: (id: string, patch: NodePatch) => boolean;
  createChild: (parentId: string, title?: string) => string | null;
  createSibling: (id: string, title?: string) => string | null;
  moveNode: (id: string, parentId: string, afterId: string | null) => boolean;
  deleteNode: (id: string) => boolean;
  undo: () => Promise<void>;
  renameProject: (name: string) => Promise<void>;

  decideChanges: (ids: string[], decision: 'approve' | 'reject') => Promise<void>;
  applyBatch: (id: string) => Promise<void>;
  discardBatch: (id: string) => Promise<void>;
  nudge: (nodeId: string) => Promise<string | null>;

  addDependency: (fromNode: string, toNode: string) => Promise<boolean>;
  removeDependency: (fromNode: string, toNode: string) => Promise<boolean>;
  reloadDependencies: () => Promise<void>;
}

// ---- outgoing op queue (module-level, one per tab) ----
let queue: Op[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const sentOpIds = new Set<string>();
/** own ops in submission order; serverSeq filled in when the server acks */
const undoStack: { opId: string; serverSeq: number | null }[] = [];
let loadSeq = 0;

function opBase(projectId: string): Pick<Op, 'opId' | 'clientId' | 'projectId' | 'actor' | 'at'> {
  return { opId: crypto.randomUUID(), clientId: clientId(), projectId, actor: 'user', at: new Date().toISOString() };
}

export const useProject = create<ProjectState>((set, get) => {
  const schedule = (store: TreeStore, derived: Map<string, Derived>, deps: Dependency[]) => ({
    criticalPath: computeCriticalPath(store, derived),
    slips: findDependencySlips(store, derived, deps).map((x) => ({ fromNode: x.from.id, toNode: x.to.id, fromDue: x.fromDue, toStart: x.toStart, days: x.days })),
  });

  const bump = (partial: Partial<ProjectState> = {}) => {
    const store = partial.store ?? get().store;
    const derived = computeRollup(store);
    const deps = partial.dependencies ?? get().dependencies;
    set({ ...partial, store, rev: get().rev + 1, derived, ...schedule(store, derived, deps) });
  };

  const flush = async () => {
    flushTimer = null;
    const ops = queue;
    queue = [];
    if (!ops.length) return;
    const pid = ops[0]!.projectId;
    try {
      const res = await api.postOps(pid, ops);
      let failed = false;
      for (const r of res.results) {
        const entry = undoStack.find((u) => u.opId === r.opId);
        if (r.ok) {
          if (entry && r.serverSeq != null) entry.serverSeq = r.serverSeq;
          if (r.changeIds?.length) toast(`已提交 ${r.changeIds.length} 项待确认`);
        } else {
          failed = true;
          toast(`修改未保存：${r.message ?? r.error ?? '未知错误'}`, 'error');
          const i = undoStack.findIndex((u) => u.opId === r.opId);
          if (i >= 0) undoStack.splice(i, 1);
        }
      }
      if (get().projectId === pid && typeof res.serverSeq === 'number' && res.serverSeq > get().serverSeq)
        set({ serverSeq: res.serverSeq });
      if (failed && get().projectId === pid) await get().reload();
    } catch (e) {
      toast(`修改未保存：${errorMessage(e)}`, 'error');
      if (get().projectId === pid) await get().reload();
    }
  };

  const dispatch = (op: Op): boolean => {
    const { store } = get();
    const res = store.apply(op);
    if (!res.ok) {
      toast(res.message, 'error');
      return false;
    }
    sentOpIds.add(op.opId);
    undoStack.push({ opId: op.opId, serverSeq: null });
    if (undoStack.length > 100) undoStack.shift();
    queue.push(op);
    if (!flushTimer) flushTimer = setTimeout(() => void flush(), 150);
    bump();
    return true;
  };

  const applyRemote = (serverSeq: number, op: Op) => {
    const st = get();
    if (op.projectId !== st.projectId) return;
    if (serverSeq <= st.serverSeq && sentOpIds.has(op.opId)) {
      return;
    }
    if (sentOpIds.has(op.opId)) {
      set({ serverSeq: Math.max(st.serverSeq, serverSeq) });
      return;
    }
    if (serverSeq <= st.serverSeq) return;
    const res = st.store.apply(op);
    // failures here usually mean we already have the state (e.g. after a reload); ignore quietly
    if (res.ok) bump({ serverSeq: serverSeq });
    else set({ serverSeq: serverSeq });
  };

  const catchUp = async () => {
    const st = get();
    if (!st.projectId) return;
    try {
      const ops = await api.getOps(st.projectId, st.serverSeq);
      for (const { serverSeq, op } of ops) applyRemote(serverSeq, op);
    } catch {
      /* ignore */
    }
  };

  onRealtime((msg) => {
    const st = get();
    if (msg.type === 'op') applyRemote(msg.serverSeq, msg.op);
    else if (msg.type === 'change') {
      const c = msg.change;
      if (c.nodeId && !st.store.get(c.nodeId)) return;
      const others = st.pending.filter((p) => p.id !== c.id);
      set({ pending: c.status === 'pending' ? [...others, c] : others });
    } else if (msg.type === 'batch') {
      const b = msg.batch;
      if (b.projectId !== st.projectId) return;
      const others = st.batches.filter((x) => x.id !== b.id);
      set({ batches: b.status === 'draft' ? [...others, b] : others });
      if (b.status === 'draft') toast(`Claude 提交了一份草案（新增 ${b.diff.summary.create} 个节点）`);
    }
  });
  onRealtimeOpen(() => void catchUp());

  const loadInto = async (id: string, keepUi: boolean) => {
    const mySeq = ++loadSeq;
    if (!keepUi) set({ loading: true, error: null, projectId: id, project: null, selectedId: null, editingId: null, batches: [] });
    try {
      const d = await api.getProject(id);
      if (mySeq !== loadSeq) return;
      const store = new TreeStore(d.nodes);
      const st = get();
      const selectedId = keepUi && st.selectedId && store.live(st.selectedId) ? st.selectedId : keepUi ? null : null;
      bump({
        projectId: id,
        project: d.project,
        store,
        contacts: d.contacts,
        pending: d.pendingChanges.filter((c) => c.status === 'pending'),
        dependencies: d.dependencies ?? [],
        serverSeq: d.serverSeq,
        loading: false,
        error: null,
        selectedId: keepUi ? selectedId : (d.project.rootNodeId ?? null),
        editingId: keepUi && st.editingId && store.live(st.editingId) ? st.editingId : null,
        collapsed: keepUi ? st.collapsed : new Set<string>(),
      });
      // prefer the server's schedule analysis when it sends one
      if (Array.isArray(d.criticalPath) || Array.isArray(d.slips))
        set({ ...(Array.isArray(d.criticalPath) ? { criticalPath: d.criticalPath } : {}), ...(Array.isArray(d.slips) ? { slips: d.slips } : {}) });
      // draft batches (best effort; fall back to batches referenced by pending changes)
      let found: PlanBatch[] = [];
      try {
        found = (await api.listDraftBatches(id)).filter((b) => b.status === 'draft');
      } catch {
        const batchIds = [...new Set(d.pendingChanges.map((c) => c.batchId).filter((x): x is string => !!x))];
        for (const bid of batchIds) {
          try {
            const b = await api.getBatch(bid);
            if (b.status === 'draft') found.push(b);
          } catch {
            /* ignore */
          }
        }
      }
      if (mySeq === loadSeq) set({ batches: [...get().batches.filter((b) => b.projectId !== id || found.some((f) => f.id === b.id)), ...found.filter((f) => !get().batches.some((b) => b.id === f.id))] });
    } catch (e) {
      if (mySeq !== loadSeq) return;
      set({ loading: false, error: errorMessage(e) });
    }
  };

  return {
    projectId: null,
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
    loading: false,
    error: null,
    selectedId: null,
    editingId: null,
    collapsed: new Set(),
    ownerFilter: undefined,
    search: '',
    view: 'map',
    ganttZoom: 'week',
    pendingPanelOpen: false,
    chatOpen: false,
    focusRequest: null,

    load: (id) => loadInto(id, false),
    reload: async () => {
      const id = get().projectId;
      if (id) await loadInto(id, true);
    },
    unload: () => {
      loadSeq++;
      queue = [];
      set({ projectId: null, project: null, store: new TreeStore(), derived: new Map(), selectedId: null, editingId: null, batches: [], pending: [], dependencies: [], criticalPath: [], slips: [] });
    },

    select: (id) => set({ selectedId: id, editingId: get().editingId === id ? get().editingId : null }),
    setEditing: (id) => set({ editingId: id, selectedId: id ?? get().selectedId }),
    toggleCollapse: (id) => {
      const c = new Set(get().collapsed);
      if (c.has(id)) c.delete(id);
      else c.add(id);
      set({ collapsed: c });
    },
    setOwnerFilter: (f) => set({ ownerFilter: f }),
    setSearch: (s) => set({ search: s }),
    setView: (v) => set({ view: v, editingId: null }),
    setGanttZoom: (z) => set({ ganttZoom: z }),
    setPendingPanel: (open) => set({ pendingPanelOpen: open }),
    setChatOpen: (open) => set({ chatOpen: open }),
    syncOps: catchUp,
    requestFocus: (field) => set({ focusRequest: { field, n: (get().focusRequest?.n ?? 0) + 1 } }),

    updateNode: (id, patch) => {
      const { store, projectId } = get();
      const n = store.live(id);
      if (!n || !projectId) return false;
      // drop no-op patches
      const eff: NodePatch = {};
      for (const [k, v] of Object.entries(patch) as [keyof NodePatch, unknown][]) {
        const cur = n[k];
        const same = Array.isArray(v) && Array.isArray(cur) ? v.length === cur.length && v.every((x, i) => x === cur[i]) : v === cur;
        if (!same) (eff as Record<string, unknown>)[k] = v;
      }
      if (!Object.keys(eff).length) return true;
      return dispatch({ ...opBase(projectId), type: 'update_node', nodeId: id, patch: eff, baseVersion: n.version });
    },

    createChild: (parentId, title = '') => {
      const { store, projectId, collapsed } = get();
      const parent = store.live(parentId);
      if (!parent || !projectId) return null;
      const kids = store.children(parentId);
      const rank = rankBetween(kids.length ? kids[kids.length - 1]!.rank : null, null);
      const node: NewNodeInput = { id: crypto.randomUUID(), projectId, parentId, rank, title, ownerId: parent.ownerId };
      if (collapsed.has(parentId)) {
        const c = new Set(collapsed);
        c.delete(parentId);
        set({ collapsed: c });
      }
      if (!dispatch({ ...opBase(projectId), type: 'create_node', node })) return null;
      set({ selectedId: node.id, editingId: node.id });
      return node.id;
    },

    createSibling: (id, title = '') => {
      const { store, projectId } = get();
      const n = store.live(id);
      if (!n || !projectId) return null;
      if (n.parentId === null) return get().createChild(id, title);
      const sibs = store.children(n.parentId);
      const i = sibs.findIndex((s) => s.id === id);
      const next = sibs[i + 1];
      const rank = rankBetween(n.rank, next ? next.rank : null);
      const node: NewNodeInput = { id: crypto.randomUUID(), projectId, parentId: n.parentId, rank, title, ownerId: n.ownerId };
      if (!dispatch({ ...opBase(projectId), type: 'create_node', node })) return null;
      set({ selectedId: node.id, editingId: node.id });
      return node.id;
    },

    moveNode: (id, parentId, afterId) => {
      const { store, projectId } = get();
      const n = store.live(id);
      if (!n || !projectId) return false;
      const sibs = store.children(parentId).filter((s) => s.id !== id);
      let rank: string;
      if (afterId === null) rank = rankBetween(null, sibs[0]?.rank ?? null);
      else {
        const i = sibs.findIndex((s) => s.id === afterId);
        const prev = i >= 0 ? sibs[i] : sibs[sibs.length - 1];
        const next = i >= 0 ? sibs[i + 1] : undefined;
        rank = rankBetween(prev?.rank ?? null, next?.rank ?? null);
      }
      return dispatch({ ...opBase(projectId), type: 'move_node', nodeId: id, parentId, rank, baseVersion: n.version });
    },

    deleteNode: (id) => {
      const { store, projectId, selectedId } = get();
      const n = store.live(id);
      if (!n || !projectId || n.parentId === null) return false;
      // pick the next selection before deleting
      const sibs = store.children(n.parentId);
      const i = sibs.findIndex((s) => s.id === id);
      const nextSel = sibs[i + 1]?.id ?? sibs[i - 1]?.id ?? n.parentId;
      const ok = dispatch({ ...opBase(projectId), type: 'delete_node', nodeId: id });
      if (ok && (selectedId === id || (selectedId && !store.live(selectedId)))) set({ selectedId: nextSel, editingId: null });
      return ok;
    },

    undo: async () => {
      // ensure pending ops are on the server first
      if (queue.length) {
        if (flushTimer) clearTimeout(flushTimer);
        await flush();
      }
      const entry = undoStack.pop();
      if (!entry) {
        toast('没有可撤销的操作');
        return;
      }
      if (entry.serverSeq == null) {
        toast('这条操作还没同步，稍后再试', 'error');
        return;
      }
      try {
        await api.undo(entry.serverSeq);
        toast('已撤销');
        await get().reload();
      } catch (e) {
        toast(`撤销失败：${errorMessage(e)}`, 'error');
      }
    },

    renameProject: async (name) => {
      const { projectId, project } = get();
      if (!projectId || !project || !name.trim() || name.trim() === project.name) return;
      try {
        await api.patchProject(projectId, { name: name.trim() });
        set({ project: { ...project, name: name.trim() } });
      } catch (e) {
        toast(`重命名失败：${errorMessage(e)}`, 'error');
      }
    },

    decideChanges: async (ids, decision) => {
      if (!ids.length) return;
      try {
        if (ids.length === 1) {
          if (decision === 'approve') await api.approveChange(ids[0]!);
          else await api.rejectChange(ids[0]!);
        } else await api.batchChanges(ids.map((id) => ({ id, decision })));
        set({ pending: get().pending.filter((c) => !ids.includes(c.id)) });
        toast(decision === 'approve' ? `已确认 ${ids.length} 项` : `已拒绝 ${ids.length} 项`, 'ok');
        await get().reload();
      } catch (e) {
        toast(`操作失败：${errorMessage(e)}`, 'error');
      }
    },

    applyBatch: async (id) => {
      try {
        await api.applyBatch(id);
        set({ batches: get().batches.filter((b) => b.id !== id) });
        toast('草案已应用', 'ok');
        await get().reload();
      } catch (e) {
        toast(`应用失败：${errorMessage(e)}`, 'error');
      }
    },

    discardBatch: async (id) => {
      try {
        await api.discardBatch(id);
        set({ batches: get().batches.filter((b) => b.id !== id) });
        toast('草案已丢弃');
      } catch (e) {
        toast(`丢弃失败：${errorMessage(e)}`, 'error');
      }
    },

    addDependency: async (fromNode, toNode) => {
      try {
        await api.addDependency(fromNode, toNode);
        const deps = get().dependencies.some((d) => d.fromNode === fromNode && d.toNode === toNode) ? get().dependencies : [...get().dependencies, { fromNode, toNode }];
        bump({ dependencies: deps });
        await get().reloadDependencies();
        return true;
      } catch (e) {
        toast(`添加前置失败：${errorMessage(e)}`, 'error');
        return false;
      }
    },

    removeDependency: async (fromNode, toNode) => {
      try {
        await api.removeDependency(fromNode, toNode);
        bump({ dependencies: get().dependencies.filter((d) => !(d.fromNode === fromNode && d.toNode === toNode)) });
        await get().reloadDependencies();
        return true;
      } catch (e) {
        toast(`移除前置失败：${errorMessage(e)}`, 'error');
        return false;
      }
    },

    reloadDependencies: async () => {
      const id = get().projectId;
      if (!id) return;
      try {
        const d = await api.getProject(id);
        if (get().projectId !== id) return;
        bump({ dependencies: d.dependencies ?? [] });
        if (Array.isArray(d.slips)) set({ slips: d.slips });
        if (Array.isArray(d.criticalPath)) set({ criticalPath: d.criticalPath });
      } catch {
        /* keep the optimistic list */
      }
    },

    nudge: async (nodeId) => {
      try {
        const r = await api.nudge(nodeId);
        const { store } = get();
        const cur = store.get(nodeId);
        if (cur && r.node) {
          store.nodes.set(nodeId, { ...cur, lastNudgedAt: r.node.lastNudgedAt ?? new Date().toISOString(), version: r.node.version ?? cur.version });
          bump();
        }
        return r.text;
      } catch (e) {
        toast(`催办失败：${errorMessage(e)}`, 'error');
        return null;
      }
    },
  };
});

/** Helper for components: visible (filtered) node ids given the current owner filter / search. */
export function nodeMatches(n: TNode, ownerFilter: OwnerFilter, search: string): boolean {
  if (ownerFilter !== undefined && n.ownerId !== ownerFilter) return false;
  if (search && !n.title.toLowerCase().includes(search.toLowerCase())) return false;
  return true;
}
