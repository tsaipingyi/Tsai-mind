import type { Change, Contact, Project, TNode } from '@tsai-mind/core';

type Row = Record<string, unknown>;

function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export function rowToNode(r: Row): TNode {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    parentId: (r.parent_id as string | null) ?? null,
    rank: r.rank as string,
    title: r.title as string,
    description: r.description as string,
    kind: r.kind as TNode['kind'],
    ownerId: (r.owner_id as string | null) ?? null,
    status: r.status as TNode['status'],
    progress: Number(r.progress),
    progressMode: r.progress_mode as TNode['progressMode'],
    startDate: (r.start_date as string | null) ?? null,
    dueDate: (r.due_date as string | null) ?? null,
    dateMode: r.date_mode as TNode['dateMode'],
    estimateHours: r.estimate_hours == null ? null : Number(r.estimate_hours),
    priority: Number(r.priority) as TNode['priority'],
    tags: (r.tags as string[]) ?? [],
    lastNudgedAt: iso(r.last_nudged_at),
    version: Number(r.version),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    deletedAt: iso(r.deleted_at),
  };
}

export function nodeToRow(n: TNode): Row {
  return {
    id: n.id,
    project_id: n.projectId,
    parent_id: n.parentId,
    rank: n.rank,
    title: n.title,
    description: n.description,
    kind: n.kind,
    owner_id: n.ownerId,
    status: n.status,
    progress: n.progress,
    progress_mode: n.progressMode,
    start_date: n.startDate,
    due_date: n.dueDate,
    date_mode: n.dateMode,
    estimate_hours: n.estimateHours,
    priority: n.priority,
    tags: n.tags,
    last_nudged_at: n.lastNudgedAt,
    version: n.version,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    deleted_at: n.deletedAt,
  };
}

export const NODE_COLUMNS = [
  'id', 'project_id', 'parent_id', 'rank', 'title', 'description', 'kind', 'owner_id', 'status', 'progress',
  'progress_mode', 'start_date', 'due_date', 'date_mode', 'estimate_hours', 'priority', 'tags', 'last_nudged_at',
  'version', 'created_at', 'updated_at', 'deleted_at',
] as const;

export function rowToContact(r: Row): Contact & { avatarUrl: string | null; createdAt: string } {
  return {
    id: r.id as string,
    name: r.name as string,
    company: (r.company as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    avatarUrl: (r.avatar_url as string | null) ?? null,
    archivedAt: iso(r.archived_at),
    createdAt: iso(r.created_at)!,
  };
}

export function rowToProject(r: Row): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    rootNodeId: r.root_node_id as string,
    createdAt: iso(r.created_at)!,
    archivedAt: iso(r.archived_at),
  };
}

export function rowToChange(r: Row): Change {
  return {
    id: r.id as string,
    nodeId: r.node_id as string,
    field: r.field as string,
    oldValue: r.old_value,
    newValue: r.new_value,
    reason: (r.reason as string | null) ?? null,
    source: r.source as Change['source'],
    batchId: (r.batch_id as string | null) ?? null,
    status: r.status as Change['status'],
    decidedAt: iso(r.decided_at),
    createdAt: iso(r.created_at)!,
    expiresAt: iso(r.expires_at)!,
  };
}

export interface ActivityRow {
  id: number;
  projectId: string;
  nodeId: string | null;
  actor: string;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export function rowToActivity(r: Row): ActivityRow {
  return {
    id: Number(r.id),
    projectId: r.project_id as string,
    nodeId: (r.node_id as string | null) ?? null,
    actor: r.actor_type as string,
    kind: r.kind as string,
    payload: r.payload,
    createdAt: iso(r.created_at)!,
  };
}

export interface PlanBatchRow {
  id: string;
  projectId: string;
  parentId: string;
  mode: 'append' | 'sync' | 'replace';
  outline: string;
  diff: unknown;
  status: 'draft' | 'applied' | 'discarded';
  appliedAt: string | null;
  result: unknown;
  createdAt: string;
}

export function rowToPlanBatch(r: Row): PlanBatchRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    parentId: r.parent_id as string,
    mode: r.mode as PlanBatchRow['mode'],
    outline: r.outline as string,
    diff: r.diff,
    status: r.status as PlanBatchRow['status'],
    appliedAt: iso(r.applied_at),
    result: r.result ?? null,
    createdAt: iso(r.created_at)!,
  };
}

export interface NoteRow {
  id: string;
  nodeId: string;
  body: string;
  actor: string;
  createdAt: string;
}

export function rowToNote(r: Row): NoteRow {
  return { id: r.id as string, nodeId: r.node_id as string, body: r.body as string, actor: r.actor_type as string, createdAt: iso(r.created_at)! };
}
