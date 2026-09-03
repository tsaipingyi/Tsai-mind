import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { NodePatch, Op } from '@tsai-mind/core';
import { rankBetween } from '@tsai-mind/core';
import { hasScope, type AuthInfo, type Scope } from './auth.js';
import { HttpError } from './errors.js';
import type { Ctx } from './service/context.js';
import { nowIso } from './service/context.js';
import { applyOps, undoOp } from './service/ops.js';
import { approveChange, getChange, listChanges, rejectChange, withdrawChange } from './service/changes.js';
import { applyPlanBatch, discardPlanBatch, draftPlan, getPlanBatch } from './service/plans.js';
import * as q from './service/queries.js';
import { loadStore } from './service/store.js';

// ---------- helpers ----------

type ToolExtra = { authInfo?: { scopes: string[]; clientId: string; extra?: Record<string, unknown> } };

const json = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (error: string, message: string, extra: Record<string, unknown> = {}): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error, message, ...extra }, null, 2) }],
});

function requireScope(extra: ToolExtra, scope: Scope): CallToolResult | null {
  const scopes = extra.authInfo?.scopes ?? [];
  return scopes.includes(scope) ? null : fail('forbidden', `this token lacks the "${scope}" scope`);
}

/** Run a tool body, turning thrown HttpErrors into isError results. */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return fail(err.code, err.message, err.extra);
    const e = err as Error & { code?: string };
    return fail(e.code ?? 'error', e.message ?? String(err));
  }
}

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

/** Result of a single-node op as the MCP tools report it. */
async function singleOp(ctx: Ctx, projectId: string, op: Op, reason?: string): Promise<CallToolResult> {
  const out = await applyOps(ctx, projectId, [op], { actor: 'claude', clientId: 'claude', reason });
  const r = out.results[0]!;
  if (!r.ok) {
    if (r.error === 'version_conflict') return fail('version_conflict', r.message ?? 'version conflict', { status: 409, current: r.current });
    return fail(r.error ?? 'error', r.message ?? 'op failed');
  }
  if (r.changeIds && r.changeIds.length && !r.serverSeq) return json({ status: 'pending', changeIds: r.changeIds, change_id: r.changeIds[0], node: r.node });
  if (r.changeIds && r.changeIds.length) return json({ status: 'partial', changeIds: r.changeIds, serverSeq: r.serverSeq, node: r.node });
  return json({ status: 'applied', serverSeq: r.serverSeq, node: r.node });
}

// ---------- server ----------

export function createMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'tsai-mind', version: '0.1.0' });

  // ----- read -----
  server.registerTool('list_projects', { description: 'List projects with id, name, root title, overdue count and pending change count.', inputSchema: {} }, async (_a, extra) =>
    guard(async () => requireScope(extra as ToolExtra, 'read') ?? json(await q.listProjectSummaries(ctx))));

  server.registerTool(
    'get_tree',
    {
      description: 'Return a whole project tree. format "outline" gives an indented Markdown outline (each line: title [id] @owner dates status progress%); "json" gives nodes with derived rollup values. depth limits levels (1 = root only).',
      inputSchema: { project_id: z.string(), depth: z.number().int().min(1).optional(), format: z.enum(['json', 'outline']).default('outline') },
    },
    async ({ project_id, depth, format }, extra) =>
      guard(async () => {
        const denied = requireScope(extra as ToolExtra, 'read');
        if (denied) return denied;
        if (format === 'json') return json(await q.getTreeJson(ctx, project_id, depth));
        return text(await q.getOutline(ctx, project_id, undefined, depth));
      }),
  );

  server.registerTool(
    'get_node',
    { description: 'Return one node with all fields, derived values, path, children, dependencies, notes, the last 20 activity entries and pending changes.', inputSchema: { node_id: z.string() } },
    async ({ node_id }, extra) => guard(async () => requireScope(extra as ToolExtra, 'read') ?? json(await q.getNodeDetail(ctx, node_id))),
  );

  server.registerTool(
    'search_nodes',
    {
      description: 'Search nodes by title/description substring with optional filters. owner is a contact id or "me". Each result carries its path (ancestor titles) and project.',
      inputSchema: {
        query: z.string().optional(),
        project_id: z.string().optional(),
        owner: z.string().optional(),
        status: z.enum(['todo', 'in_progress', 'blocked', 'waiting', 'done']).optional(),
        due_before: isoDate.optional(),
        due_after: isoDate.optional(),
        overdue: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (a, extra) =>
      guard(async () =>
        requireScope(extra as ToolExtra, 'read') ??
        json(await q.searchNodes(ctx, { query: a.query, projectId: a.project_id, ownerId: a.owner === 'me' ? null : a.owner, status: a.status, dueBefore: a.due_before, dueAfter: a.due_after, overdue: a.overdue, limit: a.limit })),
      ),
  );

  server.registerTool('today', { description: 'Overdue, due today, due tomorrow, pending changes and nodes that should be nudged, across all projects.', inputSchema: {} }, async (_a, extra) =>
    guard(async () => requireScope(extra as ToolExtra, 'read') ?? json(await q.getToday(ctx))));

  server.registerTool('list_pending_changes', { description: 'Pending changes awaiting the owner\'s decision, optionally for one project.', inputSchema: { project_id: z.string().optional() } }, async ({ project_id }, extra) =>
    guard(async () => requireScope(extra as ToolExtra, 'read') ?? json(await listChanges(ctx, { projectId: project_id }))));

  server.registerTool(
    'get_activity',
    { description: 'Activity stream of a project, newest first. since is an ISO timestamp.', inputSchema: { project_id: z.string(), since: z.string().optional(), limit: z.number().int().min(1).max(500).optional() } },
    async ({ project_id, since, limit }, extra) => guard(async () => requireScope(extra as ToolExtra, 'read') ?? json(await q.listActivity(ctx, project_id, { since, limit }))),
  );

  server.registerTool('list_contacts', { description: 'Contacts (people tasks are assigned to), optionally filtered by a name/company substring.', inputSchema: { query: z.string().optional() } }, async ({ query }, extra) =>
    guard(async () => requireScope(extra as ToolExtra, 'read') ?? json(await q.listContactsQ(ctx, { query }))));

  server.registerTool('contact_workload', { description: 'All live nodes owned by a contact across projects, with path, project and derived values.', inputSchema: { contact_id: z.string() } }, async ({ contact_id }, extra) =>
    guard(async () => requireScope(extra as ToolExtra, 'read') ?? json({ contact: await q.getContact(ctx, contact_id), nodes: await q.nodesForContact(ctx, contact_id) })));

  // ----- write: single node -----
  server.registerTool(
    'create_node',
    {
      description: 'Create a node under parent_id. Owner defaults to the parent\'s owner. after_id places it after that sibling (default: last). Applies immediately.',
      inputSchema: {
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
      },
    },
    async (a, extra) =>
      guard(async () => {
        const denied = requireScope(extra as ToolExtra, 'write');
        if (denied) return denied;
        const { project, store, node: parent } = await q.locateNode(ctx, a.parent_id);
        const siblings = store.children(parent.id);
        let rank: string;
        if (a.after_id) {
          const i = siblings.findIndex((s) => s.id === a.after_id);
          if (i < 0) return fail('not_found', 'after_id is not a child of parent_id');
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
      }),
  );

  server.registerTool(
    'update_node',
    {
      description: 'Update node fields. version must equal the node\'s current version (otherwise version_conflict with the current node). Key fields (due_date, start_date, owner_id, status done) become pending changes for the owner to approve and the tool returns status "pending"; other fields apply immediately.',
      inputSchema: { node_id: z.string(), version: z.number().int(), patch: patchSchema, reason: z.string().optional() },
    },
    async ({ node_id, version, patch, reason }, extra) =>
      guard(async () => {
        const denied = requireScope(extra as ToolExtra, 'write');
        if (denied) return denied;
        const { project } = await q.locateNode(ctx, node_id);
        const p = normalizePatch(patch as Record<string, unknown>);
        if (Object.keys(p).length === 0) return fail('invalid', 'patch is empty');
        return singleOp(ctx, project.id, { ...claudeOp(project.id), type: 'update_node', nodeId: node_id, patch: p, baseVersion: version }, reason);
      }),
  );

  server.registerTool(
    'move_node',
    {
      description: 'Move a node under new_parent_id, after sibling after_id (default: last). Rejected when it would create a cycle. Applies immediately.',
      inputSchema: { node_id: z.string(), version: z.number().int(), new_parent_id: z.string(), after_id: z.string().optional() },
    },
    async ({ node_id, version, new_parent_id, after_id }, extra) =>
      guard(async () => {
        const denied = requireScope(extra as ToolExtra, 'write');
        if (denied) return denied;
        const { project, store } = await q.locateNode(ctx, node_id);
        const siblings = store.children(new_parent_id).filter((s) => s.id !== node_id);
        let rank: string;
        if (after_id) {
          const i = siblings.findIndex((s) => s.id === after_id);
          if (i < 0) return fail('not_found', 'after_id is not a child of new_parent_id');
          rank = rankBetween(siblings[i]!.rank, siblings[i + 1]?.rank ?? null);
        } else rank = rankBetween(siblings.length ? siblings[siblings.length - 1]!.rank : null, null);
        return singleOp(ctx, project.id, { ...claudeOp(project.id), type: 'move_node', nodeId: node_id, parentId: new_parent_id, rank, baseVersion: version });
      }),
  );

  server.registerTool(
    'delete_node',
    { description: 'Soft-delete a node and its subtree. This is a key operation: it becomes a pending change for the owner to approve.', inputSchema: { node_id: z.string(), version: z.number().int(), reason: z.string().optional() } },
    async ({ node_id, version, reason }, extra) =>
      guard(async () => {
        const denied = requireScope(extra as ToolExtra, 'write');
        if (denied) return denied;
        const { project, node } = await q.locateNode(ctx, node_id);
        if (node.version !== version) return fail('version_conflict', `expected version ${version}, have ${node.version}`, { status: 409, current: node });
        return singleOp(ctx, project.id, { ...claudeOp(project.id), type: 'delete_node', nodeId: node_id }, reason);
      }),
  );

  server.registerTool(
    'set_owner',
    { description: 'Change a node\'s owner (contact id, or null for the account owner). Key field: becomes a pending change.', inputSchema: { node_id: z.string(), version: z.number().int(), contact_id: z.string().nullable(), reason: z.string().optional() } },
    async ({ node_id, version, contact_id, reason }, extra) =>
      guard(async () => {
        const denied = requireScope(extra as ToolExtra, 'write');
        if (denied) return denied;
        const { project } = await q.locateNode(ctx, node_id);
        return singleOp(ctx, project.id, { ...claudeOp(project.id), type: 'update_node', nodeId: node_id, patch: { ownerId: contact_id }, baseVersion: version }, reason);
      }),
  );

  server.registerTool('add_dependency', { description: 'Add a finish-to-start dependency: from_node_id must finish before to_node_id starts. Applies immediately.', inputSchema: { from_node_id: z.string(), to_node_id: z.string() } }, async ({ from_node_id, to_node_id }, extra) =>
    guard(async () => {
      const denied = requireScope(extra as ToolExtra, 'write');
      if (denied) return denied;
      await q.addDependency(ctx, from_node_id, to_node_id, 'claude');
      return json({ ok: true, fromNode: from_node_id, toNode: to_node_id });
    }));

  server.registerTool('remove_dependency', { description: 'Remove a dependency. Applies immediately.', inputSchema: { from_node_id: z.string(), to_node_id: z.string() } }, async ({ from_node_id, to_node_id }, extra) =>
    guard(async () => {
      const denied = requireScope(extra as ToolExtra, 'write');
      if (denied) return denied;
      return json({ ok: true, removed: await q.removeDependency(ctx, from_node_id, to_node_id, 'claude') });
    }));

  server.registerTool('add_note', { description: 'Append a timeline note to a node, attributed to Claude.', inputSchema: { node_id: z.string(), body: z.string().min(1) } }, async ({ node_id, body }, extra) =>
    guard(async () => requireScope(extra as ToolExtra, 'write') ?? json(await q.addNote(ctx, node_id, body, 'claude'))));

  server.registerTool(
    'nudge',
    { description: 'Render a nudge message for a node (template placeholders: {title} {due} {progress} {owner}) and record last_nudged_at. Returns the text.', inputSchema: { node_id: z.string(), template: z.string().optional() } },
    async ({ node_id, template }, extra) => guard(async () => requireScope(extra as ToolExtra, 'write') ?? json(await q.nudge(ctx, node_id, { template, actor: 'claude' }))),
  );

  server.registerTool(
    'undo',
    { description: 'Undo one of Claude\'s own operations from the last 7 days. Pass server_seq (from op results) or the op_id.', inputSchema: { server_seq: z.number().int().optional(), op_id: z.string().optional() } },
    async ({ server_seq, op_id }, extra) =>
      guard(async () => {
        const denied = requireScope(extra as ToolExtra, 'write');
        if (denied) return denied;
        let seq = server_seq;
        if (seq === undefined && op_id) {
          const rows = await ctx.sql`select server_seq from op where op_id = ${op_id}`;
          if (!rows[0]) return fail('not_found', 'op not found');
          seq = Number(rows[0].server_seq);
        }
        if (seq === undefined) return fail('invalid', 'server_seq or op_id is required');
        const rows = await ctx.sql`select actor_type from op where server_seq = ${seq}`;
        if (!rows[0]) return fail('not_found', 'op not found');
        if (rows[0].actor_type !== 'claude') return fail('forbidden', 'only operations made by Claude can be undone here');
        const out = await undoOp(ctx, seq, 'claude');
        return json({ undoneSeq: out.undoneSeq, results: out.results });
      }),
  );

  // ----- write: changes -----
  server.registerTool(
    'decide_change',
    { description: 'Approve or reject a pending change. Requires the decide scope.', inputSchema: { change_id: z.string(), decision: z.enum(['approve', 'reject']), note: z.string().optional() } },
    async ({ change_id, decision, note }, extra) =>
      guard(async () => {
        const denied = requireScope(extra as ToolExtra, 'decide');
        if (denied) return denied;
        const r = decision === 'approve' ? await approveChange(ctx, change_id, { actor: 'claude', note }) : await rejectChange(ctx, change_id, { actor: 'claude', note });
        return json(r);
      }),
  );

  server.registerTool('withdraw_change', { description: 'Withdraw a pending change that Claude proposed.', inputSchema: { change_id: z.string() } }, async ({ change_id }, extra) =>
    guard(async () => {
      const denied = requireScope(extra as ToolExtra, 'write');
      if (denied) return denied;
      const c = await getChange(ctx, change_id);
      if (c.source !== 'claude') return fail('forbidden', 'only changes proposed by Claude can be withdrawn');
      return json(await withdrawChange(ctx, change_id));
    }));

  // ----- write: plan batches -----
  server.registerTool(
    'draft_plan',
    {
      description: 'Parse an outline (same syntax as get_tree outline: indentation = hierarchy, [id] = existing node, @name = owner, dates, status, NN%, ◆ milestone, "← title" dependency) and diff it against the subtree under parent_id. mode: append (create only), sync (create + update, no delete), replace (subtree mirrors the outline; missing nodes are deleted). Nothing is applied; returns the draft batch with its summary and preview URL.',
      inputSchema: { project_id: z.string(), parent_id: z.string(), outline: z.string().min(1), mode: z.enum(['append', 'sync', 'replace']).default('append') },
    },
    async ({ project_id, parent_id, outline, mode }, extra) =>
      guard(async () => {
        const denied = requireScope(extra as ToolExtra, 'write');
        if (denied) return denied;
        const b = await draftPlan(ctx, { projectId: project_id, parentId: parent_id, outline, mode, actor: 'claude' });
        return json({ batch_id: b.id, status: b.status, summary: b.diff.summary, errors: b.diff.errors, created: b.diff.created, deletes: b.diff.deletes, preview_url: b.previewUrl });
      }),
  );

  server.registerTool('get_plan_batch', { description: 'Full diff of a plan batch: ops, summary, created nodes, errors and status.', inputSchema: { batch_id: z.string() } }, async ({ batch_id }, extra) =>
    guard(async () => requireScope(extra as ToolExtra, 'read') ?? json(await getPlanBatch(ctx, batch_id))));

  server.registerTool('apply_plan_batch', { description: 'Apply a draft plan batch. Requires the decide scope.', inputSchema: { batch_id: z.string() } }, async ({ batch_id }, extra) =>
    guard(async () => requireScope(extra as ToolExtra, 'decide') ?? json(await applyPlanBatch(ctx, batch_id))));

  server.registerTool('discard_plan_batch', { description: 'Discard a draft plan batch.', inputSchema: { batch_id: z.string() } }, async ({ batch_id }, extra) =>
    guard(async () => requireScope(extra as ToolExtra, 'write') ?? json(await discardPlanBatch(ctx, batch_id))));

  // ----- projects & contacts -----
  server.registerTool(
    'create_project',
    { description: 'Create a project. With an outline, the nodes are created under the root (a single outline root titled like the project becomes the root itself).', inputSchema: { name: z.string().min(1), outline: z.string().optional() } },
    async ({ name, outline }, extra) =>
      guard(async () => {
        const denied = requireScope(extra as ToolExtra, 'write');
        if (denied) return denied;
        const r = await q.createProject(ctx, { name, outline, actor: 'claude' });
        return json({ project: r.project, nodeCount: r.nodes.length, warnings: r.warnings });
      }),
  );

  server.registerTool(
    'create_contact',
    { description: 'Create a contact.', inputSchema: { name: z.string().min(1), company: z.string().optional(), email: z.string().optional(), phone: z.string().optional() } },
    async (a, extra) => guard(async () => requireScope(extra as ToolExtra, 'write') ?? json(await q.createContact(ctx, a))),
  );

  // ----- resources -----
  server.registerResource('today', 'tsaimind://today', { description: 'Today: overdue, due today, pending changes and nodes to nudge.', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await q.getToday(ctx), null, 2) }],
  }));

  server.registerResource(
    'project-outline',
    new ResourceTemplate('tsaimind://project/{id}/outline', {
      list: async () => ({
        resources: (await q.listProjectSummaries(ctx)).map((p) => ({ uri: `tsaimind://project/${p.id}/outline`, name: p.name, mimeType: 'text/markdown' })),
      }),
    }),
    { description: 'Project outline in Markdown.', mimeType: 'text/markdown' },
    async (uri, vars) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await q.getOutline(ctx, String(vars.id)) }] }),
  );

  // ----- prompts -----
  server.registerPrompt('weekly_review', { description: 'Weekly review: recent activity, overdue items, pending changes, nudges due, and suggestions for next week.', argsSchema: { project_id: z.string().optional() } }, async ({ project_id }) => {
    const today = await q.getToday(ctx);
    const activity = project_id ? await q.listActivity(ctx, project_id, { since: new Date(Date.now() - 7 * 86_400_000).toISOString() }) : [];
    const body = [
      `Today is ${today.today}.`,
      `Overdue (${today.overdue.length}):`, ...today.overdue.map((i) => `- ${i.projectName} / ${i.path.join(' / ')} / ${i.node.title}: due ${i.derived.dueDate}, ${i.daysOverdue} days late, ${i.derived.progress}%`),
      `Due today (${today.dueToday.length}):`, ...today.dueToday.map((i) => `- ${i.projectName} / ${i.node.title}`),
      `Pending changes (${today.pending.length}):`, ...today.pending.map((c) => `- ${c.projectName} / ${c.nodeTitle}: ${c.field} ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`),
      `Nudges due (${today.nudgeDue.length}):`, ...today.nudgeDue.map((i) => `- ${i.projectName} / ${i.node.title}`),
      ...(project_id ? [`Activity in the last 7 days (${activity.length}):`, ...activity.slice(0, 50).map((a) => `- ${a.createdAt.slice(0, 10)} ${a.actor} ${a.kind} ${JSON.stringify(a.payload)}`)] : []),
      'Summarise the week, list what slipped and why, and propose concrete adjustments for next week.',
    ].join('\n');
    return { messages: [{ role: 'user', content: { type: 'text', text: body } }] };
  });

  server.registerPrompt('nudge_draft', { description: 'Draft a nudge message for a node.', argsSchema: { node_id: z.string() } }, async ({ node_id }) => {
    const d = await q.getNodeDetail(ctx, node_id);
    const body = `Write a short, polite follow-up message about the task "${d.node.title}" (project ${d.projectName}, path ${d.path.join(' / ')}), due ${d.derived.dueDate ?? 'unset'}, progress ${d.derived.progress}%, status ${d.derived.status}. Use the same language as the task title.`;
    return { messages: [{ role: 'user', content: { type: 'text', text: body } }] };
  });

  return server;
}

// ---------- HTTP wiring (stateful Streamable HTTP sessions) ----------

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  tokenId: string;
}

export async function registerMcp(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const sessions = new Map<string, McpSession>();

  const authInfoFor = (auth: AuthInfo) => ({ token: auth.tokenId, clientId: auth.tokenId, scopes: auth.scopes, extra: { label: auth.label } });

  const handle = async (request: FastifyRequest, reply: { hijack: () => unknown; raw: import('node:http').ServerResponse }) => {
    const sessionId = request.headers['mcp-session-id'];
    const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    const body = request.method === 'POST' ? request.body : undefined;
    let session = sid ? sessions.get(sid) : undefined;

    if (session && session.tokenId !== request.auth.tokenId) {
      reply.raw.writeHead(403, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'forbidden', message: 'session belongs to another token' }));
      reply.hijack();
      return;
    }

    if (!session) {
      const isInit = request.method === 'POST' && body && typeof body === 'object' && (body as { method?: string }).method === 'initialize';
      if (!isInit) {
        reply.raw.writeHead(sid ? 404 : 400, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sid ? 'session not found' : 'missing session; send initialize first' }, id: null }));
        reply.hijack();
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, tokenId: request.auth.tokenId });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      const server = createMcpServer(ctx);
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      session = { transport, server, tokenId: request.auth.tokenId };
    }

    reply.hijack();
    const raw = request.raw as Parameters<StreamableHTTPServerTransport['handleRequest']>[0];
    raw.auth = authInfoFor(request.auth) as (typeof raw)['auth'];
    await session.transport.handleRequest(raw, reply.raw, body);
  };

  app.post('/mcp', async (request, reply) => handle(request, reply));
  app.get('/mcp', async (request, reply) => handle(request, reply));
  app.delete('/mcp', async (request, reply) => handle(request, reply));

  app.addHook('onClose', async () => {
    for (const s of sessions.values()) await s.transport.close().catch(() => {});
    sessions.clear();
  });
}
