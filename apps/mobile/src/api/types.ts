// Mirror of apps/web/src/api/types.ts — the REST contract the mobile app talks to.
import type { Change, Contact, Dependency, Derived, Op, Project, TNode } from '@tsai-mind/core';

export interface Account {
  id: string;
  email: string;
  name: string;
  timezone: string;
  settings: Record<string, unknown>;
}

export interface MeResponse {
  account: Account;
  scopes: string[];
}

export interface ProjectRow extends Project {
  overdueCount: number;
  pendingCount: number;
}

export interface ProjectDetail {
  project: Project;
  nodes: TNode[];
  contacts: Contact[];
  pendingChanges: Change[];
  dependencies: Dependency[];
  serverSeq: number;
}

export interface OpResult {
  opId: string;
  ok: boolean;
  serverSeq?: number;
  error?: string;
  message?: string;
  current?: TNode;
  changeIds?: string[];
}

export interface OpsResponse {
  results: OpResult[];
  serverSeq: number;
}

export interface Activity {
  id: string | number;
  nodeId: string | null;
  actor?: 'user' | 'claude' | 'system' | string;
  actorType?: 'user' | 'claude' | 'system' | string;
  kind: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export function activityActor(a: Activity): string {
  return a.actorType ?? a.actor ?? 'user';
}

export interface TodayEntry {
  node: TNode;
  derived: Derived;
  path: string[];
  projectId: string;
  projectName: string;
  daysOverdue: number;
}

export type PendingChange = Change & { nodeTitle: string; projectId: string; projectName: string };

export interface TodaySections {
  overdue: TodayEntry[];
  dueToday: TodayEntry[];
  dueTomorrow: TodayEntry[];
  nudgeDue: TodayEntry[];
}

export type TodayResponse = (TodaySections & { today: string; pending: PendingChange[] }) | { today: TodaySections; pending: PendingChange[] };

export function todaySections(r: TodayResponse): TodaySections {
  if (typeof r.today === 'object' && r.today !== null) return r.today;
  const flat = r as TodaySections;
  return { overdue: flat.overdue ?? [], dueToday: flat.dueToday ?? [], dueTomorrow: flat.dueTomorrow ?? [], nudgeDue: flat.nudgeDue ?? [] };
}

export interface NudgeResponse {
  text: string;
  node: TNode;
}

export interface NodeDetailResponse {
  node: TNode;
  derived: Derived;
  path: string[];
  projectId: string;
  projectName: string;
  children: TNode[];
  dependsOn: { id: string; title: string }[];
  blocks: { id: string; title: string }[];
  notes: unknown[];
  activity: Activity[];
  pendingChanges: Change[];
}

export interface PlanBatch {
  id: string;
  projectId: string;
  parentId: string;
  mode: 'append' | 'sync' | 'replace';
  outline: string;
  diff: {
    ops: Op[];
    summary: { create: number; update: number; move: number; delete: number };
    created: { lineNo: number; id: string; title: string }[];
    errors: { lineNo: number; message: string }[];
  };
  status: 'draft' | 'applied' | 'discarded' | string;
}

export type RealtimeMessage =
  | { type: 'op'; serverSeq: number; op: Op }
  | { type: 'change'; change: PendingChange }
  | { type: 'batch'; batch: PlanBatch }
  | { type: 'hello'; tokenLabel?: string }
  | { type: 'pong' };

/** Contract the server agent is adding in parallel (devices + notification actions). */
export interface DeviceRegistration {
  platform: 'ios' | 'android' | 'web';
  pushToken: string;
  name?: string;
}

export type PushKind = 'change' | 'batch' | 'due' | 'nudge' | 'digest';

export interface PushData {
  kind: PushKind;
  changeId?: string;
  batchId?: string;
  nodeId?: string;
  projectId?: string;
  [k: string]: unknown;
}
