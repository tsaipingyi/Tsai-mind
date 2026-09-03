import type { Change, Contact, Op } from '@tsai-mind/core';
import type {
  Activity,
  ContactNodeEntry,
  CreateProjectResponse,
  MeResponse,
  NudgeResponse,
  OpsResponse,
  PendingChange,
  PlanBatch,
  ProjectDetail,
  ProjectRow,
  TodayResponse,
} from './types';

export const TOKEN_KEY = 'tsaimind.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
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

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

async function request<T>(method: string, path: string, body?: unknown, opts: { text?: boolean; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = opts.token ?? getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
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
  me: (token?: string) => request<MeResponse>('GET', '/api/me', undefined, token ? { token } : {}),

  listProjects: () => request<ProjectRow[]>('GET', '/api/projects'),
  createProject: (body: { name: string; outline?: string }) => request<CreateProjectResponse>('POST', '/api/projects', body),
  getProject: (id: string) => request<ProjectDetail>('GET', `/api/projects/${id}`),
  patchProject: (id: string, body: { name?: string }) => request<unknown>('PATCH', `/api/projects/${id}`, body),
  getOutline: (id: string) => request<string>('GET', `/api/projects/${id}/outline`, undefined, { text: true }),
  getOps: (id: string, since: number) => request<{ serverSeq: number; op: Op }[]>('GET', `/api/projects/${id}/ops?since=${since}`),
  postOps: (id: string, ops: Op[]) => request<OpsResponse>('POST', `/api/projects/${id}/ops`, { ops }),
  getActivity: (id: string, since?: string) =>
    request<Activity[]>('GET', `/api/projects/${id}/activity${since ? `?since=${encodeURIComponent(since)}` : ''}`),

  today: () => request<TodayResponse>('GET', '/api/today'),

  listContacts: () => request<Contact[]>('GET', '/api/contacts'),
  createContact: (body: Partial<Contact> & { name: string }) => request<Contact>('POST', '/api/contacts', body),
  patchContact: (id: string, body: Partial<Contact>) => request<Contact>('PATCH', `/api/contacts/${id}`, body),
  deleteContact: (id: string) => request<unknown>('DELETE', `/api/contacts/${id}`),
  contactNodes: (id: string) => request<ContactNodeEntry[]>('GET', `/api/contacts/${id}/nodes`),

  pendingChanges: () => request<PendingChange[]>('GET', '/api/changes?status=pending'),
  approveChange: (id: string) => request<Change | unknown>('POST', `/api/changes/${id}/approve`),
  rejectChange: (id: string) => request<Change | unknown>('POST', `/api/changes/${id}/reject`),
  batchChanges: (decisions: { id: string; decision: 'approve' | 'reject' }[]) => request<unknown>('POST', '/api/changes/batch', { decisions }),

  nudge: (nodeId: string, template?: string) => request<NudgeResponse>('POST', `/api/nodes/${nodeId}/nudge`, template ? { template } : {}),
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
