import { addDays, daysBetween } from '@tsai-mind/core';
import type { Derived, ISODate, TNode, TreeStore } from '@tsai-mind/core';
import type { GanttZoom } from '../state/project';

export const ROW_H = 32;
export const HEADER_H = 44;
export const LEFT_W = 300;
export const DAY_W: Record<GanttZoom, number> = { day: 36, week: 16, month: 6 };

export interface GanttRow {
  node: TNode;
  depth: number;
  childCount: number;
  derived: Derived | undefined;
  /** effective start (falls back to due when only one date is set) */
  start: ISODate | null;
  due: ISODate | null;
  isParent: boolean;
  milestone: boolean;
  critical: boolean;
}

export interface Tick {
  x: number;
  label: string;
  /** week starts get a stronger line */
  major: boolean;
}

export interface MonthBand {
  x: number;
  w: number;
  label: string;
}

export interface GanttScale {
  zoom: GanttZoom;
  rangeStart: ISODate;
  rangeEnd: ISODate;
  days: number;
  dayW: number;
  width: number;
  today: ISODate;
  todayX: number;
  ticks: Tick[];
  months: MonthBand[];
  x: (date: ISODate) => number;
  dateAt: (x: number) => ISODate;
}

/** Rows in outline order, honouring collapse state; when `visible` is given only those ids (and their ancestors) are kept. */
export function buildRows(
  store: TreeStore,
  derived: Map<string, Derived>,
  collapsed: Set<string>,
  criticalPath: readonly string[],
  visible?: Set<string>,
): GanttRow[] {
  const out: GanttRow[] = [];
  const crit = new Set(criticalPath);
  const walk = (n: TNode, depth: number) => {
    if (visible && !visible.has(n.id)) return;
    const kids = store.children(n.id);
    const d = derived.get(n.id);
    const rawStart = d?.startDate ?? n.startDate;
    const rawDue = d?.dueDate ?? n.dueDate;
    const milestone = n.kind === 'milestone';
    const due = rawDue ?? rawStart;
    const start = milestone ? due : (rawStart ?? rawDue);
    out.push({ node: n, depth, childCount: kids.length, derived: d, start, due, isParent: !!d?.hasChildren, milestone, critical: crit.has(n.id) });
    if (!collapsed.has(n.id)) for (const k of kids) walk(k, depth + 1);
  };
  const root = store.root();
  if (root) walk(root, 0);
  return out;
}

/** Ids that pass a predicate plus all their ancestors (so filtered views keep the tree shape). */
export function withAncestors(store: TreeStore, matches: (n: TNode) => boolean): Set<string> {
  const keep = new Set<string>();
  for (const n of store.all()) {
    if (!matches(n)) continue;
    keep.add(n.id);
    for (const a of store.ancestors(n.id)) keep.add(a.id);
  }
  return keep;
}

function mondayOnOrBefore(iso: ISODate): ISODate {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((dow + 6) % 7));
}

export function buildScale(rows: readonly GanttRow[], zoom: GanttZoom, today: ISODate, opts: { minDays?: number } = {}): GanttScale {
  const dayW = DAY_W[zoom];
  let min = today;
  let max = today;
  for (const r of rows) {
    if (r.start && r.start < min) min = r.start;
    if (r.due && r.due > max) max = r.due;
  }
  const padBefore = zoom === 'day' ? 3 : 7;
  const padAfter = zoom === 'day' ? 7 : 21;
  let rangeStart = mondayOnOrBefore(addDays(min, -padBefore));
  let rangeEnd = addDays(max, padAfter);
  const minDays = opts.minDays ?? (zoom === 'day' ? 28 : zoom === 'week' ? 84 : 180);
  if (daysBetween(rangeStart, rangeEnd) < minDays) rangeEnd = addDays(rangeStart, minDays);
  // end on a Sunday so the last week is whole
  rangeEnd = addDays(mondayOnOrBefore(rangeEnd), 6);
  const days = daysBetween(rangeStart, rangeEnd) + 1;
  const x = (date: ISODate) => daysBetween(rangeStart, date) * dayW;
  const dateAt = (px: number) => addDays(rangeStart, Math.max(0, Math.min(days - 1, Math.floor(px / dayW))));

  const ticks: Tick[] = [];
  const months: MonthBand[] = [];
  let monthStart = 0;
  let curMonth = rangeStart.slice(0, 7);
  for (let i = 0; i < days; i++) {
    const iso = addDays(rangeStart, i);
    const [, m, d] = iso.split('-').map(Number) as [number, number, number];
    const isMonday = i % 7 === 0;
    if (zoom === 'day') ticks.push({ x: i * dayW, label: isMonday ? `${m}/${d}` : String(d), major: isMonday });
    else if (isMonday) ticks.push({ x: i * dayW, label: `${m}/${d}`, major: true });
    const ym = iso.slice(0, 7);
    if (ym !== curMonth) {
      months.push({ x: monthStart * dayW, w: (i - monthStart) * dayW, label: monthLabel(curMonth) });
      curMonth = ym;
      monthStart = i;
    }
  }
  months.push({ x: monthStart * dayW, w: (days - monthStart) * dayW, label: monthLabel(curMonth) });
  if (months.length && months[0]) months[0].label = `${Number(rangeStart.slice(0, 4))}年${months[0].label}`;

  return { zoom, rangeStart, rangeEnd, days, dayW, width: days * dayW, today, todayX: x(today), ticks, months, x, dateAt };
}

function monthLabel(ym: string): string {
  return `${Number(ym.slice(5, 7))}月`;
}

/** Path for an elbow arrow from the end of one bar to the start of another (coordinates in body space). */
export function dependencyPath(x1: number, y1: number, x2: number, y2: number): string {
  const stub = 10;
  if (x2 >= x1 + 2 * stub) {
    const mx = x1 + stub;
    return `M ${x1} ${y1} H ${mx} V ${y2} H ${x2}`;
  }
  // successor starts before predecessor ends: route around
  const half = y2 > y1 ? ROW_H / 2 : -ROW_H / 2;
  return `M ${x1} ${y1} H ${x1 + stub} V ${y1 + half} H ${x2 - stub} V ${y2} H ${x2}`;
}
