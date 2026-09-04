import type { Change, Contact, Dependency, Derived, KeyField, Op, Project, TNode } from '@tsai-mind/core';

export interface NotificationToggles {
  dueSoon?: boolean;
  overdue?: boolean;
  nudgeDue?: boolean;
  digest?: boolean;
}

export interface AccountSettings {
  requireConfirmation?: boolean;
  keyFields?: KeyField[];
  nudgeTemplate?: string;
  notifications?: NotificationToggles;
}

export interface Account {
  id: string;
  email: string;
  name: string;
  timezone: string;
  settings: AccountSettings;
}

export interface MePatch {
  name?: string;
  timezone?: string;
  settings?: AccountSettings;
}

export interface TokenSummary {
  id: string;
  label: string;
  kind: string;
  clientName?: string | null;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt?: string | null;
}

/** A predecessor whose due date has moved past a successor's start (server shape; core's DependencySlip carries nodes). */
export interface Slip {
  fromNode: string;
  toNode: string;
  fromDue: string;
  toStart: string;
  days: number;
}

// ---- assistant (Claude chat) ----
export interface AssistantStatus {
  configured: boolean;
  model?: string | null;
}

export interface AssistantSession {
  id: string;
  title: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface ToolCall {
  name: string;
  input: unknown;
  resultText?: string | null;
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls?: ToolCall[];
  createdAt?: string;
}

export type AssistantEvent =
  | { event: 'text'; delta: string }
  | { event: 'tool'; name: string; input: unknown; result: unknown }
  | { event: 'done'; messageId: string; text: string }
  | { event: 'error'; message: string };

export interface MeResponse {
  account: Account;
  scopes: string[];
}

export interface ProjectRow extends Project {
  overdueCount: number;
  pendingCount: number;
  /** number of slipped dependencies, when the server sends it */
  slipCount?: number;
}

export interface ProjectDetail {
  project: Project;
  nodes: TNode[];
  contacts: Contact[];
  pendingChanges: Change[];
  dependencies: Dependency[];
  serverSeq: number;
  criticalPath?: string[];
  slips?: Slip[];
}

export interface CreateProjectResponse {
  project: Project;
  nodes: TNode[];
  warnings: { lineNo: number; message: string }[];
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
  /** the server sends `actor`; older drafts of the contract called it `actorType` */
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

/** The server returns the sections flat next to `today: <ISO date>`; an earlier contract nested them under `today`. Both are accepted. */
export type TodayResponse = (TodaySections & { today: string; pending: PendingChange[] }) | { today: TodaySections; pending: PendingChange[] };

export function todaySections(r: TodayResponse): TodaySections {
  if (typeof r.today === 'object' && r.today !== null) return r.today;
  const flat = r as TodaySections;
  return { overdue: flat.overdue ?? [], dueToday: flat.dueToday ?? [], dueTomorrow: flat.dueTomorrow ?? [], nudgeDue: flat.nudgeDue ?? [] };
}

export interface ContactNodeEntry {
  node: TNode;
  derived: Derived;
  path: string[];
  projectId: string;
  projectName: string;
}

export interface NudgeResponse {
  text: string;
  node: TNode;
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
  | { type: 'batch'; batch: PlanBatch };
