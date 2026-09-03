import { randomUUID } from 'node:crypto';
import {
  opNeedsConfirmation,
  splitPatch,
  type Actor,
  type Change,
  type NodePatch,
  type Op,
  type TNode,
  type TreeStore,
} from '@tsai-mind/core';
import type { Tx } from '../db.js';
import { rowToChange } from '../mapping.js';
import type { Ctx } from './context.js';
import { nowIso, withProjectLock } from './context.js';
import { confirmationSettings, insertActivity, loadAccount, loadStore, persistNodes } from './store.js';
import type { RealtimeMessage } from '../realtime.js';
import { notifyPendingChanges } from '../notify.js';

export interface OpResult {
  opId: string;
  ok: boolean;
  serverSeq?: number;
  error?: string;
  message?: string;
  current?: TNode;
  /** Pending change ids created for guarded fields (actor claude). */
  changeIds?: string[];
  /** The node after the op (when it touched a single node). */
  node?: TNode;
}

export interface ApplyOutcome {
  results: OpResult[];
  serverSeq: number;
  changes: Change[];
}

export interface ApplyOptions {
  /** Force the actor for every op (MCP forces 'claude'). */
  actor?: Actor;
  clientId?: string;
  /** Reason recorded on pending changes created by these ops. */
  reason?: string;
  /** Apply directly even for actor 'claude' (used by undo, which reverses an already-approved state). */
  skipConfirmation?: boolean;
}

const GUARDED_FIELD_NAMES = ['dueDate', 'startDate', 'ownerId', 'status'] as const;

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

function activityFor(op: Op, before: TNode | undefined, changed: TNode[]): { kind: string; payload: unknown } {
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

async function upsertPendingChange(
  tx: Tx,
  c: { nodeId: string; field: string; oldValue: unknown; newValue: unknown; reason: string | null; source: 'claude' | 'batch' },
): Promise<{ change: Change; created: boolean }> {
  const existing = await tx`select * from change where node_id = ${c.nodeId} and field = ${c.field} and status = 'pending'`;
  if (existing[0]) return { change: rowToChange(existing[0]), created: false };
  const rows = await tx`
    insert into change (id, node_id, field, old_value, new_value, reason, source)
    values (${randomUUID()}, ${c.nodeId}, ${c.field}, ${tx.json(c.oldValue as never)}, ${tx.json(c.newValue as never)}, ${c.reason}, ${c.source})
    returning *`;
  return { change: rowToChange(rows[0]!), created: true };
}

/**
 * Apply ops to a project inside one transaction, in order. Each op succeeds or fails on its own.
 * Claude's guarded edits become pending `change` rows instead of being applied.
 */
export async function applyOps(ctx: Ctx, projectId: string, ops: Op[], opts: ApplyOptions = {}): Promise<ApplyOutcome> {
  return withProjectLock(projectId, async () => {
    const outcome = await ctx.sql.begin(async (tx) => applyInTx(tx, projectId, ops, opts));
    for (const m of outcome.messages) ctx.hub.broadcast(m);
    // Newly proposed changes (Claude touching key fields) go to the owner's phone, one push per node.
    if (outcome.changes.length) await notifyPendingChanges(ctx, projectId, outcome.changes, opts.reason ?? null).catch((err) => ctx.log.error(err, 'notify: change push failed'));
    return { results: outcome.results, serverSeq: outcome.serverSeq, changes: outcome.changes };
  });
}

/** Same as applyOps but inside an existing transaction; returns the realtime messages to send after commit. */
export async function applyInTx(
  tx: Tx,
  projectId: string,
  ops: Op[],
  opts: ApplyOptions = {},
): Promise<ApplyOutcome & { messages: RealtimeMessage[] }> {
  const account = await loadAccount(tx);
  const settings = confirmationSettings(account.settings);
  const store = await loadStore(tx, projectId);
  const results: OpResult[] = [];
  const messages: RealtimeMessage[] = [];
  const newChanges: Change[] = [];
  const seqRow = await tx`select coalesce(max(server_seq), 0) as seq from op where project_id = ${projectId}`;
  let serverSeq = Number(seqRow[0]!.seq);

  const opIds = ops.map((o) => o.opId);
  const seen = new Map<string, number>();
  if (opIds.length) {
    for (const r of await tx`select op_id, server_seq from op where op_id in ${tx(opIds)}`) seen.set(r.op_id as string, Number(r.server_seq));
  }

  for (const raw of ops) {
    const op: Op = { ...raw, projectId, actor: opts.actor ?? raw.actor, clientId: opts.clientId ?? raw.clientId };
    const dup = seen.get(op.opId);
    if (dup !== undefined) {
      results.push({ opId: op.opId, ok: true, serverSeq: dup });
      continue;
    }
    const now = nowIso();
    let effective: Op = op;
    const changeIds: string[] = [];

    if (op.actor === 'claude' && !opts.skipConfirmation) {
      // Whole-op confirmation (delete)
      if (opNeedsConfirmation(op, settings) && op.type === 'delete_node') {
        const n = store.live(op.nodeId);
        if (!n) {
          results.push({ opId: op.opId, ok: false, error: 'not_found', message: 'node not found' });
          continue;
        }
        const { change, created } = await upsertPendingChange(tx, {
          nodeId: n.id, field: 'delete', oldValue: null, newValue: true, reason: opts.reason ?? null, source: 'claude',
        });
        if (created) {
          newChanges.push(change);
          await insertActivity(tx, { projectId, nodeId: n.id, actor: 'claude', kind: 'change_proposed', payload: { changeId: change.id, field: 'delete', title: n.title } });
        }
        results.push({ opId: op.opId, ok: true, changeIds: [change.id], node: n });
        continue;
      }
      if (op.type === 'update_node') {
        const n = store.live(op.nodeId);
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
          const { change, created } = await upsertPendingChange(tx, {
            nodeId: n.id, field, oldValue: n[field], newValue: guarded[field], reason: opts.reason ?? null, source: 'claude',
          });
          changeIds.push(change.id);
          if (created) {
            newChanges.push(change);
            await insertActivity(tx, { projectId, nodeId: n.id, actor: 'claude', kind: 'change_proposed', payload: { changeId: change.id, field, from: n[field], to: guarded[field], title: n.title } });
          }
        }
        if (Object.keys(direct).length === 0) {
          results.push({ opId: op.opId, ok: true, changeIds, node: n });
          continue;
        }
        effective = { ...op, patch: direct };
      }
    }

    const dateErr = validateDates(store, effective);
    if (dateErr) {
      results.push({ opId: op.opId, ok: false, error: 'invalid', message: dateErr });
      continue;
    }

    const targetId = effective.type === 'create_node' ? effective.node.id : effective.nodeId;
    const before = store.get(targetId);
    const inverse = store.inverseOf(effective);
    const res = store.apply(effective, now);
    if (!res.ok) {
      results.push({ opId: op.opId, ok: false, error: res.error, message: res.message, current: res.current });
      continue;
    }

    await persistNodes(tx, res.changed);
    const inserted = await tx`
      insert into op (project_id, op_id, client_id, actor_type, type, payload, inverse, base_version)
      values (${projectId}, ${op.opId}, ${op.clientId}, ${op.actor}, ${effective.type}, ${tx.json(effective as never)},
              ${inverse ? tx.json(inverse as never) : null}, ${'baseVersion' in effective ? (effective.baseVersion ?? null) : null})
      returning server_seq`;
    serverSeq = Number(inserted[0]!.server_seq);
    const act = activityFor(effective, before, res.changed);
    await insertActivity(tx, { projectId, nodeId: targetId, actor: op.actor, kind: act.kind, payload: act.payload });

    // A direct edit by the owner supersedes any pending proposal on the same field.
    if (op.actor !== 'claude' && effective.type === 'update_node') {
      const fields = Object.keys(effective.patch).map((f) => (f === 'status' && effective.type === 'update_node' && effective.patch.status === 'done' ? 'status' : f));
      await tx`update change set status = 'expired', decided_at = now()
        where node_id = ${targetId} and status = 'pending' and field in ${tx(fields)}`;
    }

    messages.push({ type: 'op', serverSeq, op: effective });
    const node = res.changed.find((n) => n.id === targetId) ?? res.changed[0];
    results.push({ opId: op.opId, ok: true, serverSeq, node, ...(changeIds.length ? { changeIds } : {}) });
  }

  for (const c of newChanges) messages.push({ type: 'change', change: c });
  return { results, serverSeq, changes: newChanges, messages };
}

const UNDO_WINDOW_DAYS = 7;

/** Undo an op by applying its stored inverse as a new op (actor 'user'). Only ops from the last 7 days. */
export async function undoOp(ctx: Ctx, serverSeq: number, actor: Actor = 'user'): Promise<ApplyOutcome & { undoneSeq: number }> {
  const rows = await ctx.sql`select * from op where server_seq = ${serverSeq}`;
  const row = rows[0];
  if (!row) throw Object.assign(new Error('op not found'), { code: 'not_found' });
  if (row.undone_by) throw Object.assign(new Error('op already undone'), { code: 'already_undone' });
  if (!row.inverse) throw Object.assign(new Error('op cannot be undone'), { code: 'not_invertible' });
  const age = Date.now() - new Date(row.received_at as string).getTime();
  if (age > UNDO_WINDOW_DAYS * 86_400_000) throw Object.assign(new Error('op is older than 7 days'), { code: 'too_old' });
  const projectId = row.project_id as string;
  const inverse = row.inverse as Op;
  const undo: Op = { ...inverse, opId: randomUUID(), actor, clientId: 'server', at: nowIso() };
  const outcome = await applyOps(ctx, projectId, [undo], { skipConfirmation: true });
  const r = outcome.results[0]!;
  if (r.ok && r.serverSeq) {
    await ctx.sql`update op set undone_by = ${r.serverSeq} where server_seq = ${serverSeq}`;
    await insertActivity(ctx.sql, { projectId, nodeId: 'nodeId' in undo ? undo.nodeId : undo.node.id, actor, kind: 'undone', payload: { serverSeq, undoneBy: r.serverSeq } });
  }
  return { ...outcome, undoneSeq: serverSeq };
}
