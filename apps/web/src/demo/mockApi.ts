/**
 * In-memory implementation of every `/api/*` endpoint the web app calls.
 * Behaviour comes from @tsai-mind/core exactly like the real server: one TreeStore per project,
 * ops applied through TreeStore.apply, Claude's key-field edits split with splitPatch into pending
 * changes, undo via store.inverseOf, outlines via parseOutline/planOps/serializeOutline.
 * In demo mode nothing is persisted — reloading the page rebuilds the seed. In cloud mode
 * (src/cloud) the server is seeded empty, every mutation reports the document it touched through
 * `onDirty`, whole documents are exported / imported with the *Doc methods, and the `assistant`
 * driver is swapped for one backed by the artifact's `sample` capability.
 */
import {
  DEFAULT_KEY_FIELDS,
  TreeStore,
  addDays,
  computeCriticalPath,
  computeRollup,
  computeToday,
  dependencyWouldCycle,
  findDependencySlips,
  firstRank,
  isOverdue,
  opNeedsConfirmation,
  parseOutline,
  planOps,
  serializeOutline,
  shortDate,
  splitPatch,
  toISODate,
} from '@tsai-mind/core';
import type { Actor, Change, ConfirmationSettings, Contact, Dependency, Derived, NodePatch, Op, PlanMode, Project, TNode, TodayItem } from '@tsai-mind/core';
import type { Account, AccountSettings, Activity, AssistantMessage, AssistantSession, PendingChange, PlanBatch, TokenSummary } from '../api/types';
import { buildSeed, type Seed } from './seed';

// ---------- small helpers ----------

class HttpErr extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
const notFound = (what: string) => new HttpErr(404, 'not_found', `${what} not found`);
const badRequest = (m: string) => new HttpErr(400, 'bad_request', m);

export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const nowIso = () => new Date().toISOString();
const todayIso = () => toISODate(new Date());
const year = () => new Date().getFullYear();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

interface OpResult {
  opId: string;
  ok: boolean;
  serverSeq?: number;
  error?: string;
  message?: string;
  current?: TNode;
  changeIds?: string[];
  node?: TNode;
}

interface LogEntry {
  serverSeq: number;
  op: Op;
  inverse: Op | null;
  receivedAt: string;
  undoneBy: number | null;
}

export interface ProjectState {
  project: Project;
  store: TreeStore;
  deps: Dependency[];
  log: LogEntry[];
  serverSeq: number;
  activity: Activity[];
}

/** Which persisted document a mutation touched (cloud mode listens to this). */
export type DirtyKind = 'account' | 'contacts' | 'project' | 'project-delete' | 'chat' | 'chat-delete';

/** Serialized shape of one `projects/<id>` document (cloud mode). */
export interface ProjectDoc {
  project: Project;
  nodes: TNode[];
  dependencies: Dependency[];
  changes: Change[];
  batches: PlanBatch[];
  activity: Activity[];
  opLog: LogEntry[];
  serverSeq: number;
  updatedAt: string;
}

export interface ChatDoc {
  session: AssistantSession;
  messages: AssistantMessage[];
  updatedAt: string;
}

/** What the assistant route delegates to: the scripted demo answer, or `sample` in cloud mode. */
export interface AssistantReply {
  text: string;
  toolCalls: NonNullable<AssistantMessage['toolCalls']>;
}
export interface AssistantFailure {
  message: string;
  /** partial answer that may stay on screen */
  text?: string;
  toolCalls?: AssistantReply['toolCalls'];
  /** true for a user-initiated stop: no error event */
  silent?: boolean;
}
export interface AssistantRequest {
  session: AssistantSession;
  userText: string;
  projectId: string | null;
  /** the stored conversation so far (the new user message included, last) */
  history: AssistantMessage[];
  signal: AbortSignal | null;
  emit: (event: 'text' | 'tool', data: unknown) => void;
}
export interface AssistantDriver {
  status(): Promise<{ configured: boolean; model?: string | null; message?: string }> | { configured: boolean; model?: string | null; message?: string };
  /** Resolve with the final answer; reject with an {@link AssistantFailure}. */
  reply(req: AssistantRequest): Promise<AssistantReply>;
}

const KEEP_DELETED_DAYS = 30;
const KEEP_ACTIVITY = 200;
const KEEP_OPS = 100;
const KEEP_MESSAGES = 200;

interface SlipInfo {
  fromNode: string;
  toNode: string;
  fromTitle: string;
  toTitle: string;
  fromDue: string;
  toStart: string;
  days: number;
}

const GUARDED_FIELD_NAMES = ['dueDate', 'startDate', 'ownerId', 'status'] as const;
const DEFAULT_NUDGE_TEMPLATE = '关于「{title}」，原定 {due}，现在进度 {progress}%，方便同步一下进展吗？';
const DEMO_PREFIX = '（演示回答）';

export interface MockRequest {
  method: string;
  url: string;
  body?: unknown;
  signal?: AbortSignal | null;
}

type Params = Record<string, string>;
type Handler = (p: Params, query: URLSearchParams, body: unknown, signal: AbortSignal | null) => Response | Promise<Response>;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

// ---------- the server ----------

export class DemoServer {
  readonly seededAt: string;
  private account: Account;
  private tokens: TokenSummary[];
  private contacts: Contact[];
  private projects = new Map<string, ProjectState>();
  private changes: Change[];
  private batches: PlanBatch[];
  private sessions: AssistantSession[];
  private messages: Map<string, AssistantMessage[]>;
  private actId = 1000;
  private routes: Route[] = [];
  /** Cloud mode: called after every mutation with the document it touched. */
  onDirty: ((kind: DirtyKind, id: string) => void) | null = null;
  /** Answers chat messages; the scripted demo reply unless cloud mode installs `sample`. */
  assistant: AssistantDriver;

  constructor(seed: Seed = buildSeed(todayIso()), assistant?: AssistantDriver) {
    this.seededAt = nowIso();
    this.account = seed.account;
    this.tokens = seed.tokens;
    this.contacts = seed.contacts;
    for (const p of seed.projects) {
      this.projects.set(p.project.id, { project: p.project, store: new TreeStore(p.nodes), deps: [...p.deps], log: [], serverSeq: 40, activity: [...p.activity] });
    }
    this.changes = seed.changes;
    this.batches = seed.batches;
    this.sessions = seed.sessions;
    this.messages = seed.messages;
    this.assistant = assistant ?? new ScriptedAssistant(this);
    this.defineRoutes();
  }

  private dirty(kind: DirtyKind, id: string): void {
    try {
      this.onDirty?.(kind, id);
    } catch {
      /* never let persistence break a request */
    }
  }

  // ----- persistence (cloud mode): whole-document export / import -----

  projectIds(): string[] {
    return [...this.projects.keys()];
  }
  sessionIds(): string[] {
    return this.sessions.map((s) => s.id);
  }

  exportAccountDoc(): Record<string, unknown> {
    return { account: this.account, tokens: this.tokens, updatedAt: nowIso() };
  }
  importAccountDoc(doc: Record<string, unknown>): void {
    const a = doc.account as Account | undefined;
    if (a && typeof a === 'object' && a.id) this.account = { ...a, settings: a.settings ?? {} };
    if (Array.isArray(doc.tokens)) this.tokens = doc.tokens as TokenSummary[];
  }

  exportContactsDoc(): Record<string, unknown> {
    return { contacts: this.contacts, updatedAt: nowIso() };
  }
  importContactsDoc(doc: Record<string, unknown>): void {
    if (Array.isArray(doc.contacts)) this.contacts = doc.contacts as Contact[];
  }

  exportProjectDoc(id: string): ProjectDoc | null {
    const ps = this.projects.get(id);
    if (!ps) return null;
    const cutoff = `${addDays(todayIso(), -KEEP_DELETED_DAYS)}T00:00:00.000Z`;
    const nodes = [...ps.store.nodes.values()].filter((n) => !n.deletedAt || n.deletedAt > cutoff);
    return {
      project: ps.project,
      nodes,
      dependencies: ps.deps,
      changes: this.changes.filter((c) => ps.store.get(c.nodeId)),
      batches: this.batches.filter((b) => b.projectId === id),
      activity: ps.activity.slice(-KEEP_ACTIVITY),
      opLog: ps.log.slice(-KEEP_OPS),
      serverSeq: ps.serverSeq,
      updatedAt: nowIso(),
    };
  }
  importProjectDoc(doc: ProjectDoc): void {
    const id = doc.project?.id;
    if (!id || !Array.isArray(doc.nodes)) return;
    const old = this.projects.get(id);
    const ps: ProjectState = {
      project: doc.project,
      store: new TreeStore(doc.nodes),
      deps: Array.isArray(doc.dependencies) ? doc.dependencies : [],
      log: Array.isArray(doc.opLog) ? doc.opLog : [],
      serverSeq: typeof doc.serverSeq === 'number' ? doc.serverSeq : 0,
      activity: Array.isArray(doc.activity) ? doc.activity : [],
    };
    // swap the rows that belong to this project in the global change / batch lists
    const ownsNode = (nodeId: string) => (old ? !!old.store.get(nodeId) : false) || !!ps.store.get(nodeId);
    this.changes = [...this.changes.filter((c) => !ownsNode(c.nodeId)), ...(Array.isArray(doc.changes) ? doc.changes : [])];
    this.batches = [...this.batches.filter((b) => b.projectId !== id), ...(Array.isArray(doc.batches) ? doc.batches : [])];
    for (const a of ps.activity) if (typeof a.id === 'number' && a.id >= this.actId) this.actId = a.id + 1;
    this.projects.set(id, ps);
  }
  removeProject(id: string): boolean {
    const ps = this.projects.get(id);
    if (!ps) return false;
    this.projects.delete(id);
    this.changes = this.changes.filter((c) => !ps.store.get(c.nodeId));
    this.batches = this.batches.filter((b) => b.projectId !== id);
    return true;
  }

  exportChatDoc(sessionId: string): ChatDoc | null {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return null;
    return { session: s, messages: (this.messages.get(sessionId) ?? []).slice(-KEEP_MESSAGES), updatedAt: nowIso() };
  }
  importChatDoc(doc: ChatDoc): void {
    const s = doc.session;
    if (!s || !s.id) return;
    const i = this.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) this.sessions[i] = s;
    else this.sessions.push(s);
    this.messages.set(s.id, Array.isArray(doc.messages) ? doc.messages : []);
  }
  removeChat(sessionId: string): boolean {
    const i = this.sessions.findIndex((x) => x.id === sessionId);
    if (i < 0) return false;
    this.sessions.splice(i, 1);
    this.messages.delete(sessionId);
    return true;
  }

  /** Account name / settings as the assistant instructions need them. */
  accountInfo(): Account {
    return this.account;
  }
  /** Live contacts (cloud tools). */
  liveContacts(): Contact[] {
    return this.contacts.filter((c) => !c.archivedAt);
  }

  // ----- routing -----

  private on(method: string, pattern: string, handler: Handler) {
    const keys: string[] = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/:[a-zA-Z]+/g, (k) => {
          keys.push(k.slice(1));
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, re, keys, handler });
  }

  async handle(req: MockRequest): Promise<Response> {
    const u = new URL(req.url, location.href);
    const method = (req.method || 'GET').toUpperCase();
    let body: unknown = req.body;
    if (typeof body === 'string') {
      try {
        body = body ? JSON.parse(body) : undefined;
      } catch {
        return json({ error: 'bad_request', message: 'invalid JSON body' }, 400);
      }
    }
    // a tick of latency so optimistic UI paths behave like they do against a real server
    await sleep(15);
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(u.pathname);
      if (!m) continue;
      const params: Params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      try {
        return await r.handler(params, u.searchParams, body, req.signal ?? null);
      } catch (e) {
        if (e instanceof HttpErr) return json({ error: e.code, message: e.message, ...e.extra }, e.status);
        const err = e as Error;
        return json({ error: 'internal', message: err?.message ?? String(e) }, 500);
      }
    }
    return json({ error: 'not_found', message: `no demo route for ${method} ${u.pathname}` }, 404);
  }

  private defineRoutes() {
    // account
    this.on('GET', '/api/me', () => json({ account: this.account, scopes: ['read', 'write', 'decide'] }));
    this.on('PATCH', '/api/me', (_p, _q, body) => {
      const b = (body ?? {}) as { name?: string; timezone?: string; settings?: AccountSettings };
      if (b.name !== undefined) this.account.name = String(b.name).trim() || this.account.name;
      if (b.timezone !== undefined) this.account.timezone = String(b.timezone).trim() || this.account.timezone;
      if (b.settings !== undefined) this.account.settings = { ...this.account.settings, ...b.settings };
      this.dirty('account', 'account');
      return json({ account: this.account });
    });
    this.on('GET', '/api/tokens', () => json(this.tokens));
    this.on('GET', '/api/notifications', () => json([]));

    // projects
    this.on('GET', '/api/projects', () => json(this.projectRows()));
    this.on('POST', '/api/projects', (_p, _q, body) => json(this.createProject((body ?? {}) as { name?: string; outline?: string }), 201));
    this.on('GET', '/api/projects/:id', (p) => json(this.projectDetail(this.proj(p.id!))));
    this.on('PATCH', '/api/projects/:id', (p, _q, body) => {
      const ps = this.proj(p.id!);
      const b = (body ?? {}) as { name?: string; archivedAt?: string | null };
      if (b.name !== undefined) {
        const name = String(b.name).trim();
        if (!name) throw badRequest('name must not be empty');
        ps.project = { ...ps.project, name };
      }
      if (b.archivedAt !== undefined) ps.project = { ...ps.project, archivedAt: b.archivedAt };
      this.dirty('project', ps.project.id);
      return json(ps.project);
    });
    this.on('DELETE', '/api/projects/:id', (p) => {
      if (!this.removeProject(p.id!)) throw notFound('project');
      this.dirty('project-delete', p.id!);
      return json({ ok: true });
    });
    this.on('GET', '/api/projects/:id/outline', (p) => text(this.outline(this.proj(p.id!))));
    this.on('GET', '/api/projects/:id/ops', (p, q) => {
      const since = Number(q.get('since') ?? 0);
      return json(this.proj(p.id!).log.filter((e) => e.serverSeq > since).map((e) => ({ serverSeq: e.serverSeq, op: e.op })));
    });
    this.on('POST', '/api/projects/:id/ops', (p, _q, body) => {
      const ps = this.proj(p.id!);
      const ops = ((body ?? {}) as { ops?: Op[] }).ops;
      if (!Array.isArray(ops)) throw badRequest('ops must be an array');
      const out = this.applyOps(ps, ops);
      return json({ results: out.results, serverSeq: out.serverSeq });
    });
    this.on('GET', '/api/projects/:id/activity', (p, q) => {
      const since = q.get('since');
      const rows = this.proj(p.id!)
        .activity.filter((a) => !since || a.createdAt > since)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : Number(b.id) - Number(a.id)));
      return json(rows.slice(0, 200));
    });
    this.on('GET', '/api/projects/:id/plan-batches', (p, q) => {
      const status = q.get('status') ?? 'draft';
      return json(this.batches.filter((b) => b.projectId === p.id && b.status === status));
    });
    this.on('POST', '/api/projects/:id/plan-batches', (p, _q, body) => {
      const b = (body ?? {}) as { parentId?: string; outline?: string; mode?: PlanMode };
      if (!b.parentId || !b.outline) throw badRequest('parentId and outline are required');
      return json(this.draftPlan(this.proj(p.id!), b.parentId, b.outline, b.mode ?? 'append', 'user'), 201);
    });

    // today / changes
    this.on('GET', '/api/today', () => json(this.today()));
    this.on('GET', '/api/changes', (_p, q) => {
      const status = q.get('status') ?? 'pending';
      return json(this.changes.filter((c) => c.status === status).map((c) => this.withCtx(c)));
    });
    this.on('POST', '/api/changes/batch', (_p, _q, body) => {
      const decisions = ((body ?? {}) as { decisions?: { id: string; decision: 'approve' | 'reject' }[] }).decisions ?? [];
      const results = decisions.map((d) => {
        try {
          const r = d.decision === 'approve' ? this.approveChange(d.id) : this.rejectChange(d.id);
          return { id: d.id, ok: true, change: r.change };
        } catch (e) {
          const err = e as HttpErr;
          return { id: d.id, ok: false, error: err.code ?? 'error', message: err.message };
        }
      });
      return json({ results });
    });
    this.on('POST', '/api/changes/:id/approve', (p) => json(this.approveChange(p.id!)));
    this.on('POST', '/api/changes/:id/reject', (p) => json(this.rejectChange(p.id!)));

    // nodes / ops
    this.on('POST', '/api/nodes/:id/nudge', (p, _q, body) => json(this.nudge(p.id!, ((body ?? {}) as { template?: string }).template)));
    this.on('POST', '/api/ops/:seq/undo', (p) => json(this.undo(Number(p.seq))));
    this.on('POST', '/api/dependencies', (_p, _q, body) => {
      const { from, to } = depBody(body);
      this.addDependency(from, to);
      return json({ fromNode: from, toNode: to }, 201);
    });
    this.on('DELETE', '/api/dependencies', (_p, _q, body) => {
      const { from, to } = depBody(body);
      return json({ removed: this.removeDependency(from, to) });
    });

    // contacts
    this.on('GET', '/api/contacts', (_p, q) => json(this.contacts.filter((c) => q.get('includeArchived') === 'true' || !c.archivedAt)));
    this.on('POST', '/api/contacts', (_p, _q, body) => {
      const b = (body ?? {}) as Partial<Contact>;
      const name = String(b.name ?? '').trim();
      if (!name) throw badRequest('name is required');
      return json(this.createContact({ name, company: b.company, email: b.email, phone: b.phone, notes: b.notes }), 201);
    });
    this.on('PATCH', '/api/contacts/:id', (p, _q, body) => {
      const c = this.contacts.find((x) => x.id === p.id);
      if (!c) throw notFound('contact');
      const b = (body ?? {}) as Partial<Contact>;
      if (b.name !== undefined) {
        if (!String(b.name).trim()) throw badRequest('name must not be empty');
        c.name = String(b.name).trim();
      }
      for (const k of ['company', 'email', 'phone', 'notes', 'archivedAt'] as const) if (b[k] !== undefined) (c as unknown as Record<string, unknown>)[k] = b[k];
      this.dirty('contacts', 'contacts');
      return json(c);
    });
    this.on('DELETE', '/api/contacts/:id', (p) => {
      const c = this.contacts.find((x) => x.id === p.id);
      if (!c) throw notFound('contact');
      c.archivedAt = nowIso();
      this.dirty('contacts', 'contacts');
      return json(c);
    });
    this.on('GET', '/api/contacts/:id/nodes', (p) => {
      if (!this.contacts.some((x) => x.id === p.id)) throw notFound('contact');
      return json(this.nodeRefs((n) => n.ownerId === p.id));
    });

    // plan batches
    this.on('GET', '/api/plan-batches/:id', (p) => json(this.batch(p.id!)));
    this.on('POST', '/api/plan-batches/:id/apply', (p) => json(this.applyBatch(p.id!)));
    this.on('POST', '/api/plan-batches/:id/discard', (p) => {
      const b = this.batch(p.id!);
      if (b.status !== 'draft') throw new HttpErr(409, 'not_draft', `plan batch is ${b.status}`);
      b.status = 'discarded';
      this.dirty('project', b.projectId);
      return json(b);
    });

    // assistant
    this.on('GET', '/api/assistant/status', async () => json(await this.assistant.status()));
    this.on('GET', '/api/assistant/sessions', (_p, q) => {
      const pid = q.get('projectId');
      const list = this.sessions.filter((s) => !pid || s.projectId === pid).sort((a, b) => ((a.updatedAt ?? a.createdAt) < (b.updatedAt ?? b.createdAt) ? 1 : -1));
      return json(list);
    });
    this.on('POST', '/api/assistant/sessions', (_p, _q, body) => {
      const b = (body ?? {}) as { projectId?: string | null; title?: string };
      const s: AssistantSession = { id: newId(), title: b.title ?? null, projectId: b.projectId ?? null, createdAt: nowIso(), updatedAt: nowIso() };
      this.sessions.unshift(s);
      this.messages.set(s.id, []);
      this.dirty('chat', s.id);
      return json(s, 201);
    });
    this.on('GET', '/api/assistant/sessions/:id', (p) => {
      const s = this.sessions.find((x) => x.id === p.id);
      if (!s) throw notFound('session');
      return json({ session: s, messages: this.messages.get(s.id) ?? [] });
    });
    this.on('DELETE', '/api/assistant/sessions/:id', (p) => {
      const i = this.sessions.findIndex((x) => x.id === p.id);
      if (i < 0) throw notFound('session');
      this.sessions.splice(i, 1);
      this.messages.delete(p.id!);
      this.dirty('chat-delete', p.id!);
      return json({ ok: true });
    });
    this.on('POST', '/api/assistant/sessions/:id/messages', (p, _q, body, signal) => {
      const s = this.sessions.find((x) => x.id === p.id);
      if (!s) throw notFound('session');
      const b = (body ?? {}) as { text?: string; projectId?: string | null };
      const t = String(b.text ?? '').trim();
      if (!t) throw badRequest('text is required');
      return this.streamReply(s, t, b.projectId ?? s.projectId, signal);
    });
  }

  // ----- lookups -----

  proj(id: string): ProjectState {
    const ps = this.projects.get(id);
    if (!ps) throw notFound('project');
    return ps;
  }

  locate(nodeId: string): { ps: ProjectState; node: TNode } {
    for (const ps of this.projects.values()) {
      const node = ps.store.live(nodeId);
      if (node) return { ps, node };
    }
    throw notFound('node');
  }

  private batch(id: string): PlanBatch {
    const b = this.batches.find((x) => x.id === id);
    if (!b) throw notFound('plan batch');
    return b;
  }

  private settings(): ConfirmationSettings {
    const s = this.account.settings ?? {};
    return { requireConfirmation: s.requireConfirmation ?? true, keyFields: s.keyFields ?? DEFAULT_KEY_FIELDS };
  }

  withCtx(c: Change): PendingChange {
    for (const ps of this.projects.values()) {
      const n = ps.store.get(c.nodeId);
      if (n) return { ...c, nodeTitle: n.title, projectId: ps.project.id, projectName: ps.project.name };
    }
    return { ...c, nodeTitle: '（已删除的节点）', projectId: '', projectName: '' };
  }

  private pendingFor(projectId: string): Change[] {
    const ps = this.proj(projectId);
    return this.changes.filter((c) => c.status === 'pending' && ps.store.get(c.nodeId));
  }

  /** Pending changes with node/project context, optionally for one project (cloud tools). */
  pendingChanges(projectId?: string): PendingChange[] {
    const rows = projectId ? this.pendingFor(projectId) : this.changes.filter((c) => c.status === 'pending');
    return rows.map((c) => this.withCtx(c));
  }

  private logActivity(ps: ProjectState, nodeId: string | null, actor: Actor | string, kind: string, payload: Record<string, unknown> | null): void {
    ps.activity.push({ id: this.actId++, nodeId, actor, kind, payload: { ...(payload ?? {}), projectId: ps.project.id }, createdAt: nowIso() });
    if (ps.activity.length > KEEP_ACTIVITY * 2) ps.activity.splice(0, ps.activity.length - KEEP_ACTIVITY);
    this.dirty('project', ps.project.id);
  }

  private slipsOf(ps: ProjectState, derived: Map<string, Derived>): SlipInfo[] {
    return findDependencySlips(ps.store, derived, ps.deps).map((s) => ({ fromNode: s.from.id, toNode: s.to.id, fromTitle: s.from.title, toTitle: s.to.title, fromDue: s.fromDue, toStart: s.toStart, days: s.days }));
  }

  // ----- ops (mirrors apps/server/src/service/ops.ts) -----

  applyOps(ps: ProjectState, ops: Op[], opts: { actor?: Actor; clientId?: string; reason?: string; skipConfirmation?: boolean } = {}): { results: OpResult[]; serverSeq: number; changes: Change[] } {
    const settings = this.settings();
    const results: OpResult[] = [];
    const newChanges: Change[] = [];
    const projectId = ps.project.id;

    const upsertPending = (c: { nodeId: string; field: string; oldValue: unknown; newValue: unknown }): { change: Change; created: boolean } => {
      const existing = this.changes.find((x) => x.nodeId === c.nodeId && x.field === c.field && x.status === 'pending');
      if (existing) return { change: existing, created: false };
      const change: Change = {
        id: newId(),
        nodeId: c.nodeId,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        reason: opts.reason ?? null,
        source: 'claude',
        batchId: null,
        status: 'pending',
        decidedAt: null,
        createdAt: nowIso(),
        expiresAt: `${addDays(todayIso(), 7)}T00:00:00.000Z`,
      };
      this.changes.push(change);
      return { change, created: true };
    };

    for (const raw of ops) {
      const op: Op = { ...raw, projectId, actor: opts.actor ?? raw.actor, clientId: opts.clientId ?? raw.clientId };
      const dup = ps.log.find((e) => e.op.opId === op.opId);
      if (dup) {
        results.push({ opId: op.opId, ok: true, serverSeq: dup.serverSeq });
        continue;
      }
      const now = nowIso();
      let effective: Op = op;
      const changeIds: string[] = [];

      if (op.actor === 'claude' && !opts.skipConfirmation) {
        if (opNeedsConfirmation(op, settings) && op.type === 'delete_node') {
          const n = ps.store.live(op.nodeId);
          if (!n) {
            results.push({ opId: op.opId, ok: false, error: 'not_found', message: 'node not found' });
            continue;
          }
          const { change, created } = upsertPending({ nodeId: n.id, field: 'delete', oldValue: null, newValue: true });
          if (created) {
            newChanges.push(change);
            this.logActivity(ps, n.id, 'claude', 'change_proposed', { changeId: change.id, field: 'delete', title: n.title });
          }
          results.push({ opId: op.opId, ok: true, changeIds: [change.id], node: n });
          continue;
        }
        if (op.type === 'update_node') {
          const n = ps.store.live(op.nodeId);
          if (!n) {
            results.push({ opId: op.opId, ok: false, error: 'not_found', message: 'node not found' });
            continue;
          }
          if (op.baseVersion !== undefined && op.baseVersion !== n.version) {
            results.push({ opId: op.opId, ok: false, error: 'version_conflict', message: `expected version ${op.baseVersion}, have ${n.version}`, current: n });
            continue;
          }
          const { direct, guarded } = splitPatch(op.patch, 'claude', settings);
          for (const field of GUARDED_FIELD_NAMES) {
            if (guarded[field] === undefined) continue;
            const { change, created } = upsertPending({ nodeId: n.id, field, oldValue: n[field], newValue: guarded[field] });
            changeIds.push(change.id);
            if (created) {
              newChanges.push(change);
              this.logActivity(ps, n.id, 'claude', 'change_proposed', { changeId: change.id, field, from: n[field], to: guarded[field], title: n.title });
            }
          }
          if (Object.keys(direct).length === 0) {
            results.push({ opId: op.opId, ok: true, changeIds, node: n });
            continue;
          }
          effective = { ...op, patch: direct };
        }
      }

      const dateErr = validateDates(ps.store, effective);
      if (dateErr) {
        results.push({ opId: op.opId, ok: false, error: 'invalid', message: dateErr });
        continue;
      }

      const targetId = effective.type === 'create_node' ? effective.node.id : effective.nodeId;
      const before = ps.store.get(targetId);
      const inverse = ps.store.inverseOf(effective);
      const res = ps.store.apply(effective, now);
      if (!res.ok) {
        results.push({ opId: op.opId, ok: false, error: res.error, message: res.message, current: res.current });
        continue;
      }
      const serverSeq = ++ps.serverSeq;
      ps.log.push({ serverSeq, op: effective, inverse, receivedAt: now, undoneBy: null });
      if (ps.log.length > KEEP_OPS * 2) ps.log.splice(0, ps.log.length - KEEP_OPS);
      const act = activityFor(effective, before, res.changed);
      this.logActivity(ps, targetId, op.actor, act.kind, act.payload);

      // a direct edit by the owner supersedes any pending proposal on the same field
      if (op.actor !== 'claude' && effective.type === 'update_node') {
        const fields = Object.keys(effective.patch);
        for (const c of this.changes) {
          if (c.nodeId === targetId && c.status === 'pending' && fields.includes(c.field)) {
            c.status = 'expired';
            c.decidedAt = now;
          }
        }
      }
      const node = res.changed.find((n) => n.id === targetId) ?? res.changed[0];
      results.push({ opId: op.opId, ok: true, serverSeq, node, ...(changeIds.length ? { changeIds } : {}) });
    }
    return { results, serverSeq: ps.serverSeq, changes: newChanges };
  }

  private undo(serverSeq: number): { results: OpResult[]; serverSeq: number; undoneSeq: number } {
    for (const ps of this.projects.values()) {
      const entry = ps.log.find((e) => e.serverSeq === serverSeq);
      if (!entry) continue;
      if (entry.undoneBy) throw new HttpErr(409, 'already_undone', 'op already undone');
      if (!entry.inverse) throw new HttpErr(409, 'not_invertible', 'op cannot be undone');
      const undoOp: Op = { ...entry.inverse, opId: newId(), actor: 'user', clientId: 'server', at: nowIso() };
      const out = this.applyOps(ps, [undoOp], { skipConfirmation: true });
      const r = out.results[0]!;
      if (r.ok && r.serverSeq) {
        entry.undoneBy = r.serverSeq;
        this.logActivity(ps, 'nodeId' in undoOp ? undoOp.nodeId : undoOp.node.id, 'user', 'undone', { serverSeq, undoneBy: r.serverSeq });
      } else throw new HttpErr(409, r.error ?? 'apply_failed', r.message ?? 'could not undo', r.current ? { current: r.current } : {});
      return { results: out.results, serverSeq: out.serverSeq, undoneSeq: serverSeq };
    }
    throw notFound('op');
  }

  // ----- changes -----

  private approveChange(id: string): { change: PendingChange; result?: OpResult } {
    const c = this.changes.find((x) => x.id === id);
    if (!c) throw notFound('change');
    if (c.status !== 'pending') throw new HttpErr(409, 'not_pending', `change is ${c.status}`);
    const { ps } = this.locate(c.nodeId);
    const base = { opId: newId(), clientId: 'server', projectId: ps.project.id, actor: 'user' as Actor, at: nowIso() };
    const op: Op =
      c.field === 'delete'
        ? { ...base, type: 'delete_node', nodeId: c.nodeId }
        : c.field === 'status'
          ? { ...base, type: 'update_node', nodeId: c.nodeId, patch: { status: (c.newValue as 'done') ?? 'done' } }
          : { ...base, type: 'update_node', nodeId: c.nodeId, patch: { [c.field]: c.newValue } as NodePatch };
    const out = this.applyOps(ps, [op]);
    const result = out.results[0]!;
    if (!result.ok) throw new HttpErr(409, result.error ?? 'apply_failed', result.message ?? 'could not apply change', result.current ? { current: result.current } : {});
    c.status = 'approved';
    c.decidedAt = nowIso();
    this.logActivity(ps, c.nodeId, 'user', 'change_decided', { changeId: id, field: c.field, decision: 'approve', note: null });
    return { change: this.withCtx(c), result };
  }

  private rejectChange(id: string): { change: PendingChange } {
    const c = this.changes.find((x) => x.id === id);
    if (!c) throw notFound('change');
    if (c.status !== 'pending') throw new HttpErr(409, 'not_pending', `change is ${c.status}`);
    c.status = 'rejected';
    c.decidedAt = nowIso();
    try {
      const { ps } = this.locate(c.nodeId);
      this.logActivity(ps, c.nodeId, 'user', 'change_decided', { changeId: id, field: c.field, decision: 'reject', note: null });
    } catch {
      /* node gone */
    }
    return { change: this.withCtx(c) };
  }

  createContact(input: { name: string; company?: string | null; email?: string | null; phone?: string | null; notes?: string | null }): Contact {
    const name = String(input.name ?? '').trim();
    if (!name) throw badRequest('name is required');
    const c: Contact = { id: newId(), name, company: input.company ?? null, email: input.email ?? null, phone: input.phone ?? null, notes: input.notes ?? null, archivedAt: null };
    this.contacts.push(c);
    this.dirty('contacts', 'contacts');
    return c;
  }

  // ----- projects -----

  projectRows() {
    const today = todayIso();
    const out = [];
    for (const ps of this.projects.values()) {
      const derived = computeRollup(ps.store);
      let overdue = 0;
      for (const n of ps.store.all()) {
        const d = derived.get(n.id);
        if (d && !d.hasChildren && n.kind !== 'note' && isOverdue(d, today)) overdue++;
      }
      out.push({
        ...ps.project,
        rootTitle: ps.store.get(ps.project.rootNodeId)?.title ?? ps.project.name,
        overdueCount: overdue,
        pendingCount: this.pendingFor(ps.project.id).length,
        slipCount: this.slipsOf(ps, derived).length,
        nodeCount: ps.store.all().length,
      });
    }
    return out;
  }

  private projectDetail(ps: ProjectState) {
    const derived = computeRollup(ps.store);
    return {
      project: ps.project,
      nodes: ps.store.all(),
      derived: Object.fromEntries(derived),
      contacts: this.contacts.filter((c) => !c.archivedAt),
      pendingChanges: this.pendingFor(ps.project.id).map((c) => this.withCtx(c)),
      dependencies: ps.deps,
      criticalPath: computeCriticalPath(ps.store, derived),
      slips: this.slipsOf(ps, derived),
      serverSeq: ps.serverSeq,
    };
  }

  createProject(input: { name?: string; outline?: string }) {
    const name = String(input.name ?? '').trim();
    if (!name) throw badRequest('name is required');
    const id = newId();
    const rootId = newId();
    const now = nowIso();
    const root: TNode = {
      id: rootId,
      projectId: id,
      parentId: null,
      rank: firstRank(),
      title: name,
      description: '',
      kind: 'goal',
      ownerId: null,
      status: 'todo',
      progress: 0,
      progressMode: 'auto',
      startDate: null,
      dueDate: null,
      dateMode: 'auto',
      estimateHours: null,
      priority: 3,
      tags: [],
      lastNudgedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const ps: ProjectState = { project: { id, name, rootNodeId: rootId, createdAt: now, archivedAt: null }, store: new TreeStore([root]), deps: [], log: [], serverSeq: 0, activity: [] };
    this.projects.set(id, ps);
    this.logActivity(ps, rootId, 'user', 'node_created', { title: name, parentId: null, project: true });

    let warnings: { lineNo: number; message: string }[] = [];
    let results: OpResult[] = [];
    if (input.outline && input.outline.trim()) {
      const parsed = parseOutline(input.outline, { year: year() });
      if (parsed.roots.length === 1 && !parsed.roots[0]!.id && parsed.roots[0]!.title === name) parsed.roots[0]!.id = rootId;
      const plan = planOps(ps.store, parsed, { projectId: id, parentId: rootId, mode: 'append', contacts: this.contacts, newId, opBase: { clientId: 'web', actor: 'user', at: now } });
      warnings = plan.errors;
      const out = this.applyOps(
        ps,
        plan.ops.map((o) => ({ ...o, opId: newId() })),
        { actor: 'user', clientId: 'web' },
      );
      results = out.results;
      for (const r of results) if (!r.ok) warnings.push({ lineNo: 0, message: `${r.error}: ${r.message}` });
    }
    return { project: ps.project, nodes: ps.store.all(), warnings, results };
  }

  outline(ps: ProjectState): string {
    const deps = new Map<string, string[]>();
    for (const d of ps.deps) deps.set(d.toNode, [...(deps.get(d.toNode) ?? []), d.fromNode]);
    return serializeOutline(ps.store, null, { contacts: this.contacts, year: year(), deps, derived: computeRollup(ps.store) });
  }

  nodeRefs(pred: (n: TNode) => boolean) {
    const out = [];
    for (const ps of this.projects.values()) {
      if (ps.project.archivedAt) continue;
      const derived = computeRollup(ps.store);
      for (const n of ps.store.all()) {
        if (!pred(n)) continue;
        out.push({ node: n, derived: derived.get(n.id)!, path: ps.store.path(n.id), projectId: ps.project.id, projectName: ps.project.name });
      }
    }
    return out.sort((a, b) => (a.node.updatedAt < b.node.updatedAt ? 1 : -1));
  }

  today() {
    const today = todayIso();
    const pending = this.changes.filter((c) => c.status === 'pending').map((c) => this.withCtx(c));
    type Flat = TodayItem & { projectId: string; projectName: string };
    const res = { today, overdue: [] as Flat[], dueToday: [] as Flat[], dueTomorrow: [] as Flat[], nudgeDue: [] as Flat[], pending };
    for (const ps of this.projects.values()) {
      if (ps.project.archivedAt) continue;
      const view = computeToday(ps.store, computeRollup(ps.store), this.pendingFor(ps.project.id), { today });
      const tag = (items: TodayItem[]): Flat[] => items.map((i) => ({ ...i, projectId: ps.project.id, projectName: ps.project.name }));
      res.overdue.push(...tag(view.overdue));
      res.dueToday.push(...tag(view.dueToday));
      res.dueTomorrow.push(...tag(view.dueTomorrow));
      res.nudgeDue.push(...tag(view.nudgeDue));
    }
    const byDue = (a: Flat, b: Flat) => (a.derived.dueDate! < b.derived.dueDate! ? -1 : a.derived.dueDate! > b.derived.dueDate! ? 1 : 0);
    res.overdue.sort(byDue);
    res.nudgeDue.sort(byDue);
    return res;
  }

  nudge(nodeId: string, template?: string, actor: Actor = 'user'): { text: string; node: TNode } {
    const { ps, node } = this.locate(nodeId);
    const derived = computeRollup(ps.store).get(nodeId)!;
    const owner = node.ownerId ? (this.contacts.find((c) => c.id === node.ownerId)?.name ?? '') : this.account.name;
    const tpl = template ?? this.account.settings?.nudgeTemplate ?? DEFAULT_NUDGE_TEMPLATE;
    const due = derived.dueDate ? shortDate(derived.dueDate, year()) : '未定';
    const txt = tpl
      .replace(/\{title\}/g, node.title)
      .replace(/\{due\}/g, due)
      .replace(/\{progress\}/g, String(derived.progress))
      .replace(/\{owner\}/g, owner)
      .replace(/\{path\}/g, ps.store.path(nodeId).join(' / '));
    const out = this.applyOps(ps, [{ opId: newId(), clientId: actor === 'claude' ? 'claude' : 'server', projectId: ps.project.id, actor, at: nowIso(), type: 'update_node', nodeId, patch: { lastNudgedAt: nowIso() } }], { skipConfirmation: true });
    const r = out.results[0]!;
    if (!r.ok) throw new HttpErr(409, r.error ?? 'apply_failed', r.message ?? 'could not record nudge');
    return { text: txt, node: r.node! };
  }

  addDependency(from: string, to: string, actor: Actor = 'user'): void {
    if (from === to) throw badRequest('a node cannot depend on itself');
    const a = this.locate(from);
    const b = this.locate(to);
    if (a.ps !== b.ps) throw badRequest('dependencies must stay within one project');
    if (dependencyWouldCycle(a.ps.deps, from, to))
      throw new HttpErr(409, 'dependency_cycle', `「${a.node.title}」已经（直接或间接）依赖「${b.node.title}」，再加这条依赖会形成循环`, { fromNode: from, toNode: to });
    if (!a.ps.deps.some((d) => d.fromNode === from && d.toNode === to)) a.ps.deps.push({ fromNode: from, toNode: to });
    this.logActivity(a.ps, to, actor, 'dependency_added', { fromNode: from, toNode: to });
  }

  removeDependency(from: string, to: string, actor: Actor = 'user'): boolean {
    for (const ps of this.projects.values()) {
      const i = ps.deps.findIndex((d) => d.fromNode === from && d.toNode === to);
      if (i < 0) continue;
      ps.deps.splice(i, 1);
      this.logActivity(ps, to, actor, 'dependency_removed', { fromNode: from, toNode: to });
      return true;
    }
    return false;
  }

  // ----- plan batches -----

  draftPlan(ps: ProjectState, parentId: string, outline: string, mode: PlanMode, actor: Actor): PlanBatch {
    if (!ps.store.live(parentId)) throw notFound('parent node');
    const plan = planOps(ps.store, parseOutline(outline, { year: year() }), {
      projectId: ps.project.id,
      parentId,
      mode,
      contacts: this.contacts,
      newId,
      opBase: { clientId: actor === 'claude' ? 'claude' : 'web', actor, at: nowIso() },
    });
    const batch: PlanBatch = { id: newId(), projectId: ps.project.id, parentId, mode, outline, diff: { ops: plan.ops, summary: plan.summary, created: plan.created, errors: plan.errors }, status: 'draft' };
    this.batches.push(batch);
    this.dirty('project', ps.project.id);
    return batch;
  }

  private applyBatch(id: string) {
    const b = this.batch(id);
    if (b.status !== 'draft') throw new HttpErr(409, 'not_draft', `plan batch is ${b.status}`);
    const ps = this.proj(b.projectId);
    const out = this.applyOps(
      ps,
      b.diff.ops.map((o) => ({ ...o, opId: newId(), at: nowIso() })),
      { actor: 'user', clientId: 'server' },
    );
    b.status = 'applied';
    this.logActivity(ps, b.parentId, 'claude', 'batch_applied', { batchId: id, mode: b.mode, summary: b.diff.summary, failed: out.results.filter((r) => !r.ok).length });
    return { batch: b, results: out.results, serverSeq: out.serverSeq };
  }

  // ----- assistant -----

  private streamReply(session: AssistantSession, userText: string, projectId: string | null, signal: AbortSignal | null): Response {
    const enc = new TextEncoder();
    const msgs = this.messages.get(session.id) ?? [];
    this.messages.set(session.id, msgs);
    msgs.push({ id: newId(), role: 'user', text: userText, createdAt: nowIso() });
    if (!session.title) session.title = userText.length > 18 ? `${userText.slice(0, 18)}…` : userText;
    session.updatedAt = nowIso();
    this.dirty('chat', session.id);

    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const emit = (event: string, data: unknown) => {
          if (closed) return;
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const finish = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        signal?.addEventListener('abort', finish);
        const save = (text: string, toolCalls: AssistantReply['toolCalls']): string => {
          const id = newId();
          if (text || toolCalls.length) msgs.push({ id, role: 'assistant', text, toolCalls, createdAt: nowIso() });
          session.updatedAt = nowIso();
          this.dirty('chat', session.id);
          return id;
        };
        void (async () => {
          try {
            const r = await this.assistant.reply({ session, userText, projectId, history: msgs, signal, emit });
            const id = save(r.text, r.toolCalls);
            emit('done', { messageId: id, text: r.text });
          } catch (e) {
            const f = (e ?? {}) as Partial<AssistantFailure>;
            const id = save(f.text ?? '', f.toolCalls ?? []);
            if (!f.silent) emit('error', { message: f.message ?? (e as Error)?.message ?? String(e) });
            if (f.text) emit('done', { messageId: id, text: f.text });
          } finally {
            finish();
          }
        })();
      },
      cancel: () => {
        closed = true;
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } });
  }
}

// ---------- the scripted demo assistant ----------

/**
 * Demo answer: always proposes to push one task's due date by 5 days through applyOps (actor
 * 'claude'), so the change lands in 待确认 exactly like the real assistant's would.
 */
export class ScriptedAssistant implements AssistantDriver {
  constructor(private server: DemoServer) {}

  status() {
    return { configured: true, model: 'claude-opus-5' };
  }

  private pickNode(ps: ProjectState, userText: string): { node: TNode; derived: Derived } | null {
    const derived = computeRollup(ps.store);
    const leaves = ps.store.all().filter((n) => n.parentId !== null && !derived.get(n.id)?.hasChildren && n.kind !== 'note');
    const named = leaves.filter((n) => n.title && userText.includes(n.title)).sort((a, b) => b.title.length - a.title.length)[0];
    const pick = named ?? leaves.find((n) => n.title === '接口联调') ?? leaves.find((n) => derived.get(n.id)?.dueDate) ?? leaves[0];
    return pick ? { node: pick, derived: derived.get(pick.id)! } : null;
  }

  async reply({ userText, projectId, emit }: AssistantRequest): Promise<AssistantReply> {
    const chunks: string[] = [];
    const say = async (delta: string, ms = 160) => {
      await sleep(ms);
      chunks.push(delta);
      emit('text', { delta });
    };
    const toolCalls: AssistantReply['toolCalls'] = [];
    await say(`${DEMO_PREFIX}好的，`, 220);
    let ps: ProjectState | undefined;
    try {
      ps = projectId ? this.server.proj(projectId) : undefined;
    } catch {
      ps = undefined;
    }
    ps ??= this.server.projectIds().map((id) => this.server.proj(id))[0];
    const picked = ps ? this.pickNode(ps, userText) : null;
    if (ps && picked) {
      const { node, derived } = picked;
      const oldDue = node.dueDate ?? derived.dueDate ?? todayIso();
      const newDue = addDays(oldDue, 5);
      const reason = `${DEMO_PREFIX}按你的要求把「${node.title}」顺延 5 天`;
      // like the server, a second proposal on a field that already has a pending change reuses that change
      const existing = this.server.pendingChanges(ps.project.id).find((c) => c.nodeId === node.id && c.field === 'dueDate');
      const op: Op = { opId: newId(), clientId: 'claude', projectId: ps.project.id, actor: 'claude', at: nowIso(), type: 'update_node', nodeId: node.id, patch: { dueDate: newDue }, baseVersion: node.version };
      const out = this.server.applyOps(ps, [op], { reason });
      const r = out.results[0]!;
      const pending = !!r.changeIds?.length;
      const result = r.ok
        ? { ok: true, status: pending ? 'pending' : 'applied', ...(pending ? { changeIds: r.changeIds } : {}), node: { id: node.id, title: node.title, dueDate: pending ? oldDue : newDue } }
        : { ok: false, error: r.error, message: r.message };
      const input = { nodeId: node.id, patch: { dueDate: newDue }, reason };
      await sleep(260);
      toolCalls.push({ name: 'update_node', input, resultText: JSON.stringify(result, null, 2) });
      emit('tool', { name: 'update_node', input, result });
      const fmt = (iso: string) => shortDate(iso, year());
      if (!r.ok) await say(`我试着改**${node.title}**的截止日，但没成功：${r.message ?? r.error}。`, 240);
      else if (pending && existing) {
        await say(`**${node.title}**的截止日已经有一条待确认的改动（${fmt(oldDue)} → ${fmt(String(existing.newValue))}），我没有再提一条。`, 240);
        await say('\n\n- 先在右上角「待确认」或右侧栏里处理那条就行', 140);
        await say('\n- 确认之后再找我，我可以继续往后挪', 140);
      } else if (pending) {
        await say(`我把**${node.title}**的截止日从 ${fmt(oldDue)} 推到 ${fmt(newDue)}。`, 240);
        await say('\n\n- 截止日是关键字段，这条改动进了「待确认」', 140);
        await say('\n- 在右上角「待确认」或右侧栏里确认或拒绝就行', 140);
      } else {
        await say(`我把**${node.title}**的截止日从 ${fmt(oldDue)} 推到 ${fmt(newDue)}，已经直接生效。`, 240);
        await say('\n\n- 你在设置里关掉了「关键字段需要确认」，所以没有进待确认', 140);
      }
    } else {
      await say('这个项目里还没有可以调整的任务。先在导图里加几个节点，再来找我。', 240);
    }
    return { text: chunks.join(''), toolCalls };
  }
}

// ---------- module-level helpers ----------

function depBody(body: unknown): { from: string; to: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const from = String(b.fromNode ?? b.fromNodeId ?? '');
  const to = String(b.toNode ?? b.toNodeId ?? '');
  if (!from || !to) throw badRequest('fromNode and toNode are required');
  return { from, to };
}

function validateDates(store: TreeStore, op: Op): string | null {
  let start: string | null | undefined;
  let due: string | null | undefined;
  if (op.type === 'create_node') {
    start = op.node.startDate ?? null;
    due = op.node.dueDate ?? null;
  } else if (op.type === 'update_node') {
    const n = store.live(op.nodeId);
    if (!n) return null;
    start = op.patch.startDate !== undefined ? op.patch.startDate : n.startDate;
    due = op.patch.dueDate !== undefined ? op.patch.dueDate : n.dueDate;
  } else return null;
  if (start && due && start > due) return `start_date ${start} is after due_date ${due}`;
  return null;
}

function activityFor(op: Op, before: TNode | undefined, changed: TNode[]): { kind: string; payload: Record<string, unknown> } {
  switch (op.type) {
    case 'create_node':
      return { kind: 'node_created', payload: { title: op.node.title, parentId: op.node.parentId } };
    case 'update_node': {
      const fields: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of Object.keys(op.patch) as (keyof NodePatch)[]) fields[k] = { from: before?.[k] ?? null, to: op.patch[k] };
      const onlyNudge = Object.keys(op.patch).length === 1 && op.patch.lastNudgedAt !== undefined;
      return { kind: onlyNudge ? 'nudged' : 'field_changed', payload: { title: before?.title, fields } };
    }
    case 'move_node':
      return { kind: 'moved', payload: { title: before?.title, from: before?.parentId ?? null, to: op.parentId } };
    case 'delete_node':
      return { kind: 'deleted', payload: { title: before?.title, count: changed.length } };
    case 'restore_node':
      return { kind: 'restored', payload: { title: changed[0]?.title, count: changed.length } };
  }
}
