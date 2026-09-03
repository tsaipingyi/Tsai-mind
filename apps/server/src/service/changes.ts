import { randomUUID } from 'node:crypto';
import type { Actor, Change, Op } from '@tsai-mind/core';
import type { Ctx } from './context.js';
import { nowIso } from './context.js';
import { rowToChange } from '../mapping.js';
import { HttpError, notFound } from '../errors.js';
import { applyOps, type OpResult } from './ops.js';
import { insertActivity } from './store.js';

export interface ChangeWithContext extends Change {
  nodeTitle: string;
  projectId: string;
  projectName: string;
}

const toCtxChange = (r: Record<string, unknown>): ChangeWithContext => ({
  ...rowToChange(r),
  nodeTitle: r.node_title as string,
  projectId: r.project_id as string,
  projectName: r.project_name as string,
});

export async function expireChanges(ctx: Ctx): Promise<void> {
  await ctx.sql`update change set status = 'expired', decided_at = now() where status = 'pending' and expires_at < now()`;
}

export async function listChanges(ctx: Ctx, filter: { status?: string; projectId?: string } = {}): Promise<ChangeWithContext[]> {
  await expireChanges(ctx);
  const status = filter.status ?? 'pending';
  const rows = await ctx.sql`
    select c.*, n.title as node_title, n.project_id, p.name as project_name
    from change c join node n on n.id = c.node_id join project p on p.id = n.project_id
    where c.status = ${status}
      ${filter.projectId ? ctx.sql`and n.project_id = ${filter.projectId}` : ctx.sql``}
    order by c.created_at desc`;
  return rows.map(toCtxChange);
}

export async function getChange(ctx: Ctx, id: string): Promise<ChangeWithContext> {
  await expireChanges(ctx);
  const rows = await ctx.sql`
    select c.*, n.title as node_title, n.project_id, p.name as project_name
    from change c join node n on n.id = c.node_id join project p on p.id = n.project_id
    where c.id = ${id}`;
  if (!rows[0]) throw notFound('change');
  return toCtxChange(rows[0]);
}

/** The op that realises an approved change. */
function opForChange(c: ChangeWithContext, actor: Actor): Op {
  const base = { opId: randomUUID(), clientId: 'server', projectId: c.projectId, actor, at: nowIso() };
  if (c.field === 'delete') return { ...base, type: 'delete_node', nodeId: c.nodeId };
  if (c.field === 'status') return { ...base, type: 'update_node', nodeId: c.nodeId, patch: { status: (c.newValue as 'done') ?? 'done' } };
  return { ...base, type: 'update_node', nodeId: c.nodeId, patch: { [c.field]: c.newValue } };
}

export interface DecisionResult {
  change: ChangeWithContext;
  result?: OpResult;
}

export async function approveChange(ctx: Ctx, id: string, opts: { actor?: Actor; note?: string } = {}): Promise<DecisionResult> {
  const c = await getChange(ctx, id);
  if (c.status !== 'pending') throw new HttpError(409, 'not_pending', `change is ${c.status}`);
  const actor = opts.actor ?? 'user';
  const outcome = await applyOps(ctx, c.projectId, [opForChange(c, actor)]);
  const result = outcome.results[0]!;
  if (!result.ok) throw new HttpError(409, result.error ?? 'apply_failed', result.message ?? 'could not apply change', { current: result.current });
  await ctx.sql`update change set status = 'approved', decided_at = now() where id = ${id}`;
  await insertActivity(ctx.sql, { projectId: c.projectId, nodeId: c.nodeId, actor, kind: 'change_decided', payload: { changeId: id, field: c.field, decision: 'approve', note: opts.note ?? null } });
  const updated = await getChange(ctx, id);
  ctx.hub.broadcast({ type: 'change', change: updated });
  return { change: updated, result };
}

export async function rejectChange(ctx: Ctx, id: string, opts: { actor?: Actor; note?: string; status?: 'rejected' | 'expired' } = {}): Promise<DecisionResult> {
  const c = await getChange(ctx, id);
  if (c.status !== 'pending') throw new HttpError(409, 'not_pending', `change is ${c.status}`);
  const status = opts.status ?? 'rejected';
  await ctx.sql`update change set status = ${status}, decided_at = now() where id = ${id}`;
  await insertActivity(ctx.sql, { projectId: c.projectId, nodeId: c.nodeId, actor: opts.actor ?? 'user', kind: 'change_decided', payload: { changeId: id, field: c.field, decision: status === 'rejected' ? 'reject' : 'withdraw', note: opts.note ?? null } });
  const updated = await getChange(ctx, id);
  ctx.hub.broadcast({ type: 'change', change: updated });
  return { change: updated };
}

/** Claude withdrawing its own proposal: the row is marked expired so it no longer blocks the field. */
export async function withdrawChange(ctx: Ctx, id: string): Promise<DecisionResult> {
  return rejectChange(ctx, id, { actor: 'claude', status: 'expired' });
}
