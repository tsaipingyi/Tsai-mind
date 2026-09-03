/**
 * Owner notifications: write a `notification` row, push it to the registered devices.
 * Toggles live in account.settings.notifications (dueSoon, overdue, nudgeDue, digest; default true).
 * change / batch / dependency pushes are not toggleable (DESIGN §4.4).
 */
import { shortDate, type Change } from '@tsai-mind/core';
import type { Sql } from './db.js';
import { notFound } from './errors.js';
import type { PushCategory, PushData } from './push.js';
import type { Ctx } from './service/context.js';
import { currentYear } from './service/context.js';
import { loadAccount, loadContacts, type AccountSettings, type NotificationToggles } from './service/store.js';

export type NotificationKind = 'change_proposed' | 'batch_ready' | 'due_summary' | 'nudge_due' | 'digest' | 'dependency_slip';

const CATEGORY_OF: Record<NotificationKind, PushCategory> = {
  change_proposed: 'change',
  batch_ready: 'batch',
  due_summary: 'due',
  nudge_due: 'nudge',
  digest: 'digest',
  dependency_slip: 'nudge',
};

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  nodeId: string | null;
  changeId: string | null;
  batchId: string | null;
  payload: Record<string, unknown>;
  sentAt: string | null;
  readAt: string | null;
  createdAt: string;
}

function rowToNotification(r: Record<string, unknown>): NotificationRow {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
  return {
    id: r.id as string,
    kind: r.kind as NotificationKind,
    nodeId: (r.node_id as string | null) ?? null,
    changeId: (r.change_id as string | null) ?? null,
    batchId: (r.batch_id as string | null) ?? null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    sentAt: iso(r.sent_at),
    readAt: iso(r.read_at),
    createdAt: iso(r.created_at)!,
  };
}

export function notificationToggles(s: AccountSettings): Required<NotificationToggles> {
  const n = s.notifications ?? {};
  return { dueSoon: n.dueSoon ?? true, overdue: n.overdue ?? true, nudgeDue: n.nudgeDue ?? true, digest: n.digest ?? true };
}

// ---------- devices ----------

export interface DeviceRow {
  id: string;
  platform: string;
  pushToken: string | null;
  name: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

function rowToDevice(r: Record<string, unknown>): DeviceRow {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
  return { id: r.id as string, platform: r.platform as string, pushToken: (r.push_token as string | null) ?? null, name: (r.name as string | null) ?? null, lastSeenAt: iso(r.last_seen_at), createdAt: iso(r.created_at)! };
}

export async function listDevices(sql: Sql): Promise<DeviceRow[]> {
  return (await sql`select * from device order by created_at`).map(rowToDevice);
}

/** Upsert by push token: registering the same token twice updates the row instead of duplicating it. */
export async function upsertDevice(sql: Sql, input: { platform: 'ios' | 'web'; pushToken: string; name?: string | null }): Promise<DeviceRow> {
  const rows = await sql`
    insert into device (platform, push_token, name, last_seen_at)
    values (${input.platform}, ${input.pushToken}, ${input.name ?? null}, now())
    on conflict (push_token) where push_token is not null
    do update set platform = excluded.platform, name = coalesce(excluded.name, device.name), last_seen_at = now()
    returning *`;
  return rowToDevice(rows[0]!);
}

export async function deleteDevice(sql: Sql, id: string): Promise<void> {
  const rows = await sql`delete from device where id = ${id} returning id`;
  if (!rows.length) throw notFound('device');
}

// ---------- notifications ----------

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body: string;
  nodeId?: string | null;
  changeId?: string | null;
  batchId?: string | null;
  projectId?: string | null;
  /** Extra fields stored in the row and sent in the push data. */
  payload?: Record<string, unknown>;
  collapseId?: string;
}

/** Store the notification and push it. Push failures are logged, never thrown. */
export async function notify(ctx: Ctx, input: NotifyInput): Promise<NotificationRow> {
  const payload = { title: input.title, body: input.body, projectId: input.projectId ?? null, ...(input.payload ?? {}) };
  const rows = await ctx.sql`
    insert into notification (kind, node_id, change_id, batch_id, payload)
    values (${input.kind}, ${input.nodeId ?? null}, ${input.changeId ?? null}, ${input.batchId ?? null}, ${ctx.sql.json(payload as never)})
    returning *`;
  const row = rowToNotification(rows[0]!);
  const category = CATEGORY_OF[input.kind];
  const data: PushData = {
    ...(input.payload ?? {}),
    kind: category,
    notificationId: row.id,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.changeId ? { changeId: input.changeId } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
  try {
    const devices = (await listDevices(ctx.sql)).filter((d) => d.pushToken);
    const tokens = devices.map((d) => d.pushToken!);
    if (tokens.length) {
      const out = await ctx.push.send(tokens, { title: input.title, body: input.body, data, categoryId: category, collapseId: input.collapseId });
      if (out.invalidTokens.length) await ctx.sql`delete from device where push_token in ${ctx.sql(out.invalidTokens)}`;
      if (out.sent > 0) {
        await ctx.sql`update notification set sent_at = now() where id = ${row.id}`;
        row.sentAt = new Date().toISOString();
      }
    }
  } catch (err) {
    ctx.log.error(err, 'notify: push failed');
  }
  return row;
}

export async function listNotifications(ctx: Ctx, opts: { unread?: boolean; limit?: number } = {}): Promise<NotificationRow[]> {
  const rows = await ctx.sql`
    select * from notification where true ${opts.unread ? ctx.sql`and read_at is null` : ctx.sql``}
    order by created_at desc limit ${Math.min(opts.limit ?? 100, 500)}`;
  return rows.map(rowToNotification);
}

export async function markNotificationRead(ctx: Ctx, id: string): Promise<NotificationRow> {
  const rows = await ctx.sql`update notification set read_at = coalesce(read_at, now()) where id = ${id} returning *`;
  if (!rows[0]) throw notFound('notification');
  return rowToNotification(rows[0]);
}

/** Whether a scheduled notification of this kind was already recorded for the given local date. */
export async function alreadySent(ctx: Ctx, kind: NotificationKind, date: string): Promise<boolean> {
  const rows = await ctx.sql`select 1 from notification where kind = ${kind} and payload->>'date' = ${date} limit 1`;
  return rows.length > 0;
}

// ---------- triggers ----------

const FIELD_LABELS: Record<string, string> = { dueDate: '截止日', startDate: '开始日', ownerId: '负责人', status: '状态', delete: '删除' };

/** One push per node for the pending changes Claude just proposed (several fields of one node share a message). */
export async function notifyPendingChanges(ctx: Ctx, projectId: string, changes: Change[], reason?: string | null): Promise<NotificationRow[]> {
  if (changes.length === 0) return [];
  const byNode = new Map<string, Change[]>();
  for (const c of changes) byNode.set(c.nodeId, [...(byNode.get(c.nodeId) ?? []), c]);
  const titles = new Map((await ctx.sql`select id, title from node where id in ${ctx.sql([...byNode.keys()])}`).map((r) => [r.id as string, r.title as string]));
  const account = await loadAccount(ctx.sql);
  const contacts = await loadContacts(ctx.sql, { includeArchived: true });
  const year = currentYear(ctx);
  const fmt = (c: Change): string => {
    const v = c.newValue;
    if (c.field === 'dueDate' || c.field === 'startDate') return v == null ? '清空' : shortDate(String(v), year);
    if (c.field === 'ownerId') return v == null ? account.name : (contacts.find((k) => k.id === v)?.name ?? '未知联系人');
    if (c.field === 'status') return v === 'done' ? '完成' : String(v);
    return String(v);
  };
  const out: NotificationRow[] = [];
  for (const [nodeId, list] of byNode) {
    const title = titles.get(nodeId) ?? '';
    let body: string;
    if (list.length === 1) {
      const c = list[0]!;
      if (c.field === 'delete') body = `Claude 提议删除「${title}」`;
      else if (c.field === 'ownerId') body = `Claude 提议把「${title}」交给${fmt(c)}`;
      else if (c.field === 'status') body = `Claude 提议把「${title}」标记为${fmt(c)}`;
      else body = `Claude 提议把「${title}」的${FIELD_LABELS[c.field] ?? c.field}改到 ${fmt(c)}`;
    } else {
      body = `Claude 提议修改「${title}」：${list.map((c) => (c.field === 'delete' ? '删除' : `${FIELD_LABELS[c.field] ?? c.field} → ${fmt(c)}`)).join('、')}`;
    }
    if (reason) body += `\n理由：${reason}`;
    out.push(
      await notify(ctx, {
        kind: 'change_proposed', title: '待确认', body, nodeId, changeId: list[0]!.id, projectId,
        payload: { changeIds: list.map((c) => c.id), fields: list.map((c) => c.field), nodeTitle: title },
        collapseId: `change:${nodeId}`,
      }),
    );
  }
  return out;
}

export async function notifyPlanDrafted(ctx: Ctx, batch: { id: string; projectId: string; parentId: string; diff: { summary: { create: number; update: number; move: number; delete: number } } }): Promise<NotificationRow> {
  const rows = await ctx.sql`select title from node where id = ${batch.parentId}`;
  const parentTitle = (rows[0]?.title as string | undefined) ?? '';
  const s = batch.diff.summary;
  const n = s.create + s.update + s.move + s.delete;
  return notify(ctx, {
    kind: 'batch_ready', title: '草案待应用', body: `Claude 拟了 ${n} 个节点的草案：${parentTitle}`, nodeId: batch.parentId, batchId: batch.id, projectId: batch.projectId,
    payload: { summary: s, parentTitle },
    collapseId: `batch:${batch.id}`,
  });
}
