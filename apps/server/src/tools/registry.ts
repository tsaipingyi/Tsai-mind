/**
 * One tool registry shared by the MCP server (`src/mcp.ts`) and the in-app assistant (`src/assistant`).
 * Each tool has a zod input schema, the scope it needs, and a `run` that returns a JSON-serialisable
 * value (a string result is delivered as plain text). Failures throw `HttpError` with a machine code.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NodePatch, Op } from '@tsai-mind/core';
import { rankBetween } from '@tsai-mind/core';
import type { Scope } from '../auth.js';
import { HttpError } from '../errors.js';
import type { Ctx } from '../service/context.js';
import { nowIso } from '../service/context.js';
import { applyOps, undoOp } from '../service/ops.js';
import { approveChange, getChange, listChanges, rejectChange, withdrawChange } from '../service/changes.js';
import { applyPlanBatch, discardPlanBatch, draftPlan, getPlanBatch } from '../service/plans.js';
import * as q from '../service/queries.js';

export interface ToolAuth {
  scopes: Scope[];
  label?: string;
}

export interface ToolDef<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  schema: S;
  scope: Scope;
  run(input: z.infer<S>, ctx: Ctx, auth: ToolAuth): Promise<unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any>;

const tool = <S extends z.ZodObject<z.ZodRawShape>>(def: ToolDef<S>): AnyTool => def;

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => new HttpError(status, error, message, extra);

/** Run a tool with the scope check applied. Throws HttpError on any failure. */
export async function runTool(def: AnyTool, input: unknown, ctx: Ctx, auth: ToolAuth): Promise<unknown> {
  if (!auth.scopes.includes(def.scope)) throw fail(403, 'forbidden', `this token lacks the "${def.scope}" scope`);
  const parsed = (def.schema as z.ZodObject<z.ZodRawShape>).safeParse(input ?? {});
  if (!parsed.success) throw fail(400, 'invalid', parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '));
  return def.run(parsed.data, ctx, auth);
}

export function findTool(name: string): AnyTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Tools usable with the given scopes (the assistant only offers what the token can run). */
export function toolsForScopes(scopes: Scope[]): AnyTool[] {
  return TOOLS.filter((t) => scopes.includes(t.scope));
}

// ---------- helpers ----------

const SNAKE_TO_CAMEL: Record<string, keyof NodePatch> = {
  due_date: 'dueDate',
  start_date: 'startDate',
  owner_id: 'ownerId',
  estimate_hours: 'estimateHours',
  progress_mode: 'progressMode',
  date_mode: 'dateMode',
};

/** Accept snake_case or camelCase keys in a patch. */
function normalizePatch(patch: Record<string, unknown>): NodePatch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[SNAKE_TO_CAMEL[k] ?? k] = v;
  return out as NodePatch;
}

const claudeOp = (projectId: string): Pick<Op, 'opId' | 'clientId' | 'projectId' | 'actor' | 'at'> => ({
  opId: randomUUID(),
  clientId: 'claude',
  projectId,
  actor: 'claude',
  at: nowIso(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD');
const patchSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    kind: z.enum(['goal', 'task', 'milestone', 'note']),
    owner_id: z.string().nullable().describe('contact id, or null for the owner'),
    status: z.enum(['todo', 'in_progress', 'blocked', 'waiting', 'done']),
    progress: z.number().int().min(0).max(100),
    progress_mode: z.enum(['auto', 'manual']),
    start_date: isoDate.nullable(),
    due_date: isoDate.nullable(),
    date_mode: z.enum(['auto', 'manual']),
    estimate_hours: z.number().nonnegative().nullable(),
    priority: z.number().int().min(1).max(4),
    tags: z.array(z.string()),
  })
  .partial();

/** Result of a single-node op as the tools report it. */
async function singleOp(ctx: Ctx, projectId: string, op: Op, reason?: string): Promise<unknown> {
  const out = await applyOps(ctx, projectId, [op], { actor: 'claude', clientId: 'claude', reason });
  const r = out.results[0]!;
  if (!r.ok) {
    if (r.error === 'version_conflict') throw fail(409, 'version_conflict', r.message ?? 'version conflict', { status: 409, current: r.current });
    throw fail(r.error === 'not_found' ? 404 : 400, r.error ?? 'error', r.message ?? 'op failed');
  }
  if (r.changeIds && r.changeIds.length && !r.serverSeq) return { status: 'pending', changeIds: r.changeIds, change_id: r.changeIds[0], node: r.node };
  if (r.changeIds && r.changeIds.length) return { status: 'partial', changeIds: r.changeIds, serverSeq: r.serverSeq, node: r.node };
  return { status: 'applied', serverSeq: r.serverSeq, node: r.node };
}

// ---------- the registry ----------

export const TOOLS: AnyTool[] = [
  // ----- read -----
  tool({
    name: 'list_projects',
    description: 'List projects with id, name, root title, overdue count and pending change count.',
    schema: z.object({}),
    scope: 'read',
    run: (_a, ctx) => q.listProjectSummaries(ctx),
  }),
  tool({
    name: 'get_tree',
    description:
      'Return a whole project tree. format "outline" gives an indented Markdown outline (each line: title [id] @owner dates status progress%); "json" gives nodes with derived rollup values, the critical path and dependency slips. depth limits levels (1 = root only).',
    schema: z.object({ project_id: z.string(), depth: z.number().int().min(1).optional(), format: z.enum(['json', 'outline']).default('outline') }),
    scope: 'read',
    run: async ({ project_id, depth, format }, ctx) => (format === 'json' ? q.getTreeJson(ctx, project_id, depth) : q.getOutline(ctx, project_id, undefined, depth)),
  }),
  tool({
    name: 'get_node',
    description: 'Return one node with all fields, derived values, path, children, dependencies, notes, the last 20 activity entries and pending changes.',
    schema: z.object({ node_id: z.string() }),
    scope: 'read',
    run: ({ node_id }, ctx) => q.getNodeDetail(ctx, node_id),
  }),
  tool({
    name: 'search_nodes',
    description: 'Search nodes by title/description substring with optional filters. owner is a contact id or "me". Each result carries its path (ancestor titles) and project.',
    schema: z.object({
      query: z.string().optional(),
      project_id: z.string().optional(),
      owner: z.string().optional(),
      status: z.enum(['todo', 'in_progress', 'blocked', 'waiting', 'done']).optional(),
      due_before: isoDate.optional(),
      due_after: isoDate.optional(),
      overdue: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    scope: 'read',
    run: (a, ctx) =>
      q.searchNodes(ctx, { query: a.query, projectId: a.project_id, ownerId: a.owner === 'me' ? null : a.owner, status: a.status, dueBefore: a.due_before, dueAfter: a.due_after, overdue: a.overdue, limit: a.limit }),
  }),
  tool({
    name: 'today',
    description: 'Overdue, due today, due tomorrow, pending changes and nodes that should be nudged, across all projects.',
    schema: z.object({}),
    scope: 'read',
    run: (_a, ctx) => q.getToday(ctx),
  }),
  tool({
    name: 'list_pending_changes',
    description: "Pending changes awaiting the owner's decision, optionally for one project.",
    schema: z.object({ project_id: z.string().optional() }),
    scope: 'read',
    run: ({ project_id }, ctx) => listChanges(ctx, { projectId: project_id }),
  }),
  tool({
    name: 'get_activity',
    description: 'Activity stream of a project, newest first. since is an ISO timestamp.',
    schema: z.object({ project_id: z.string(), since: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }),
    scope: 'read',
    run: ({ project_id, since, limit }, ctx) => q.listActivity(ctx, project_id, { since, limit }),
  }),
  tool({
    name: 'list_contacts',
    description: 'Contacts (people tasks are assigned to), optionally filtered by a name/company substring.',
    schema: z.object({ query: z.string().optional() }),
    scope: 'read',
    run: ({ query }, ctx) => q.listContactsQ(ctx, { query }),
  }),
  tool({
    name: 'contact_workload',
    description: 'All live nodes owned by a contact across projects, with path, project and derived values.',
    schema: z.object({ contact_id: z.string() }),
    scope: 'read',
    run: async ({ contact_id }, ctx) => ({ contact: await q.getContact(ctx, contact_id), nodes: await q.nodesForContact(ctx, contact_id) }),
  }),

  // ----- write: single node -----
  tool({
    name: 'create_node',
    description: "Create a node under parent_id. Owner defaults to the parent's owner. after_id places it after that sibling (default: last). Applies immediately.",
    schema: z.object({
      parent_id: z.string(),
      title: z.string(),
      kind: z.enum(['goal', 'task', 'milestone', 'note']).optional(),
      owner_id: z.string().nullable().optional(),
      start_date: isoDate.nullable().optional(),
      due_date: isoDate.nullable().optional(),
      estimate_hours: z.number().nonnegative().nullable().optional(),
      priority: z.number().int().min(1).max(4).optional(),
      description: z.string().optional(),
      after_id: z.string().optional(),
    }),
    scope: 'write',
    run: async (a, ctx) => {
      const { project, store, node: parent } = await q.locateNode(ctx, a.parent_id);
      const siblings = store.children(parent.id);
      let rank: string;
      if (a.after_id) {
        const i = siblings.findIndex((s) => s.id === a.after_id);
        if (i < 0) throw fail(404, 'not_found', 'after_id is not a child of parent_id');
        rank = rankBetween(siblings[i]!.rank, siblings[i + 1]?.rank ?? null);
      } else rank = rankBetween(siblings.length ? siblings[siblings.length - 1]!.rank : null, null);
      const op: Op = {
        ...claudeOp(project.id),
        type: 'create_node',
        node: {
          id: randomUUID(), projectId: project.id, parentId: parent.id, rank, title: a.title, kind: a.kind ?? 'task',
          ownerId: a.owner_id === undefined ? parent.ownerId : a.owner_id, startDate: a.start_date ?? null, dueDate: a.due_date ?? null,
          estimateHours: a.estimate_hours ?? null, priority: (a.priority as 1 | 2 | 3 | 4 | undefined) ?? 3, description: a.description ?? '',
        },
      };
      return singleOp(ctx, project.id, op);
    },
  }),
  tool({
    name: 'update_node',
    description:
      "Update node fields. version must equal the node's current version (otherwise version_conflict with the current node). Key fields (due_date, start_date, owner_id, status done) become pending changes for the owner to approve and the tool returns status \"pending\"; other fields apply immediately.",
    schema: z.object({ node_id: z.string(), version: z.number().int(), patch: patchSchema, reason: z.string().optional() }),
    scope: 'write',
    run: async ({ node_id, version, patch, reason }, ctx) => {
      const { project } = await q.locateNode(ctx, node_id);
      const p = normalizePatch(patch as Record<string, unknown>);
      if (Object.keys(p).length === 0) throw fail(400, 'invalid', 'patch is empty');
      return singleOp(ctx, project.id, { ...claudeOp(project.id), type: 'update_node', nodeId: node_id, patch: p, baseVersion: version }, reason);
    },
  }),
  tool({
    name: 'move_node',
    description: 'Move a node under new_parent_id, after sibling after_id (default: last). Rejected when it would create a cycle. Applies immediately.',
    schema: z.object({ node_id: z.string(), version: z.number().int(), new_parent_id: z.string(), after_id: z.string().optional() }),
    scope: 'write',
    run: async ({ node_id, version, new_parent_id, after_id }, ctx) => {
      const { project, store } = await q.locateNode(ctx, node_id);
      const siblings = store.children(new_parent_id).filter((s) => s.id !== node_id);
      let rank: string;
      if (after_id) {
        const i = siblings.findIndex((s) => s.id === after_id);
        if (i < 0) throw fail(404, 'not_found', 'after_id is not a child of new_parent_id');
        rank = rankBetween(siblings[i]!.rank, siblings[i + 1]?.rank ?? null);
      } else rank = rankBetween(siblings.length ? siblings[siblings.length - 1]!.rank : null, null);
      return singleOp(ctx, project.id, { ...claudeOp(project.id), type: 'move_node', nodeId: node_id, parentId: new_parent_id, rank, baseVersion: version });
    },
  }),
  tool({
    name: 'delete_node',
    description: 'Soft-delete a node and its subtree. This is a key operation: it becomes a pending change for the owner to approve.',
    schema: z.object({ node_id: z.string(), version: z.number().int(), reason: z.string().optional() }),
    scope: 'write',
    run: async ({ node_id, version, reason }, ctx) => {
      const { project, node } = await q.locateNode(ctx, node_id);
      if (node.version !== version) throw fail(409, 'version_conflict', `expected version ${version}, have ${node.version}`, { status: 409, current: node });
      return singleOp(ctx, project.id, { ...claudeOp(project.id), type: 'delete_node', nodeId: node_id }, reason);
    },
  }),
  tool({
    name: 'set_owner',
    description: "Change a node's owner (contact id, or null for the account owner). Key field: becomes a pending change.",
    schema: z.object({ node_id: z.string(), version: z.number().int(), contact_id: z.string().nullable(), reason: z.string().optional() }),
    scope: 'write',
    run: async ({ node_id, version, contact_id, reason }, ctx) => {
      const { project } = await q.locateNode(ctx, node_id);
      return singleOp(ctx, project.id, { ...claudeOp(project.id), type: 'update_node', nodeId: node_id, patch: { ownerId: contact_id }, baseVersion: version }, reason);
    },
  }),
  tool({
    name: 'add_dependency',
    description: 'Add a finish-to-start dependency: from_node_id must finish before to_node_id starts. Rejected when it would create a cycle. Applies immediately.',
    schema: z.object({ from_node_id: z.string(), to_node_id: z.string() }),
    scope: 'write',
    run: async ({ from_node_id, to_node_id }, ctx) => {
      await q.addDependency(ctx, from_node_id, to_node_id, 'claude');
      return { ok: true, fromNode: from_node_id, toNode: to_node_id };
    },
  }),
  tool({
    name: 'remove_dependency',
    description: 'Remove a dependency. Applies immediately.',
    schema: z.object({ from_node_id: z.string(), to_node_id: z.string() }),
    scope: 'write',
    run: async ({ from_node_id, to_node_id }, ctx) => ({ ok: true, removed: await q.removeDependency(ctx, from_node_id, to_node_id, 'claude') }),
  }),
  tool({
    name: 'add_note',
    description: 'Append a timeline note to a node, attributed to Claude.',
    schema: z.object({ node_id: z.string(), body: z.string().min(1) }),
    scope: 'write',
    run: ({ node_id, body }, ctx) => q.addNote(ctx, node_id, body, 'claude'),
  }),
  tool({
    name: 'nudge',
    description: 'Render a nudge message for a node (template placeholders: {title} {due} {progress} {owner}) and record last_nudged_at. Returns the text.',
    schema: z.object({ node_id: z.string(), template: z.string().optional() }),
    scope: 'write',
    run: ({ node_id, template }, ctx) => q.nudge(ctx, node_id, { template, actor: 'claude' }),
  }),
  tool({
    name: 'undo',
    description: "Undo one of Claude's own operations from the last 7 days. Pass server_seq (from op results) or the op_id.",
    schema: z.object({ server_seq: z.number().int().optional(), op_id: z.string().optional() }),
    scope: 'write',
    run: async ({ server_seq, op_id }, ctx) => {
      let seq = server_seq;
      if (seq === undefined && op_id) {
        const rows = await ctx.sql`select server_seq from op where op_id = ${op_id}`;
        if (!rows[0]) throw fail(404, 'not_found', 'op not found');
        seq = Number(rows[0].server_seq);
      }
      if (seq === undefined) throw fail(400, 'invalid', 'server_seq or op_id is required');
      const rows = await ctx.sql`select actor_type from op where server_seq = ${seq}`;
      if (!rows[0]) throw fail(404, 'not_found', 'op not found');
      if (rows[0].actor_type !== 'claude') throw fail(403, 'forbidden', 'only operations made by Claude can be undone here');
      try {
        const out = await undoOp(ctx, seq, 'claude');
        return { undoneSeq: out.undoneSeq, results: out.results };
      } catch (err) {
        const e = err as Error & { code?: string };
        throw fail(e.code === 'not_found' ? 404 : 409, e.code ?? 'error', e.message);
      }
    },
  }),

  // ----- write: changes -----
  tool({
    name: 'decide_change',
    description: 'Approve or reject a pending change. Requires the decide scope.',
    schema: z.object({ change_id: z.string(), decision: z.enum(['approve', 'reject']), note: z.string().optional() }),
    scope: 'decide',
    run: ({ change_id, decision, note }, ctx) =>
      decision === 'approve' ? approveChange(ctx, change_id, { actor: 'claude', note }) : rejectChange(ctx, change_id, { actor: 'claude', note }),
  }),
  tool({
    name: 'withdraw_change',
    description: 'Withdraw a pending change that Claude proposed.',
    schema: z.object({ change_id: z.string() }),
    scope: 'write',
    run: async ({ change_id }, ctx) => {
      const c = await getChange(ctx, change_id);
      if (c.source !== 'claude') throw fail(403, 'forbidden', 'only changes proposed by Claude can be withdrawn');
      return withdrawChange(ctx, change_id);
    },
  }),

  // ----- write: plan batches -----
  tool({
    name: 'draft_plan',
    description:
      'Parse an outline (same syntax as get_tree outline: indentation = hierarchy, [id] = existing node, @name = owner, dates, status, NN%, ◆ milestone, "← title" dependency) and diff it against the subtree under parent_id. mode: append (create only), sync (create + update, no delete), replace (subtree mirrors the outline; missing nodes are deleted). Nothing is applied; returns the draft batch with its summary and preview URL.',
    schema: z.object({ project_id: z.string(), parent_id: z.string(), outline: z.string().min(1), mode: z.enum(['append', 'sync', 'replace']).default('append') }),
    scope: 'write',
    run: async ({ project_id, parent_id, outline, mode }, ctx) => {
      const b = await draftPlan(ctx, { projectId: project_id, parentId: parent_id, outline, mode, actor: 'claude' });
      return { batch_id: b.id, status: b.status, summary: b.diff.summary, errors: b.diff.errors, created: b.diff.created, deletes: b.diff.deletes, preview_url: b.previewUrl };
    },
  }),
  tool({
    name: 'get_plan_batch',
    description: 'Full diff of a plan batch: ops, summary, created nodes, errors and status.',
    schema: z.object({ batch_id: z.string() }),
    scope: 'read',
    run: ({ batch_id }, ctx) => getPlanBatch(ctx, batch_id),
  }),
  tool({
    name: 'apply_plan_batch',
    description: 'Apply a draft plan batch. Requires the decide scope.',
    schema: z.object({ batch_id: z.string() }),
    scope: 'decide',
    run: ({ batch_id }, ctx) => applyPlanBatch(ctx, batch_id),
  }),
  tool({
    name: 'discard_plan_batch',
    description: 'Discard a draft plan batch.',
    schema: z.object({ batch_id: z.string() }),
    scope: 'write',
    run: ({ batch_id }, ctx) => discardPlanBatch(ctx, batch_id),
  }),

  // ----- projects & contacts -----
  tool({
    name: 'create_project',
    description: 'Create a project. With an outline, the nodes are created under the root (a single outline root titled like the project becomes the root itself).',
    schema: z.object({ name: z.string().min(1), outline: z.string().optional() }),
    scope: 'write',
    run: async ({ name, outline }, ctx) => {
      const r = await q.createProject(ctx, { name, outline, actor: 'claude' });
      return { project: r.project, nodeCount: r.nodes.length, warnings: r.warnings };
    },
  }),
  tool({
    name: 'create_contact',
    description: 'Create a contact.',
    schema: z.object({ name: z.string().min(1), company: z.string().optional(), email: z.string().optional(), phone: z.string().optional() }),
    scope: 'write',
    run: (a, ctx) => q.createContact(ctx, a),
  }),
];
