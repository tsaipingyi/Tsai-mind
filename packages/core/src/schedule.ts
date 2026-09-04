import type { Dependency, ISODate, TNode } from './types.js';
import type { TreeStore } from './store.js';
import type { Derived } from './rollup.js';

/**
 * Critical path: from the root down, always following the child with the
 * latest derived due date, until a leaf. Returns node ids root-first.
 * Ties are broken by rank order (first child wins).
 */
export function computeCriticalPath(store: TreeStore, derived: Map<string, Derived>, rootId?: string): string[] {
  const root = rootId ? store.live(rootId) : store.root();
  if (!root) return [];
  const path: string[] = [root.id];
  let cur: TNode = root;
  for (;;) {
    const kids = store.children(cur.id).filter((k) => k.kind !== 'note');
    if (kids.length === 0) break;
    let best: TNode | null = null;
    let bestDue: ISODate | null = null;
    for (const k of kids) {
      const due = derived.get(k.id)?.dueDate ?? null;
      if (due === null) continue;
      if (bestDue === null || due > bestDue) {
        best = k;
        bestDue = due;
      }
    }
    if (!best) break;
    path.push(best.id);
    cur = best;
  }
  return path;
}

export interface DependencySlip {
  from: TNode;
  to: TNode;
  /** Predecessor's derived due date. */
  fromDue: ISODate;
  /** Successor's derived start (or due when it has no start). */
  toStart: ISODate;
  days: number;
}

/**
 * Predecessors whose due date has moved past a successor's start date.
 * Done predecessors never slip; successors that are done are ignored.
 */
export function findDependencySlips(store: TreeStore, derived: Map<string, Derived>, deps: Dependency[]): DependencySlip[] {
  const out: DependencySlip[] = [];
  for (const d of deps) {
    const from = store.live(d.fromNode);
    const to = store.live(d.toNode);
    if (!from || !to) continue;
    const df = derived.get(from.id);
    const dt = derived.get(to.id);
    if (!df || !dt || df.status === 'done' || dt.status === 'done') continue;
    const fromDue = df.dueDate;
    const toStart = dt.startDate ?? dt.dueDate;
    if (!fromDue || !toStart) continue;
    if (fromDue > toStart) {
      const [ay, am, ad] = fromDue.split('-').map(Number) as [number, number, number];
      const [by, bm, bd] = toStart.split('-').map(Number) as [number, number, number];
      const days = Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
      out.push({ from, to, fromDue, toStart, days });
    }
  }
  return out;
}

/** True when `to` cannot start because a predecessor is not done. */
export function isWaitingOnDependency(nodeId: string, store: TreeStore, derived: Map<string, Derived>, deps: Dependency[]): boolean {
  return deps.some((d) => {
    if (d.toNode !== nodeId) return false;
    const from = store.live(d.fromNode);
    return !!from && derived.get(from.id)?.status !== 'done';
  });
}

/** Adding from→to would create a cycle in the dependency graph. */
export function dependencyWouldCycle(deps: Dependency[], from: string, to: string): boolean {
  if (from === to) return true;
  const next = new Map<string, string[]>();
  for (const d of deps) {
    const arr = next.get(d.toNode) ?? [];
    arr.push(d.fromNode);
    next.set(d.toNode, arr);
  }
  // is `from` reachable from `to` by following predecessors? then to→…→from and adding from→to closes a loop
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of next.get(cur) ?? []) stack.push(p);
  }
  return false;
}
