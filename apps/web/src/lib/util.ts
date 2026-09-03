import { daysBetween, shortDate, toISODate } from '@tsai-mind/core';
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

export const STATUS_COLOR: Record<NodeStatus, string> = {
  todo: 'var(--st-todo)',
  in_progress: 'var(--st-in_progress)',
  blocked: 'var(--st-blocked)',
  waiting: 'var(--st-waiting)',
  done: 'var(--st-done)',
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

export function thisYear(): number {
  return new Date().getFullYear();
}

export function fmtDate(iso: ISODate | null | undefined): string {
  if (!iso) return '';
  return shortDate(iso, thisYear());
}

export function fmtRange(start: ISODate | null, due: ISODate | null): string {
  if (start && due && start !== due) return `${fmtDate(start)}–${fmtDate(due)}`;
  if (due) return fmtDate(due);
  if (start) return `${fmtDate(start)}–`;
  return '';
}

export function initial(name: string): string {
  const s = name.trim();
  if (!s) return '?';
  // For CJK names use the last character as the "given name" hint? Keep first char: simpler and predictable.
  return s.slice(0, 1).toUpperCase();
}

export function contactName(contacts: Contact[], id: string | null): string {
  if (id === null) return '我';
  return contacts.find((c) => c.id === id)?.name ?? '?';
}

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

export function valueLabel(field: string, v: unknown, contacts: Contact[]): string {
  if (v === null || v === undefined || v === '') return '空';
  if (field === 'ownerId') return contactName(contacts, String(v));
  if (field === 'status') return STATUS_LABEL[v as NodeStatus] ?? String(v);
  if (field === 'kind') return KIND_LABEL[v as TNode['kind']] ?? String(v);
  if (field === 'dueDate' || field === 'startDate') return fmtDate(String(v));
  if (field === 'progress') return `${v}%`;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function clientId(): string {
  try {
    let id = sessionStorage.getItem('tsaimind.clientId');
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem('tsaimind.clientId', id);
    }
    return id;
  } catch {
    return 'web';
  }
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export const OUTLINE_PLACEHOLDER = `- 官网改版 9/1–10/10
  - 设计 @林 9/1–9/12 done
    - 视觉稿 @林 9/1–9/8 done
  - 开发 @王芳 9/8–9/30 in_progress 35%
    - 前端页面 @王芳 9/8–9/24 60%
    - 接口联调 @陈小明 9/15–9/30 blocked 10% ← 前端页面
  - ◆ 上线 10/10

缩进代表父子，@名字 指负责人（不写就是我），日期用 起–止 或单个日期，
状态词 todo/in_progress/blocked/waiting/done 和百分比可选，◆ 表示里程碑，← 标题 表示前置任务。`;
