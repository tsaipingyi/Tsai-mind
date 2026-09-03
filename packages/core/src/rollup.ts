import type { ISODate, NodeStatus, TNode } from './types.js';
import type { TreeStore } from './store.js';

export interface Derived {
  progress: number;
  startDate: ISODate | null;
  dueDate: ISODate | null;
  status: NodeStatus;
  /** True when this node's progress/date/status came from children. */
  hasChildren: boolean;
  /** Count of live descendants that participate in rollup. */
  leafCount: number;
  doneLeafCount: number;
}

function countsForRollup(n: TNode): boolean {
  return n.kind !== 'note';
}

/**
 * Compute derived progress, dates and status for every live node.
 * Stored values are never modified; parents with counting children get
 * rolled-up values according to progressMode / dateMode.
 */
export function computeRollup(store: TreeStore): Map<string, Derived> {
  const out = new Map<string, Derived>();

  const visit = (n: TNode): Derived => {
    const kids = store.children(n.id).filter(countsForRollup);
    const kidDerived = kids.map(visit);
    // children of kind note still get their own derived entries
    for (const note of store.children(n.id).filter((c) => !countsForRollup(c))) visit(note);

    let d: Derived;
    if (kidDerived.length === 0) {
      d = {
        progress: n.status === 'done' ? 100 : n.progress,
        startDate: n.startDate,
        dueDate: n.dueDate,
        status: n.status,
        hasChildren: false,
        leafCount: countsForRollup(n) ? 1 : 0,
        doneLeafCount: countsForRollup(n) && n.status === 'done' ? 1 : 0,
      };
    } else {
      let progress: number;
      if (n.progressMode === 'manual') {
        progress = n.status === 'done' ? 100 : n.progress;
      } else {
        let wsum = 0;
        let acc = 0;
        kids.forEach((k, i) => {
          const w = k.estimateHours != null && k.estimateHours > 0 ? k.estimateHours : 1;
          wsum += w;
          acc += kidDerived[i]!.progress * w;
        });
        progress = wsum > 0 ? Math.round(acc / wsum) : 0;
      }

      let startDate = n.startDate;
      let dueDate = n.dueDate;
      if (n.dateMode === 'auto') {
        const starts = kidDerived.map((k) => k.startDate).filter((x): x is string => x != null);
        const dues = kidDerived.map((k) => k.dueDate).filter((x): x is string => x != null);
        if (starts.length) startDate = starts.reduce((a, b) => (a < b ? a : b));
        if (dues.length) dueDate = dues.reduce((a, b) => (a > b ? a : b));
      }

      const statuses = kidDerived.map((k) => k.status);
      let status: NodeStatus;
      if (statuses.every((s) => s === 'done')) status = 'done';
      else if (statuses.some((s) => s === 'blocked')) status = 'blocked';
      else if (statuses.some((s) => s === 'in_progress' || s === 'waiting' || s === 'done')) status = 'in_progress';
      else status = 'todo';

      d = {
        progress: status === 'done' ? 100 : progress,
        startDate,
        dueDate,
        status,
        hasChildren: true,
        leafCount: kidDerived.reduce((a, k) => a + k.leafCount, 0),
        doneLeafCount: kidDerived.reduce((a, k) => a + k.doneLeafCount, 0),
      };
    }
    out.set(n.id, d);
    return d;
  };

  for (const r of store.children(null)) visit(r);
  return out;
}

export function isOverdue(d: Derived, today: ISODate): boolean {
  return d.status !== 'done' && d.dueDate != null && d.dueDate < today;
}
