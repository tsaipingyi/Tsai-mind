import type { Change, ISODate, TNode } from './types.js';
import type { TreeStore } from './store.js';
import type { Derived } from './rollup.js';
import { addDays, daysBetween } from './dates.js';

export interface TodayItem {
  node: TNode;
  derived: Derived;
  path: string[];
  daysOverdue: number;
}

export interface TodayView {
  overdue: TodayItem[];
  dueToday: TodayItem[];
  dueTomorrow: TodayItem[];
  pending: Change[];
  /** Overdue nodes with an owner that have not been nudged recently. */
  nudgeDue: TodayItem[];
}

export interface TodayOptions {
  today: ISODate;
  /** Overdue at least this many days AND not nudged within this many days. */
  nudgeAfterDays?: number;
}

/** Leaf-level view: only nodes without counting children are listed, so parents don't duplicate their children. */
export function computeToday(
  store: TreeStore,
  derived: Map<string, Derived>,
  pending: Change[],
  opts: TodayOptions,
): TodayView {
  const nudgeAfter = opts.nudgeAfterDays ?? 3;
  const tomorrow = addDays(opts.today, 1);
  const overdue: TodayItem[] = [];
  const dueToday: TodayItem[] = [];
  const dueTomorrow: TodayItem[] = [];
  const nudgeDue: TodayItem[] = [];

  for (const n of store.all()) {
    const d = derived.get(n.id);
    if (!d || d.hasChildren || n.kind === 'note' || d.status === 'done' || !d.dueDate) continue;
    const item: TodayItem = { node: n, derived: d, path: store.path(n.id), daysOverdue: daysBetween(d.dueDate, opts.today) };
    if (d.dueDate < opts.today) {
      overdue.push(item);
      if (n.ownerId && item.daysOverdue >= nudgeAfter) {
        const lastNudge = n.lastNudgedAt ? n.lastNudgedAt.slice(0, 10) : null;
        if (!lastNudge || daysBetween(lastNudge, opts.today) >= nudgeAfter) nudgeDue.push(item);
      }
    } else if (d.dueDate === opts.today) dueToday.push(item);
    else if (d.dueDate === tomorrow) dueTomorrow.push(item);
  }

  const byDue = (a: TodayItem, b: TodayItem) => (a.derived.dueDate! < b.derived.dueDate! ? -1 : 1);
  overdue.sort(byDue);
  nudgeDue.sort(byDue);
  const byPriority = (a: TodayItem, b: TodayItem) => a.node.priority - b.node.priority;
  dueToday.sort(byPriority);
  dueTomorrow.sort(byPriority);

  return { overdue, dueToday, dueTomorrow, pending: pending.filter((c) => c.status === 'pending'), nudgeDue };
}
