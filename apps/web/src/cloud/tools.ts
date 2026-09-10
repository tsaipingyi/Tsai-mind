/**
 * Page tools offered to `sample` in cloud mode. Names, descriptions and argument shapes mirror
 * apps/server/src/tools/registry.ts; each `execute` runs against the in-page DemoServer with actor
 * 'claude', so key-field edits become pending changes exactly like the real server's. Results are
 * kept compact (node lists trimmed to id/title/owner/dates/status, ≤ ~4 KB).
 */
import { computeRollup, rankBetween } from '@tsai-mind/core';
import type { Derived, NodePatch, Op, PlanMode, TNode } from '@tsai-mind/core';
import type { DemoServer, ProjectState } from '../demo/mockApi';
import { newId } from '../demo/mockApi';
import type { SampleTool } from './types';

export type ToolObserver = (name: string, input: Record<string, unknown>, result: unknown) => void;

const MAX_RESULT = 4096;
const MAX_TREE = 8192;

const isoDate = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };
const statusEnum = ['todo', 'in_progress', 'blocked', 'waiting', 'done'];

const SNAKE_TO_CAMEL: Record<string, keyof NodePatch> = {
  due_date: 'dueDate',
  start_date: 'startDate',
  owner_id: 'ownerId',
  estimate_hours: 'estimateHours',
  progress_mode: 'progressMode',
  date_mode: 'dateMode',
};

function normalizePatch(patch: Record<string, unknown>): NodePatch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[SNAKE_TO_CAMEL[k] ?? k] = v;
  return out as NodePatch;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const optStr = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v));
const optNum = (v: unknown): number | undefined => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

function trimNode(n: TNode, d?: Derived) {
  return {
    id: n.id,
    title: n.title,
    kind: n.kind,
    parentId: n.parentId,
    ownerId: n.ownerId,
    startDate: d ? d.startDate : n.startDate,
    dueDate: d ? d.dueDate : n.dueDate,
    status: d ? d.status : n.status,
    progress: d ? d.progress : n.progress,
    version: n.version,
  };
}

/** Keep a result small: shrink arrays first, then cut the JSON text. */
function compact(value: unknown, max = MAX_RESULT): unknown {
  let s = JSON.stringify(value);
  if (s.length <= max) return value;
  if (Array.isArray(value)) {
    let arr = value;
    while (arr.length > 1 && JSON.stringify(arr).length > max) arr = arr.slice(0, Math.ceil(arr.length / 2));
    return { truncated: true, items: arr };
  }
  if (value && typeof value === 'object') {
    const obj = { ...(value as Record<string, unknown>) };
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (Array.isArray(v) && v.length > 1) {
        let arr = v;
        while (arr.length > 1 && JSON.stringify({ ...obj, [k]: arr }).length > max) arr = arr.slice(0, Math.ceil(arr.length / 2));
        obj[k] = arr;
        if (arr.length !== v.length) obj[`${k}Truncated`] = true;
      }
    }
    s = JSON.stringify(obj);
    if (s.length <= max) return obj;
  }
  return { truncated: true, text: s.slice(0, max - 40) };
}

function cutText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…（已截断）` : s;
}

/** Drop outline lines deeper than `depth` levels (2-space indentation per level). */
export function limitOutlineDepth(outline: string, depth?: number): string {
  if (!depth || depth < 1) return outline;
  return outline
    .split('\n')
    .filter((line) => {
      const indent = /^ */.exec(line)![0].length;
      return indent / 2 < depth;
    })
    .join('\n');
}

export function buildTools(server: DemoServer, observe: ToolObserver): SampleTool[] {
  const claudeOp = (projectId: string): Pick<Op, 'opId' | 'clientId' | 'projectId' | 'actor' | 'at'> => ({
    opId: newId(),
    clientId: 'claude',
    projectId,
    actor: 'claude',
    at: new Date().toISOString(),
  });

  const singleOp = (ps: ProjectState, op: Op, reason?: string): unknown => {
    const out = server.applyOps(ps, [op], { actor: 'claude', clientId: 'claude', reason });
    const r = out.results[0]!;
    if (!r.ok) {
      if (r.error === 'version_conflict') throw new Error(`version_conflict: ${r.message ?? ''} current=${JSON.stringify(r.current ? trimNode(r.current) : null)}`);
      throw new Error(`${r.error ?? 'error'}: ${r.message ?? 'op failed'}`);
    }
    const node = r.node ? trimNode(r.node) : undefined;
    if (r.changeIds?.length && !r.serverSeq) return { status: 'pending', changeIds: r.changeIds, change_id: r.changeIds[0], node };
    if (r.changeIds?.length) return { status: 'partial', changeIds: r.changeIds, serverSeq: r.serverSeq, node };
    return { status: 'applied', serverSeq: r.serverSeq, node };
  };

  const rankAfter = (ps: ProjectState, parentId: string, afterId: string | undefined, excludeId?: string): string => {
    const siblings = ps.store.children(parentId).filter((s) => s.id !== excludeId);
    if (afterId) {
      const i = siblings.findIndex((s) => s.id === afterId);
      if (i < 0) throw new Error('not_found: after_id is not a child of the parent');
      return rankBetween(siblings[i]!.rank, siblings[i + 1]?.rank ?? null);
    }
    return rankBetween(siblings.length ? siblings[siblings.length - 1]!.rank : null, null);
  };

  const versionOf = (node: TNode, v: unknown): number => {
    const n = optNum(v);
    return n === undefined ? node.version : n;
  };

  const def = (name: string, description: string, inputSchema: SampleTool['inputSchema'], run: (input: Record<string, unknown>) => unknown): SampleTool => ({
    name,
    description,
    ...(inputSchema ? { inputSchema } : {}),
    execute: async (input) => {
      const args = (input ?? {}) as Record<string, unknown>;
      try {
        const result = compact(await run(args));
        observe(name, args, result);
        return result;
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        observe(name, args, { error: true, message });
        throw new Error(message);
      }
    },
  });

  return [
    def('list_projects', 'List projects with id, name, root title, overdue count and pending change count.', undefined, () =>
      server.projectRows().map((r) => ({ id: r.id, name: r.name, rootNodeId: r.rootNodeId, rootTitle: r.rootTitle, overdueCount: r.overdueCount, pendingCount: r.pendingCount, nodeCount: r.nodeCount, archived: !!r.archivedAt })),
    ),
    def(
      'get_tree',
      'Return a whole project tree. format "outline" gives an indented Markdown outline (each line: title [id] @owner dates status progress%); "json" gives nodes with derived rollup values. depth limits levels (1 = root only).',
      { type: 'object', properties: { project_id: { type: 'string' }, depth: { type: 'integer', minimum: 1 }, format: { type: 'string', enum: ['outline', 'json'] } }, required: ['project_id'] },
      (a) => {
        const ps = server.proj(str(a.project_id));
        if (a.format === 'json') {
          const derived = computeRollup(ps.store);
          return compact({ project: ps.project, nodes: ps.store.all().map((n) => trimNode(n, derived.get(n.id))), dependencies: ps.deps }, MAX_TREE);
        }
        return cutText(limitOutlineDepth(server.outline(ps), optNum(a.depth)), MAX_TREE);
      },
    ),
    def(
      'get_node',
      'Return one node with all fields, derived values, path, children, dependencies, the last activity entries and pending changes.',
      { type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'] },
      (a) => {
        const { ps, node } = server.locate(str(a.node_id));
        const derived = computeRollup(ps.store);
        return {
          ...node,
          derived: derived.get(node.id),
          path: ps.store.path(node.id),
          projectId: ps.project.id,
          children: ps.store.children(node.id).map((c) => ({ id: c.id, title: c.title })),
          dependsOn: ps.deps.filter((d) => d.toNode === node.id).map((d) => d.fromNode),
          blocks: ps.deps.filter((d) => d.fromNode === node.id).map((d) => d.toNode),
          pendingChanges: server.pendingChanges(ps.project.id).filter((c) => c.nodeId === node.id).map((c) => ({ id: c.id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, reason: c.reason })),
          activity: ps.activity
            .filter((x) => x.nodeId === node.id)
            .slice(-5)
            .map((x) => ({ kind: x.kind, actor: x.actor, at: x.createdAt })),
        };
      },
    ),
    def(
      'search_nodes',
      'Search nodes by title/description substring with optional filters. owner is a contact id or "me". Each result carries its path (ancestor titles) and project.',
      {
        type: 'object',
        properties: {
          query: { type: 'string' },
          project_id: { type: 'string' },
          owner: { type: 'string' },
          status: { type: 'string', enum: statusEnum },
          due_before: isoDate,
          due_after: isoDate,
          overdue: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      (a) => {
        const q = optStr(a.query)?.toLowerCase();
        const ownerId = a.owner === undefined ? undefined : a.owner === 'me' ? null : str(a.owner);
        const today = new Date().toISOString().slice(0, 10);
        const limit = Math.min(optNum(a.limit) ?? 20, 50);
        const rows = server
          .nodeRefs((n) => {
            if (a.project_id && n.projectId !== str(a.project_id)) return false;
            if (q && !n.title.toLowerCase().includes(q) && !(n.description ?? '').toLowerCase().includes(q)) return false;
            if (ownerId !== undefined && n.ownerId !== ownerId) return false;
            return true;
          })
          .filter((r) => {
            const d = r.derived;
            if (a.status && d.status !== a.status) return false;
            if (a.due_before && !(d.dueDate && d.dueDate <= str(a.due_before))) return false;
            if (a.due_after && !(d.dueDate && d.dueDate >= str(a.due_after))) return false;
            if (a.overdue === true && !(d.dueDate && d.dueDate < today && d.status !== 'done')) return false;
            return true;
          })
          .slice(0, limit)
          .map((r) => ({ ...trimNode(r.node, r.derived), path: r.path, projectId: r.projectId, projectName: r.projectName }));
        return rows;
      },
    ),
    def('today', 'Overdue, due today, due tomorrow, pending changes and nodes that should be nudged, across all projects.', undefined, () => {
      const t = server.today();
      const flat = (items: typeof t.overdue) => items.slice(0, 15).map((i) => ({ ...trimNode(i.node, i.derived), projectName: i.projectName, daysOverdue: i.daysOverdue }));
      return {
        today: t.today,
        overdue: flat(t.overdue),
        dueToday: flat(t.dueToday),
        dueTomorrow: flat(t.dueTomorrow),
        nudgeDue: flat(t.nudgeDue),
        pending: t.pending.slice(0, 15).map((c) => ({ id: c.id, nodeId: c.nodeId, nodeTitle: c.nodeTitle, field: c.field, newValue: c.newValue })),
      };
    }),
    def(
      'list_pending_changes',
      "Pending changes awaiting the owner's decision, optionally for one project.",
      { type: 'object', properties: { project_id: { type: 'string' } } },
      (a) => server.pendingChanges(optStr(a.project_id)).map((c) => ({ id: c.id, nodeId: c.nodeId, nodeTitle: c.nodeTitle, projectName: c.projectName, field: c.field, oldValue: c.oldValue, newValue: c.newValue, reason: c.reason, createdAt: c.createdAt })),
    ),
    def('list_contacts', 'Contacts (people tasks are assigned to), optionally filtered by a name/company substring.', { type: 'object', properties: { query: { type: 'string' } } }, (a) => {
      const q = optStr(a.query)?.toLowerCase();
      return server
        .liveContacts()
        .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.company ?? '').toLowerCase().includes(q))
        .map((c) => ({ id: c.id, name: c.name, company: c.company, email: c.email }));
    }),
    def(
      'create_contact',
      'Create a contact.',
      { type: 'object', properties: { name: { type: 'string' }, company: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } }, required: ['name'] },
      (a) => server.createContact({ name: str(a.name), company: optStr(a.company) ?? null, email: optStr(a.email) ?? null, phone: optStr(a.phone) ?? null }),
    ),
    def(
      'create_node',
      "Create a node under parent_id. Owner defaults to the parent's owner. after_id places it after that sibling (default: last). Applies immediately.",
      {
        type: 'object',
        properties: {
          parent_id: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string', enum: ['goal', 'task', 'milestone', 'note'] },
          owner_id: { type: ['string', 'null'] },
          start_date: { ...isoDate, type: ['string', 'null'] },
          due_date: { ...isoDate, type: ['string', 'null'] },
          estimate_hours: { type: ['number', 'null'] },
          priority: { type: 'integer', minimum: 1, maximum: 4 },
          description: { type: 'string' },
          after_id: { type: 'string' },
        },
        required: ['parent_id', 'title'],
      },
      (a) => {
        const { ps, node: parent } = server.locate(str(a.parent_id));
        const title = str(a.title).trim();
        if (!title) throw new Error('invalid: title is required');
        const kind = ['goal', 'task', 'milestone', 'note'].includes(str(a.kind)) ? (str(a.kind) as TNode['kind']) : 'task';
        const priority = optNum(a.priority);
        const op: Op = {
          ...claudeOp(ps.project.id),
          type: 'create_node',
          node: {
            id: newId(),
            projectId: ps.project.id,
            parentId: parent.id,
            rank: rankAfter(ps, parent.id, optStr(a.after_id)),
            title,
            kind,
            ownerId: a.owner_id === undefined ? parent.ownerId : a.owner_id === null ? null : str(a.owner_id),
            startDate: optStr(a.start_date) ?? null,
            dueDate: optStr(a.due_date) ?? null,
            estimateHours: optNum(a.estimate_hours) ?? null,
            priority: priority && priority >= 1 && priority <= 4 ? (priority as 1 | 2 | 3 | 4) : 3,
            description: optStr(a.description) ?? '',
          },
        };
        return singleOp(ps, op);
      },
    ),
    def(
      'update_node',
      'Update node fields. version should equal the node\'s current version (omit to skip the conflict check). Key fields (due_date, start_date, owner_id, status done) become pending changes for the owner to approve and the tool returns status "pending"; other fields apply immediately.',
      {
        type: 'object',
        properties: {
          node_id: { type: 'string' },
          version: { type: 'integer' },
          patch: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              kind: { type: 'string', enum: ['goal', 'task', 'milestone', 'note'] },
              owner_id: { type: ['string', 'null'], description: 'contact id, or null for the owner' },
              status: { type: 'string', enum: statusEnum },
              progress: { type: 'integer', minimum: 0, maximum: 100 },
              progress_mode: { type: 'string', enum: ['auto', 'manual'] },
              start_date: { ...isoDate, type: ['string', 'null'] },
              due_date: { ...isoDate, type: ['string', 'null'] },
              date_mode: { type: 'string', enum: ['auto', 'manual'] },
              estimate_hours: { type: ['number', 'null'] },
              priority: { type: 'integer', minimum: 1, maximum: 4 },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
          reason: { type: 'string' },
        },
        required: ['node_id', 'patch'],
      },
      (a) => {
        const { ps, node } = server.locate(str(a.node_id));
        const patch = normalizePatch((a.patch ?? {}) as Record<string, unknown>);
        if (Object.keys(patch).length === 0) throw new Error('invalid: patch is empty');
        return singleOp(ps, { ...claudeOp(ps.project.id), type: 'update_node', nodeId: node.id, patch, baseVersion: versionOf(node, a.version) }, optStr(a.reason));
      },
    ),
    def(
      'move_node',
      'Move a node under new_parent_id, after sibling after_id (default: last). Rejected when it would create a cycle. Applies immediately.',
      { type: 'object', properties: { node_id: { type: 'string' }, version: { type: 'integer' }, new_parent_id: { type: 'string' }, after_id: { type: 'string' } }, required: ['node_id', 'new_parent_id'] },
      (a) => {
        const { ps, node } = server.locate(str(a.node_id));
        const parentId = str(a.new_parent_id);
        return singleOp(ps, { ...claudeOp(ps.project.id), type: 'move_node', nodeId: node.id, parentId, rank: rankAfter(ps, parentId, optStr(a.after_id), node.id), baseVersion: versionOf(node, a.version) });
      },
    ),
    def(
      'delete_node',
      'Soft-delete a node and its subtree. This is a key operation: it becomes a pending change for the owner to approve.',
      { type: 'object', properties: { node_id: { type: 'string' }, version: { type: 'integer' }, reason: { type: 'string' } }, required: ['node_id'] },
      (a) => {
        const { ps, node } = server.locate(str(a.node_id));
        const v = versionOf(node, a.version);
        if (v !== node.version) throw new Error(`version_conflict: expected version ${v}, have ${node.version}`);
        return singleOp(ps, { ...claudeOp(ps.project.id), type: 'delete_node', nodeId: node.id }, optStr(a.reason));
      },
    ),
    def(
      'set_owner',
      "Change a node's owner (contact id, or null for the account owner). Key field: becomes a pending change.",
      { type: 'object', properties: { node_id: { type: 'string' }, version: { type: 'integer' }, contact_id: { type: ['string', 'null'] }, reason: { type: 'string' } }, required: ['node_id', 'contact_id'] },
      (a) => {
        const { ps, node } = server.locate(str(a.node_id));
        const ownerId = a.contact_id === null || a.contact_id === undefined || a.contact_id === '' ? null : str(a.contact_id);
        return singleOp(ps, { ...claudeOp(ps.project.id), type: 'update_node', nodeId: node.id, patch: { ownerId }, baseVersion: versionOf(node, a.version) }, optStr(a.reason));
      },
    ),
    def(
      'add_dependency',
      'Add a finish-to-start dependency: from_node_id must finish before to_node_id starts. Rejected when it would create a cycle. Applies immediately.',
      { type: 'object', properties: { from_node_id: { type: 'string' }, to_node_id: { type: 'string' } }, required: ['from_node_id', 'to_node_id'] },
      (a) => {
        server.addDependency(str(a.from_node_id), str(a.to_node_id), 'claude');
        return { ok: true, fromNode: str(a.from_node_id), toNode: str(a.to_node_id) };
      },
    ),
    def(
      'nudge',
      'Render a nudge message for a node (template placeholders: {title} {due} {progress} {owner}) and record last_nudged_at. Returns the text.',
      { type: 'object', properties: { node_id: { type: 'string' }, template: { type: 'string' } }, required: ['node_id'] },
      (a) => {
        const r = server.nudge(str(a.node_id), optStr(a.template), 'claude');
        return { text: r.text, node: trimNode(r.node) };
      },
    ),
    def(
      'draft_plan',
      'Parse an outline (same syntax as get_tree outline: indentation = hierarchy, [id] = existing node, @name = owner, dates, status, NN%, ◆ milestone, "← title" dependency) and diff it against the subtree under parent_id. mode: append (create only), sync (create + update, no delete), replace (subtree mirrors the outline; missing nodes are deleted). Nothing is applied; the owner reviews the draft in the app.',
      { type: 'object', properties: { project_id: { type: 'string' }, parent_id: { type: 'string' }, outline: { type: 'string' }, mode: { type: 'string', enum: ['append', 'sync', 'replace'] } }, required: ['project_id', 'parent_id', 'outline'] },
      (a) => {
        const ps = server.proj(str(a.project_id));
        const outline = str(a.outline);
        if (!outline.trim()) throw new Error('invalid: outline is empty');
        const mode = (['append', 'sync', 'replace'].includes(str(a.mode)) ? str(a.mode) : 'append') as PlanMode;
        const b = server.draftPlan(ps, str(a.parent_id), outline, mode, 'claude');
        return { batch_id: b.id, batchId: b.id, status: b.status, summary: b.diff.summary, errors: b.diff.errors, created: b.diff.created.slice(0, 30) };
      },
    ),
  ];
}
