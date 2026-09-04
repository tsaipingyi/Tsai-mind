import { randomUUID } from 'node:crypto';
import { parseOutline, planOps, type Actor, type Op, type PlanMode, type PlanResult } from '@tsai-mind/core';
import type { Ctx } from './context.js';
import { currentYear, nowIso, withProjectLock } from './context.js';
import { rowToPlanBatch, type PlanBatchRow } from '../mapping.js';
import { HttpError, badRequest, notFound } from '../errors.js';
import { applyInTx, type OpResult } from './ops.js';
import { insertActivity, loadContacts, loadStore } from './store.js';
import { notifyDependencySlips, notifyPlanDrafted } from '../notify.js';

export interface PlanDiff extends PlanResult {
  actor: Actor;
  /** Titles of nodes a replace-mode batch will delete, for the preview. */
  deletes: { id: string; title: string }[];
}

export interface PlanBatch extends PlanBatchRow {
  diff: PlanDiff;
  previewUrl: string;
}

const withPreview = (ctx: Ctx, b: PlanBatchRow): PlanBatch => ({ ...b, diff: b.diff as PlanDiff, previewUrl: `${ctx.config.publicUrl}/plan-batches/${b.id}` });

export async function getPlanBatch(ctx: Ctx, id: string): Promise<PlanBatch> {
  const rows = await ctx.sql`select * from plan_batch where id = ${id}`;
  if (!rows[0]) throw notFound('plan batch');
  return withPreview(ctx, rowToPlanBatch(rows[0]));
}

export async function listPlanBatches(ctx: Ctx, projectId: string, status: string = 'draft'): Promise<PlanBatch[]> {
  const rows = await ctx.sql`select * from plan_batch where project_id = ${projectId} and status = ${status} order by created_at desc`;
  return rows.map((r) => withPreview(ctx, rowToPlanBatch(r)));
}

/** Parse an outline, diff it against the subtree and store the result as a draft batch. Nothing is applied. */
export async function draftPlan(
  ctx: Ctx,
  input: { projectId: string; parentId: string; outline: string; mode: PlanMode; actor: Actor; clientId?: string },
): Promise<PlanBatch> {
  const store = await loadStore(ctx.sql, input.projectId);
  const parent = store.live(input.parentId);
  if (!parent) throw notFound('parent node');
  if (parent.projectId !== input.projectId) throw badRequest('parent belongs to another project');
  const parsed = parseOutline(input.outline, { year: currentYear(ctx) });
  const contacts = await loadContacts(ctx.sql, { includeArchived: true });
  const plan = planOps(store, parsed, {
    projectId: input.projectId,
    parentId: input.parentId,
    mode: input.mode,
    contacts,
    newId: randomUUID,
    opBase: { clientId: input.clientId ?? (input.actor === 'claude' ? 'claude' : 'web'), actor: input.actor, at: nowIso() },
  });
  const deletes = plan.ops
    .filter((o): o is Extract<Op, { type: 'delete_node' }> => o.type === 'delete_node')
    .map((o) => ({ id: o.nodeId, title: store.get(o.nodeId)?.title ?? '' }));
  const diff: PlanDiff = { ...plan, actor: input.actor, deletes };
  const rows = await ctx.sql`
    insert into plan_batch (project_id, parent_id, mode, outline, diff)
    values (${input.projectId}, ${input.parentId}, ${input.mode}, ${input.outline}, ${ctx.sql.json(diff as never)})
    returning *`;
  const batch = withPreview(ctx, rowToPlanBatch(rows[0]!));
  ctx.hub.broadcast({ type: 'batch', batch });
  if (input.actor === 'claude') await notifyPlanDrafted(ctx, batch).catch((err) => ctx.log.error(err, 'notify: batch push failed'));
  return batch;
}

export interface ApplyBatchResult {
  batch: PlanBatch;
  results: OpResult[];
  serverSeq: number;
}

/**
 * Apply a draft batch. Ops run as actor 'user' (the owner approved them); the activity row
 * records the batch's original actor. Version conflicts fail individual ops; the rest still apply.
 */
export async function applyPlanBatch(ctx: Ctx, id: string): Promise<ApplyBatchResult> {
  const batch = await getPlanBatch(ctx, id);
  if (batch.status !== 'draft') throw new HttpError(409, 'not_draft', `plan batch is ${batch.status}`);
  return withProjectLock(batch.projectId, async () => {
    const ops: Op[] = batch.diff.ops.map((o) => ({ ...o, opId: randomUUID(), at: nowIso() }));
    const out = await ctx.sql.begin(async (tx) => {
      const r = await applyInTx(tx, batch.projectId, ops, { actor: 'user', clientId: 'server' });
      const failed = r.results.filter((x) => !x.ok).length;
      await tx`update plan_batch set status = 'applied', applied_at = now(), result = ${tx.json({ results: r.results, failed } as never)} where id = ${id}`;
      await insertActivity(tx, {
        projectId: batch.projectId, nodeId: batch.parentId, actor: batch.diff.actor ?? 'claude', kind: 'batch_applied',
        payload: { batchId: id, mode: batch.mode, summary: batch.diff.summary, failed },
      });
      return r;
    });
    for (const m of out.messages) ctx.hub.broadcast(m);
    await notifyDependencySlips(ctx, batch.projectId, out.slips.before, out.slips.after).catch((err) => ctx.log.error(err, 'notify: dependency push failed'));
    const updated = await getPlanBatch(ctx, id);
    ctx.hub.broadcast({ type: 'batch', batch: updated });
    return { batch: updated, results: out.results, serverSeq: out.serverSeq };
  });
}

export async function discardPlanBatch(ctx: Ctx, id: string): Promise<PlanBatch> {
  const batch = await getPlanBatch(ctx, id);
  if (batch.status !== 'draft') throw new HttpError(409, 'not_draft', `plan batch is ${batch.status}`);
  await ctx.sql`update plan_batch set status = 'discarded' where id = ${id}`;
  const updated = await getPlanBatch(ctx, id);
  ctx.hub.broadcast({ type: 'batch', batch: updated });
  return updated;
}
