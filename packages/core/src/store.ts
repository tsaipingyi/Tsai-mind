import type { NewNodeInput, NodePatch, Op, TNode } from './types.js';
import { PATCHABLE_FIELDS } from './types.js';
import { compareRank } from './rank.js';

export type ApplyError = 'not_found' | 'version_conflict' | 'cycle' | 'invalid' | 'deleted';

export type ApplyResult =
  | { ok: true; changed: TNode[] }
  | { ok: false; error: ApplyError; message: string; current?: TNode };

export function nodeDefaults(input: NewNodeInput, now: string): TNode {
  return {
    id: input.id,
    projectId: input.projectId,
    parentId: input.parentId,
    rank: input.rank,
    title: input.title,
    description: input.description ?? '',
    kind: input.kind ?? 'task',
    ownerId: input.ownerId ?? null,
    status: input.status ?? 'todo',
    progress: input.progress ?? 0,
    progressMode: input.progressMode ?? 'auto',
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    dateMode: input.dateMode ?? 'auto',
    estimateHours: input.estimateHours ?? null,
    priority: input.priority ?? 3,
    tags: input.tags ?? [],
    lastNudgedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function validatePatch(patch: NodePatch): string | null {
  for (const key of Object.keys(patch)) {
    if (!(PATCHABLE_FIELDS as readonly string[]).includes(key)) return `unknown field: ${key}`;
  }
  if (patch.progress !== undefined && (patch.progress < 0 || patch.progress > 100 || !Number.isFinite(patch.progress)))
    return 'progress must be 0..100';
  if (patch.priority !== undefined && ![1, 2, 3, 4].includes(patch.priority)) return 'priority must be 1..4';
  if (patch.title !== undefined && typeof patch.title !== 'string') return 'title must be a string';
  return null;
}

/**
 * In-memory tree of one project. Pure: apply() mutates only this store.
 * Deleted nodes stay in the map with deletedAt set so they can be restored.
 */
export class TreeStore {
  readonly nodes = new Map<string, TNode>();

  constructor(nodes: Iterable<TNode> = []) {
    for (const n of nodes) this.nodes.set(n.id, { ...n, tags: [...n.tags] });
  }

  get(id: string): TNode | undefined {
    return this.nodes.get(id);
  }

  /** Live (non-deleted) node or undefined. */
  live(id: string): TNode | undefined {
    const n = this.nodes.get(id);
    return n && !n.deletedAt ? n : undefined;
  }

  all(): TNode[] {
    return [...this.nodes.values()].filter((n) => !n.deletedAt);
  }

  root(): TNode | undefined {
    return this.all().find((n) => n.parentId === null);
  }

  children(id: string | null): TNode[] {
    return this.all()
      .filter((n) => n.parentId === id)
      .sort((a, b) => compareRank(a.rank, b.rank));
  }

  /** Live descendants in depth-first, rank order (not including the node itself). */
  descendants(id: string): TNode[] {
    const out: TNode[] = [];
    const walk = (pid: string) => {
      for (const c of this.children(pid)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }

  ancestors(id: string): TNode[] {
    const out: TNode[] = [];
    let cur = this.nodes.get(id);
    while (cur && cur.parentId) {
      const p = this.nodes.get(cur.parentId);
      if (!p) break;
      out.push(p);
      cur = p;
    }
    return out;
  }

  path(id: string): string[] {
    return this.ancestors(id)
      .reverse()
      .map((n) => n.title);
  }

  isDescendant(id: string, ancestorId: string): boolean {
    let cur = this.nodes.get(id);
    while (cur && cur.parentId) {
      if (cur.parentId === ancestorId) return true;
      cur = this.nodes.get(cur.parentId);
    }
    return false;
  }

  apply(op: Op, now: string = op.at): ApplyResult {
    switch (op.type) {
      case 'create_node': {
        if (this.nodes.has(op.node.id)) return { ok: false, error: 'invalid', message: 'node id already exists' };
        if (op.node.parentId !== null && !this.live(op.node.parentId))
          return { ok: false, error: 'not_found', message: 'parent not found' };
        const patchErr = validatePatch(stripToPatch(op.node));
        if (patchErr) return { ok: false, error: 'invalid', message: patchErr };
        const n = nodeDefaults(op.node, now);
        this.nodes.set(n.id, n);
        return { ok: true, changed: [n] };
      }
      case 'update_node': {
        const n = this.live(op.nodeId);
        if (!n) return { ok: false, error: 'not_found', message: 'node not found' };
        if (op.baseVersion !== undefined && op.baseVersion !== n.version)
          return { ok: false, error: 'version_conflict', message: `expected version ${op.baseVersion}, have ${n.version}`, current: n };
        const err = validatePatch(op.patch);
        if (err) return { ok: false, error: 'invalid', message: err };
        const next: TNode = { ...n, ...op.patch, version: n.version + 1, updatedAt: now };
        if (op.patch.tags) next.tags = [...op.patch.tags];
        if (op.patch.status === 'done' && n.status !== 'done') next.progress = 100;
        this.nodes.set(n.id, next);
        return { ok: true, changed: [next] };
      }
      case 'move_node': {
        const n = this.live(op.nodeId);
        if (!n) return { ok: false, error: 'not_found', message: 'node not found' };
        if (n.parentId === null) return { ok: false, error: 'invalid', message: 'cannot move the root node' };
        if (op.baseVersion !== undefined && op.baseVersion !== n.version)
          return { ok: false, error: 'version_conflict', message: `expected version ${op.baseVersion}, have ${n.version}`, current: n };
        if (!this.live(op.parentId)) return { ok: false, error: 'not_found', message: 'new parent not found' };
        if (op.parentId === n.id || this.isDescendant(op.parentId, n.id))
          return { ok: false, error: 'cycle', message: 'cannot move a node under itself' };
        const next: TNode = { ...n, parentId: op.parentId, rank: op.rank, version: n.version + 1, updatedAt: now };
        this.nodes.set(n.id, next);
        return { ok: true, changed: [next] };
      }
      case 'delete_node': {
        const n = this.live(op.nodeId);
        if (!n) return { ok: false, error: 'not_found', message: 'node not found' };
        if (n.parentId === null) return { ok: false, error: 'invalid', message: 'cannot delete the root node' };
        const changed: TNode[] = [];
        for (const d of [n, ...this.descendants(n.id)]) {
          const next: TNode = { ...d, deletedAt: now, version: d.version + 1, updatedAt: now };
          this.nodes.set(d.id, next);
          changed.push(next);
        }
        return { ok: true, changed };
      }
      case 'restore_node': {
        const n = this.nodes.get(op.nodeId);
        if (!n) return { ok: false, error: 'not_found', message: 'node not found' };
        if (!n.deletedAt) return { ok: false, error: 'invalid', message: 'node is not deleted' };
        if (n.parentId !== null && !this.live(n.parentId))
          return { ok: false, error: 'invalid', message: 'parent is deleted; restore it first' };
        const stamp = n.deletedAt;
        const changed: TNode[] = [];
        const restore = (id: string) => {
          const cur = this.nodes.get(id)!;
          const next: TNode = { ...cur, deletedAt: null, version: cur.version + 1, updatedAt: now };
          this.nodes.set(id, next);
          changed.push(next);
          for (const c of this.nodes.values()) {
            if (c.parentId === id && c.deletedAt === stamp) restore(c.id);
          }
        };
        restore(n.id);
        return { ok: true, changed };
      }
    }
  }

  /**
   * Build the op that undoes `op`, given the store state BEFORE `op` is applied.
   * Returns null when the op cannot be inverted (e.g. target missing).
   */
  inverseOf(op: Op): Op | null {
    const base = { opId: op.opId + ':undo', clientId: op.clientId, projectId: op.projectId, actor: op.actor, at: op.at };
    switch (op.type) {
      case 'create_node':
        return { ...base, type: 'delete_node', nodeId: op.node.id };
      case 'update_node': {
        const n = this.live(op.nodeId);
        if (!n) return null;
        const patch: NodePatch = {};
        for (const k of Object.keys(op.patch) as (keyof NodePatch)[]) {
          (patch as Record<string, unknown>)[k] = n[k];
        }
        if (op.patch.status === 'done' && n.status !== 'done') patch.progress = n.progress;
        return { ...base, type: 'update_node', nodeId: op.nodeId, patch };
      }
      case 'move_node': {
        const n = this.live(op.nodeId);
        if (!n || n.parentId === null) return null;
        return { ...base, type: 'move_node', nodeId: op.nodeId, parentId: n.parentId, rank: n.rank };
      }
      case 'delete_node':
        return { ...base, type: 'restore_node', nodeId: op.nodeId };
      case 'restore_node':
        return { ...base, type: 'delete_node', nodeId: op.nodeId };
    }
  }
}

function stripToPatch(input: NewNodeInput): NodePatch {
  const p: NodePatch = {};
  for (const k of PATCHABLE_FIELDS) {
    const v = (input as unknown as Record<string, unknown>)[k];
    if (v !== undefined) (p as Record<string, unknown>)[k] = v;
  }
  return p;
}
