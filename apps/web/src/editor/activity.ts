import { useEffect, useState } from 'react';
import type { NodeStatus } from '@tsai-mind/core';
import { api } from '../api/client';
import type { Activity } from '../api/types';
import { FIELD_LABEL, STATUS_LABEL, fmtDate } from '../lib/util';

const activityCache = new Map<string, Activity[]>();

/**
 * The last 10 activity rows for one node (shared by the desktop sidebar and the phone node page).
 * Serves the cached project activity first, then refreshes from `GET /api/projects/:id/activity`.
 */
export function useNodeActivity(projectId: string | null, nodeId: string | undefined, version?: number, lastNudgedAt?: string | null): Activity[] {
  const [activity, setActivity] = useState<Activity[]>([]);
  useEffect(() => {
    if (!projectId || !nodeId) return;
    let cancelled = false;
    const apply = (all: Activity[]) => {
      if (cancelled) return;
      setActivity(all.filter((a) => a.nodeId === nodeId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 10));
    };
    const cached = activityCache.get(projectId);
    if (cached) apply(cached);
    api
      .getActivity(projectId)
      .then((all) => {
        activityCache.set(projectId, all);
        apply(all);
      })
      .catch(() => {
        if (!cached) apply([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, nodeId, version, lastNudgedAt]);
  return activity;
}

function fieldChange(k: string, v: unknown): string {
  const label = FIELD_LABEL[k] ?? k;
  if (k === 'status') return `${label} → ${STATUS_LABEL[v as NodeStatus] ?? String(v)}`;
  if (k === 'progress') return `${label} → ${String(v)}%`;
  if (k === 'title') return `改标题为「${String(v)}」`;
  if (k === 'description') return '改了描述';
  if (k === 'dueDate' || k === 'startDate') return `${label} → ${v ? fmtDate(String(v)) : '空'}`;
  if (k === 'lastNudgedAt') return '催办';
  return `改了${label}`;
}

export function describeActivity(a: Activity): string {
  const p = a.payload ?? {};
  const kind = a.kind;
  switch (kind) {
    case 'node_created':
    case 'create_node':
      return '创建了节点';
    case 'deleted':
    case 'delete_node':
      return typeof p.count === 'number' && p.count > 1 ? `删除了节点（含 ${p.count - 1} 个子节点）` : '删除了节点';
    case 'restored':
    case 'restore_node':
      return '恢复了节点';
    case 'moved':
    case 'move_node':
      return '移动了节点';
    case 'nudged':
    case 'nudge':
      return '催办';
    case 'undone':
      return '撤销了一步操作';
    case 'note_added':
    case 'note':
      return `备注：${String(p.body ?? '')}`;
    case 'change_proposed':
      return `提议改${FIELD_LABEL[String(p.field)] ?? String(p.field)}${p.to !== undefined ? ` → ${fieldValue(String(p.field), p.to)}` : ''}`;
    case 'change_decided':
      return p.decision === 'approve' || p.decision === 'approved' ? '确认了变更' : p.decision ? '拒绝了变更' : '处理了变更';
    case 'batch_applied':
      return '应用了草案';
    case 'dependency_added':
      return '添加了前置任务';
    case 'dependency_removed':
      return '移除了前置任务';
    case 'field_changed':
    case 'update_node':
    case 'update': {
      const fields = p.fields as Record<string, { from: unknown; to: unknown }> | undefined;
      if (fields) return Object.entries(fields).map(([k, v]) => fieldChange(k, v?.to)).join('，');
      const patch = (p.patch ?? p) as Record<string, unknown>;
      const keys = Object.keys(patch).filter((k) => k in FIELD_LABEL);
      return keys.length ? keys.map((k) => fieldChange(k, patch[k])).join('，') : '更新了节点';
    }
    default:
      return typeof p.message === 'string' ? p.message : kind;
  }
}

function fieldValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '空';
  if (field === 'status') return STATUS_LABEL[v as NodeStatus] ?? String(v);
  if (field === 'dueDate' || field === 'startDate') return fmtDate(String(v));
  return String(v);
}
