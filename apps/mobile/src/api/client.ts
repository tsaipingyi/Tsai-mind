import type { Change, Contact, Op } from '@tsai-mind/core';
import type {
  Activity,
  DeviceRegistration,
  MeResponse,
  NodeDetailResponse,
  NudgeResponse,
  OpsResponse,
  PendingChange,
  PlanBatch,
  ProjectDetail,
  ProjectRow,
  TodayResponse,
} from './types';

export const DEFAULT_SERVER = 'https://tsaimind.app';

/** Connection settings are set by the session store; the client itself has no React or storage dependency. */
let baseUrl = DEFAULT_SERVER;
let token: string | null = null;

export function configure(opts: { baseUrl?: string; token?: string | null }): void {
  if (opts.baseUrl !== undefined) baseUrl = normalizeServerUrl(opts.baseUrl);
  if (opts.token !== undefined) token = opts.token;
}

export function getBaseUrl(): string {
  return baseUrl;
}

export function normalizeServerUrl(u: string): string {
  let s = u.trim();
  if (!s) return DEFAULT_SERVER;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isNetworkError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 0;
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export interface RequestOptions {
  text?: boolean;
  token?: string;
  baseUrl?: string;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const t = opts.token ?? token;
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const url = `${opts.baseUrl ? normalizeServerUrl(opts.baseUrl) : baseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'network', '无法连接服务器');
  }
  if (res.status === 401) {
    if (!opts.token) for (const fn of unauthorizedListeners) fn();
    throw new ApiError(401, 'unauthorized', '登录已失效，请重新登录');
  }
  if (!res.ok) {
    let code = 'error';
    let message = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      if (j.error) code = j.error;
      if (j.message) message = j.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  if (opts.text) return (await res.text()) as T;
  const txt = await res.text();
  return (txt ? JSON.parse(txt) : undefined) as T;
}

export const api = {
  me: (opts?: { token?: string; baseUrl?: string }) => request<MeResponse>('GET', '/api/me', undefined, opts ?? {}),

  listProjects: () => request<ProjectRow[]>('GET', '/api/projects'),
  getProject: (id: string) => request<ProjectDetail>('GET', `/api/projects/${id}`),
  getOps: (id: string, since: number) => request<{ serverSeq: number; op: Op }[]>('GET', `/api/projects/${id}/ops?since=${since}`),
  postOps: (id: string, ops: Op[]) => request<OpsResponse>('POST', `/api/projects/${id}/ops`, { ops }),
  getActivity: (id: string, since?: string) =>
    request<Activity[]>('GET', `/api/projects/${id}/activity${since ? `?since=${encodeURIComponent(since)}` : ''}`),

  today: () => request<TodayResponse>('GET', '/api/today'),
  listContacts: () => request<Contact[]>('GET', '/api/contacts'),

  pendingChanges: () => request<PendingChange[]>('GET', '/api/changes?status=pending'),
  approveChange: (id: string) => request<Change | unknown>('POST', `/api/changes/${id}/approve`),
  rejectChange: (id: string) => request<Change | unknown>('POST', `/api/changes/${id}/reject`),
  batchChanges: (decisions: { id: string; decision: 'approve' | 'reject' }[]) => request<unknown>('POST', '/api/changes/batch', { decisions }),

  nodeDetail: (nodeId: string) => request<NodeDetailResponse>('GET', `/api/nodes/${nodeId}`),
  nudge: (nodeId: string, template?: string) => request<NudgeResponse>('POST', `/api/nodes/${nodeId}/nudge`, template ? { template } : {}),
  /** Phase-2 server contract (notification actions). */
  markDone: (nodeId: string) => request<unknown>('POST', `/api/nodes/${nodeId}/done`),
  postpone: (nodeId: string, days = 1) => request<unknown>('POST', `/api/nodes/${nodeId}/postpone`, { days }),
  registerDevice: (body: DeviceRegistration) => request<unknown>('POST', '/api/devices', body),

  undo: (serverSeq: number) => request<{ results?: unknown }>('POST', `/api/ops/${serverSeq}/undo`),

  getBatch: (id: string) => request<PlanBatch>('GET', `/api/plan-batches/${id}`),
  listDraftBatches: (projectId: string) => request<PlanBatch[]>('GET', `/api/projects/${projectId}/plan-batches?status=draft`),
  applyBatch: (id: string) => request<unknown>('POST', `/api/plan-batches/${id}/apply`),
  discardBatch: (id: string) => request<unknown>('POST', `/api/plan-batches/${id}/discard`),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
