import { randomUUID } from 'node:crypto';
import {
  computeRollup,
  computeToday,
  firstRank,
  isOverdue,
  parseOutline,
  planOps,
  serializeOutline,
  shortDate,
  type Actor,
  type Contact,
  type Derived,
  type Op,
  type Project,
  type TNode,
  type TodayItem,
  type TreeStore,
} from '@tsai-mind/core';
import type { Ctx } from './context.js';
import { currentYear, nowIso, todayIso } from './context.js';
import { rowToActivity, rowToContact, rowToNode, rowToNote, rowToProject, type ActivityRow, type NoteRow } from '../mapping.js';
import { HttpError, badRequest, notFound } from '../errors.js';
import { applyOps, type OpResult } from './ops.js';
import { listChanges, type ChangeWithContext } from './changes.js';
import { depsByNode, insertActivity, loadAccount, loadContacts, loadDependencies, loadPendingChanges, loadProject, loadProjects, loadStore } from './store.js';

// ---------- projects ----------

export interface ProjectSummary extends Project {
  rootTitle: string;
  overdueCount: number;
  pendingCount: number;
  nodeCount: number;
}

export async function listProjectSummaries(ctx: Ctx, opts: { includeArchived?: boolean } = {}): Promise<ProjectSummary[]> {
  const projects = await loadProjects(ctx.sql, opts);
  const today = todayIso(ctx);
  const pendingRows = await ctx.sql`
    select n.project_id, count(*)::int as n from change c join node n on n.id = c.node_id
    where c.status = 'pending' group by n.project_id`;
  const pendingBy = new Map(pendingRows.map((r) => [r.project_id as string, Number(r.n)]));
  const out: ProjectSummary[] = [];
  for (const p of projects) {
    const store = await loadStore(ctx.sql, p.id);
    const derived = computeRollup(store);
    let overdue = 0;
    for (const n of store.all()) {
      const d = derived.get(n.id);
      if (d && !d.hasChildren && n.kind !== 'note' && isOverdue(d, today)) overdue++;
    }
    out.push({ ...p, rootTitle: store.get(p.rootNodeId)?.title ?? p.name, overdueCount: overdue, pendingCount: pendingBy.get(p.id) ?? 0, nodeCount: store.all().length });
  }
  return out;
}

export interface CreateProjectResult {
  project: Project;
  nodes: TNode[];
  warnings: { lineNo: number; message: string }[];
  results: OpResult[];
}

/** Create a project with its root node; optionally populate it from an outline (append mode under the root). */
export async function createProject(ctx: Ctx, input: { name: string; outline?: string; actor?: Actor }): Promise<CreateProjectResult> {
  const name = input.name.trim();
  if (!name) throw badRequest('name is required');
  const actor = input.actor ?? 'user';
  const rootId = randomUUID();
  const project = await ctx.sql.begin(async (tx) => {
    const rows = await tx`insert into project (name) values (${name}) returning *`;
    const p = rowToProject(rows[0]!);
    const now = nowIso();
    await tx`insert into node (id, project_id, parent_id, rank, title, kind, created_at, updated_at)
      values (${rootId}, ${p.id}, null, ${firstRank()}, ${name}, 'goal', ${now}, ${now})`;
    await tx`update project set root_node_id = ${rootId} where id = ${p.id}`;
    await insertActivity(tx, { projectId: p.id, nodeId: rootId, actor, kind: 'node_created', payload: { title: name, parentId: null, project: true } });
    return { ...p, rootNodeId: rootId };
  });

  let warnings: CreateProjectResult['warnings'] = [];
  let results: OpResult[] = [];
  if (input.outline && input.outline.trim()) {
    const store = await loadStore(ctx.sql, project.id);
    const parsed = parseOutline(input.outline, { year: currentYear(ctx) });
    // A single outline root titled like the project is the root itself: place its children under the root.
    if (parsed.roots.length === 1 && !parsed.roots[0]!.id && parsed.roots[0]!.title === name) parsed.roots[0]!.id = rootId;
    const contacts = await loadContacts(ctx.sql, { includeArchived: true });
    const plan = planOps(store, parsed, {
      projectId: project.id, parentId: rootId, mode: 'append', contacts, newId: randomUUID,
      opBase: { clientId: actor === 'claude' ? 'claude' : 'web', actor: 'user', at: nowIso() },
    });
    warnings = plan.errors;
    const ops: Op[] = plan.ops.map((o) => ({ ...o, opId: randomUUID() }));
    const outcome = await applyOps(ctx, project.id, ops, { actor: 'user', clientId: actor === 'claude' ? 'claude' : 'web' });
    results = outcome.results;
    for (const r of results) if (!r.ok) warnings.push({ lineNo: 0, message: `${r.error}: ${r.message}` });
  }
  const store = await loadStore(ctx.sql, project.id);
  return { project, nodes: store.all(), warnings, results };
}

export async function updateProject(ctx: Ctx, id: string, patch: { name?: string; archivedAt?: string | null }): Promise<Project> {
  const p = await loadProject(ctx.sql, id);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw badRequest('name must not be empty');
    await ctx.sql`update project set name = ${name} where id = ${id}`;
  }
  if (patch.archivedAt !== undefined) await ctx.sql`update project set archived_at = ${patch.archivedAt} where id = ${id}`;
  return { ...(await loadProject(ctx.sql, id)), rootNodeId: p.rootNodeId };
}

export interface ProjectDetail {
  project: Project;
  nodes: TNode[];
  derived: Record<string, Derived>;
  contacts: Contact[];
  pendingChanges: ChangeWithContext[];
  dependencies: { fromNode: string; toNode: string }[];
  serverSeq: number;
}

export async function getProjectDetail(ctx: Ctx, id: string): Promise<ProjectDetail> {
  const project = await loadProject(ctx.sql, id);
  const store = await loadStore(ctx.sql, id);
  const derived = Object.fromEntries(computeRollup(store));
  const seq = await ctx.sql`select coalesce(max(server_seq), 0) as seq from op where project_id = ${id}`;
  return {
    project,
    nodes: store.all(),
    derived,
    contacts: await loadContacts(ctx.sql),
    pendingChanges: await listChanges(ctx, { projectId: id }),
    dependencies: await loadDependencies(ctx.sql, id),
    serverSeq: Number(seq[0]!.seq),
  };
}

export interface TreeJson {
  project: Project;
  nodes: (TNode & { derived: Derived })[];
  dependencies: { fromNode: string; toNode: string }[];
}

/** Tree as JSON, depth-limited (depth 1 = root only). */
export async function getTreeJson(ctx: Ctx, projectId: string, depth?: number): Promise<TreeJson> {
  const project = await loadProject(ctx.sql, projectId);
  const store = await loadStore(ctx.sql, projectId);
  const derived = computeRollup(store);
  const out: TreeJson['nodes'] = [];
  const walk = (n: TNode, level: number) => {
    out.push({ ...n, derived: derived.get(n.id)! });
    if (depth !== undefined && level >= depth) return;
    for (const c of store.children(n.id)) walk(c, level + 1);
  };
  for (const r of store.children(null)) walk(r, 1);
  return { project, nodes: out, dependencies: await loadDependencies(ctx.sql, projectId) };
}

export async function getOutline(ctx: Ctx, projectId: string, rootId?: string, depth?: number): Promise<string> {
  const store = await loadStore(ctx.sql, projectId);
  const derived = computeRollup(store);
  const contacts = await loadContacts(ctx.sql, { includeArchived: true });
  const deps = depsByNode(await loadDependencies(ctx.sql, projectId));
  if (depth === undefined) return serializeOutline(store, rootId ?? null, { contacts, year: currentYear(ctx), deps, derived });
  // depth-limited: drop lines deeper than `depth` levels (root = level 1)
  return serializeOutline(store, rootId ?? null, { contacts, year: currentYear(ctx), deps, derived })
    .split('\n')
    .filter((line) => (line.length - line.trimStart().length) / 2 < depth)
    .join('\n');
}

export async function listOps(ctx: Ctx, projectId: string, since: number): Promise<{ serverSeq: number; op: Op }[]> {
  const rows = await ctx.sql`select server_seq, payload from op where project_id = ${projectId} and server_seq > ${since} order by server_seq`;
  return rows.map((r) => ({ serverSeq: Number(r.server_seq), op: r.payload as Op }));
}

export async function listActivity(ctx: Ctx, projectId: string, opts: { since?: string; limit?: number; nodeId?: string } = {}): Promise<ActivityRow[]> {
  const limit = Math.min(opts.limit ?? 200, 1000);
  const rows = await ctx.sql`
    select * from activity where project_id = ${projectId}
      ${opts.since ? ctx.sql`and created_at > ${opts.since}` : ctx.sql``}
      ${opts.nodeId ? ctx.sql`and node_id = ${opts.nodeId}` : ctx.sql``}
    order by created_at desc, id desc limit ${limit}`;
  return rows.map(rowToActivity);
}

// ---------- nodes ----------

export interface NodeRef {
  node: TNode;
  derived: Derived;
  path: string[];
  projectId: string;
  projectName: string;
}

export async function locateNode(ctx: Ctx, nodeId: string): Promise<{ project: Project; store: TreeStore; node: TNode }> {
  const rows = await ctx.sql`select project_id from node where id = ${nodeId}`;
  if (!rows[0]) throw notFound('node');
  const project = await loadProject(ctx.sql, rows[0].project_id as string);
  const store = await loadStore(ctx.sql, project.id);
  const node = store.live(nodeId);
  if (!node) throw notFound('node');
  return { project, store, node };
}

export interface NodeDetail extends NodeRef {
  children: TNode[];
  dependsOn: { id: string; title: string }[];
  blocks: { id: string; title: string }[];
  notes: NoteRow[];
  activity: ActivityRow[];
  pendingChanges: ChangeWithContext[];
}

export async function getNodeDetail(ctx: Ctx, nodeId: string): Promise<NodeDetail> {
  const { project, store, node } = await locateNode(ctx, nodeId);
  const derived = computeRollup(store);
  const deps = await loadDependencies(ctx.sql, project.id);
  const title = (id: string) => ({ id, title: store.get(id)?.title ?? '' });
  const notes = (await ctx.sql`select * from note where node_id = ${nodeId} order by created_at desc limit 50`).map(rowToNote);
  const activity = await listActivity(ctx, project.id, { nodeId, limit: 20 });
  const pendingChanges = (await listChanges(ctx, { projectId: project.id })).filter((c) => c.nodeId === nodeId);
  return {
    node,
    derived: derived.get(nodeId)!,
    path: store.path(nodeId),
    projectId: project.id,
    projectName: project.name,
    children: store.children(nodeId),
    dependsOn: deps.filter((d) => d.toNode === nodeId).map((d) => title(d.fromNode)),
    blocks: deps.filter((d) => d.fromNode === nodeId).map((d) => title(d.toNode)),
    notes,
    activity,
    pendingChanges,
  };
}

export interface SearchFilter {
  query?: string;
  projectId?: string;
  ownerId?: string | null;
  status?: string;
  dueBefore?: string;
  dueAfter?: string;
  overdue?: boolean;
  limit?: number;
}

export async function searchNodes(ctx: Ctx, f: SearchFilter): Promise<NodeRef[]> {
  const q = f.query?.trim();
  const rows = await ctx.sql`
    select n.id, n.project_id from node n join project p on p.id = n.project_id
    where n.deleted_at is null and p.archived_at is null
      ${q ? ctx.sql`and (n.title ilike ${'%' + q + '%'} or n.description ilike ${'%' + q + '%'})` : ctx.sql``}
      ${f.projectId ? ctx.sql`and n.project_id = ${f.projectId}` : ctx.sql``}
      ${f.ownerId === undefined ? ctx.sql`` : f.ownerId === null ? ctx.sql`and n.owner_id is null` : ctx.sql`and n.owner_id = ${f.ownerId}`}
    order by n.updated_at desc limit 500`;
  const byProject = new Map<string, string[]>();
  for (const r of rows) {
    const list = byProject.get(r.project_id as string) ?? [];
    list.push(r.id as string);
    byProject.set(r.project_id as string, list);
  }
  const today = todayIso(ctx);
  const out: NodeRef[] = [];
  for (const [projectId, ids] of byProject) {
    const project = await loadProject(ctx.sql, projectId);
    const store = await loadStore(ctx.sql, projectId);
    const derived = computeRollup(store);
    for (const id of ids) {
      const n = store.live(id);
      const d = derived.get(id);
      if (!n || !d) continue;
      if (f.status && d.status !== f.status) continue;
      if (f.dueBefore && !(d.dueDate && d.dueDate <= f.dueBefore)) continue;
      if (f.dueAfter && !(d.dueDate && d.dueDate >= f.dueAfter)) continue;
      if (f.overdue && !isOverdue(d, today)) continue;
      out.push({ node: n, derived: d, path: store.path(id), projectId, projectName: project.name });
    }
  }
  return out.slice(0, f.limit ?? 100);
}

export async function nodesForContact(ctx: Ctx, contactId: string): Promise<NodeRef[]> {
  return searchNodes(ctx, { ownerId: contactId, limit: 500 });
}

// ---------- today ----------

export interface TodayFlatItem extends TodayItem {
  projectId: string;
  projectName: string;
}

export interface TodayResponse {
  today: string;
  overdue: TodayFlatItem[];
  dueToday: TodayFlatItem[];
  dueTomorrow: TodayFlatItem[];
  nudgeDue: TodayFlatItem[];
  pending: ChangeWithContext[];
}

export async function getToday(ctx: Ctx): Promise<TodayResponse> {
  const today = todayIso(ctx);
  const projects = await loadProjects(ctx.sql);
  const pending = await listChanges(ctx, { status: 'pending' });
  const res: TodayResponse = { today, overdue: [], dueToday: [], dueTomorrow: [], nudgeDue: [], pending };
  for (const p of projects) {
    const store = await loadStore(ctx.sql, p.id);
    const derived = computeRollup(store);
    const view = computeToday(store, derived, pending.filter((c) => c.projectId === p.id), { today });
    const tag = (items: TodayItem[]): TodayFlatItem[] => items.map((i) => ({ ...i, projectId: p.id, projectName: p.name }));
    res.overdue.push(...tag(view.overdue));
    res.dueToday.push(...tag(view.dueToday));
    res.dueTomorrow.push(...tag(view.dueTomorrow));
    res.nudgeDue.push(...tag(view.nudgeDue));
  }
  const byDue = (a: TodayFlatItem, b: TodayFlatItem) => (a.derived.dueDate! < b.derived.dueDate! ? -1 : a.derived.dueDate! > b.derived.dueDate! ? 1 : 0);
  res.overdue.sort(byDue);
  res.nudgeDue.sort(byDue);
  return res;
}

// ---------- nudge ----------

export const DEFAULT_NUDGE_TEMPLATE = '关于「{title}」，原定 {due}，现在进度 {progress}%，方便同步一下进展吗？';

export async function nudge(ctx: Ctx, nodeId: string, opts: { template?: string; actor?: Actor } = {}): Promise<{ text: string; node: TNode }> {
  const { project, store, node } = await locateNode(ctx, nodeId);
  const derived = computeRollup(store).get(nodeId)!;
  const account = await loadAccount(ctx.sql);
  const contacts = await loadContacts(ctx.sql, { includeArchived: true });
  const owner = node.ownerId ? contacts.find((c) => c.id === node.ownerId)?.name ?? '' : account.name;
  const template = opts.template ?? account.settings.nudgeTemplate ?? DEFAULT_NUDGE_TEMPLATE;
  const due = derived.dueDate ? shortDate(derived.dueDate, currentYear(ctx)) : '未定';
  const text = template
    .replace(/\{title\}/g, node.title)
    .replace(/\{due\}/g, due)
    .replace(/\{progress\}/g, String(derived.progress))
    .replace(/\{owner\}/g, owner)
    .replace(/\{path\}/g, store.path(nodeId).join(' / '));
  const actor = opts.actor ?? 'user';
  const outcome = await applyOps(ctx, project.id, [
    { opId: randomUUID(), clientId: 'server', projectId: project.id, actor, at: nowIso(), type: 'update_node', nodeId, patch: { lastNudgedAt: nowIso() } },
  ]);
  const r = outcome.results[0]!;
  if (!r.ok) throw new HttpError(409, r.error ?? 'apply_failed', r.message ?? 'could not record nudge');
  return { text, node: r.node! };
}

// ---------- notes & dependencies ----------

export async function addNote(ctx: Ctx, nodeId: string, body: string, actor: Actor): Promise<NoteRow> {
  const { project } = await locateNode(ctx, nodeId);
  const rows = await ctx.sql`insert into note (id, node_id, body, actor_type) values (${randomUUID()}, ${nodeId}, ${body}, ${actor}) returning *`;
  await insertActivity(ctx.sql, { projectId: project.id, nodeId, actor, kind: 'note_added', payload: { body: body.slice(0, 200) } });
  return rowToNote(rows[0]!);
}

export async function addDependency(ctx: Ctx, fromNodeId: string, toNodeId: string, actor: Actor): Promise<void> {
  if (fromNodeId === toNodeId) throw badRequest('a node cannot depend on itself');
  const a = await locateNode(ctx, fromNodeId);
  const b = await locateNode(ctx, toNodeId);
  if (a.project.id !== b.project.id) throw badRequest('dependencies must stay within one project');
  await ctx.sql`insert into dependency (from_node, to_node) values (${fromNodeId}, ${toNodeId}) on conflict do nothing`;
  await insertActivity(ctx.sql, { projectId: a.project.id, nodeId: toNodeId, actor, kind: 'dependency_added', payload: { fromNode: fromNodeId, toNode: toNodeId } });
}

export async function removeDependency(ctx: Ctx, fromNodeId: string, toNodeId: string, actor: Actor): Promise<boolean> {
  const rows = await ctx.sql`delete from dependency where from_node = ${fromNodeId} and to_node = ${toNodeId} returning to_node`;
  if (rows.length) {
    const { project } = await locateNode(ctx, toNodeId);
    await insertActivity(ctx.sql, { projectId: project.id, nodeId: toNodeId, actor, kind: 'dependency_removed', payload: { fromNode: fromNodeId, toNode: toNodeId } });
  }
  return rows.length > 0;
}

// ---------- contacts ----------

export interface ContactInput {
  name?: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
  notes?: string | null;
  archivedAt?: string | null;
}

export async function listContactsQ(ctx: Ctx, opts: { query?: string; includeArchived?: boolean } = {}): Promise<Contact[]> {
  const q = opts.query?.trim();
  const rows = await ctx.sql`select * from contact where true
    ${opts.includeArchived ? ctx.sql`` : ctx.sql`and archived_at is null`}
    ${q ? ctx.sql`and (name ilike ${'%' + q + '%'} or coalesce(company, '') ilike ${'%' + q + '%'})` : ctx.sql``}
    order by name`;
  return rows.map(rowToContact);
}

export async function createContact(ctx: Ctx, input: ContactInput): Promise<Contact> {
  const name = input.name?.trim();
  if (!name) throw badRequest('name is required');
  const rows = await ctx.sql`insert into contact (name, company, email, phone, avatar_url, notes)
    values (${name}, ${input.company ?? null}, ${input.email ?? null}, ${input.phone ?? null}, ${input.avatarUrl ?? null}, ${input.notes ?? null}) returning *`;
  return rowToContact(rows[0]!);
}

export async function updateContact(ctx: Ctx, id: string, input: ContactInput): Promise<Contact> {
  const existing = await ctx.sql`select * from contact where id = ${id}`;
  if (!existing[0]) throw notFound('contact');
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    if (!input.name.trim()) throw badRequest('name must not be empty');
    patch.name = input.name.trim();
  }
  if (input.company !== undefined) patch.company = input.company;
  if (input.email !== undefined) patch.email = input.email;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.avatarUrl !== undefined) patch.avatar_url = input.avatarUrl;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.archivedAt !== undefined) patch.archived_at = input.archivedAt;
  if (Object.keys(patch).length === 0) return rowToContact(existing[0]);
  const rows = await ctx.sql`update contact set ${ctx.sql(patch)} where id = ${id} returning *`;
  return rowToContact(rows[0]!);
}

export async function archiveContact(ctx: Ctx, id: string): Promise<Contact> {
  return updateContact(ctx, id, { archivedAt: nowIso() });
}

export async function getContact(ctx: Ctx, id: string): Promise<Contact> {
  const rows = await ctx.sql`select * from contact where id = ${id}`;
  if (!rows[0]) throw notFound('contact');
  return rowToContact(rows[0]);
}

export { rowToNode };
