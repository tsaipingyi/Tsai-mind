import { daysBetween, shortDate, toISODate } from '@tsai-mind/core';
export { daysBetween };
import type { Contact, ISODate, NodeStatus, TNode } from '@tsai-mind/core';

export const STATUS_LABEL: Record<NodeStatus, string> = {
  todo: '待办',
  in_progress: '进行中',
  blocked: '受阻',
  waiting: '等待中',
  done: '完成',
};

export const KIND_LABEL: Record<TNode['kind'], string> = {
  goal: '目标',
  task: '任务',
  milestone: '里程碑',
  note: '备注',
};

export const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  description: '描述',
  kind: '类型',
  ownerId: '负责人',
  status: '状态',
  progress: '进度',
  progressMode: '进度模式',
  startDate: '开始日',
  dueDate: '截止日',
  dateMode: '日期模式',
  estimateHours: '预估工时',
  priority: '优先级',
  tags: '标签',
  delete: '删除',
  status_done: '标记完成',
};

export function today(): ISODate {
  return toISODate(new Date());
}

export function fmtDate(iso: ISODate | null | undefined): string {
  if (!iso) return '';
  return shortDate(iso, new Date().getFullYear());
}

/** 「周五」for a date. */
export function weekdayLabel(iso: ISODate): string {
  return `周${'日一二三四五六'[isoToDate(iso).getDay()]}`;
}

/** 「9月4日 周五」— the date shown beside the 今天 title. */
export function longDate(iso: ISODate): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${m}月${d}日 ${weekdayLabel(iso)}`;
}

export function fmtRange(start: ISODate | null, due: ISODate | null): string {
  if (start && due && start !== due) return `${fmtDate(start)}–${fmtDate(due)}`;
  if (due) return fmtDate(due);
  if (start) return `${fmtDate(start)}–`;
  return '';
}

export function contactName(contacts: Contact[], id: string | null | undefined): string {
  if (id === null || id === undefined) return '我';
  return contacts.find((c) => c.id === id)?.name ?? '?';
}

export function initial(name: string): string {
  const s = name.trim();
  return s ? s.slice(0, 1).toUpperCase() : '?';
}

/** "3 天前" / "刚刚" for timestamps; used for 上次催办 and activity. */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = daysBetween(toISODate(d), today());
  if (days <= 0) {
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    return `${Math.round(mins / 60)} 小时前`;
  }
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return toISODate(d);
}

export function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, daysBetween(toISODate(d), today()));
}

export function valueLabel(field: string, v: unknown, contacts: Contact[]): string {
  if (v === null || v === undefined || v === '') return '空';
  if (field === 'ownerId') return contactName(contacts, String(v));
  if (field === 'status') return STATUS_LABEL[v as NodeStatus] ?? String(v);
  if (field === 'kind') return KIND_LABEL[v as TNode['kind']] ?? String(v);
  if (field === 'dueDate' || field === 'startDate') return fmtDate(String(v));
  if (field === 'progress') return `${String(v)}%`;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

export function isISODateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function dateToISO(d: Date): ISODate {
  return toISODate(d);
}

export function isoToDate(iso: ISODate): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
