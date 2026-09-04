/**
 * Minute ticker in TZ_NAME: 09:00 daily summary (+ nudge reminder), Monday 08:00 weekly digest.
 * Each run is recorded in `notification` with the local date in its payload, so a restart within the
 * same minute (or a manual re-run) never double-sends.
 */
import { addDays, computeRollup } from '@tsai-mind/core';
import { alreadySent, notificationToggles, notify } from './notify.js';
import type { Ctx } from './service/context.js';
import { todayIso } from './service/context.js';
import { getToday } from './service/queries.js';
import { loadAccount, loadContacts, loadProjects, loadStore } from './service/store.js';
import { textOf } from './assistant/client.js';

export interface LocalClock {
  date: string;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

export function localClock(at: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: weekdays.indexOf(get('weekday')),
  };
}

export interface RunResult {
  date: string;
  sent: string[];
  skipped: string[];
}

/** 09:00: "今天到期 n 项、逾期 m 项" (+ 明天) and "该催了：…". */
export async function runDaily(ctx: Ctx, opts: { date?: string } = {}): Promise<RunResult> {
  const date = opts.date ?? todayIso(ctx);
  const toggles = notificationToggles((await loadAccount(ctx.sql)).settings);
  const today = await getToday(ctx);
  const res: RunResult = { date, sent: [], skipped: [] };

  if (toggles.dueSoon || toggles.overdue) {
    if (await alreadySent(ctx, 'due_summary', date)) res.skipped.push('due_summary');
    else {
      const lines: string[] = [];
      const parts: string[] = [];
      if (toggles.dueSoon && today.dueToday.length) parts.push(`今天到期 ${today.dueToday.length} 项`);
      if (toggles.overdue && today.overdue.length) parts.push(`逾期 ${today.overdue.length} 项`);
      if (parts.length) lines.push(parts.join('、'));
      if (toggles.dueSoon && today.dueTomorrow.length) lines.push(`明天到期 ${today.dueTomorrow.length} 项`);
      if (lines.length) {
        const items = [...(toggles.dueSoon ? today.dueToday : []), ...(toggles.overdue ? today.overdue : [])];
        const nodeIds = items.map((i) => i.node.id);
        await notify(ctx, {
          kind: 'due_summary', title: '今天', body: lines.join('\n'),
          nodeId: nodeIds.length === 1 ? nodeIds[0]! : null, projectId: nodeIds.length === 1 ? items[0]!.projectId : null,
          payload: { date, dueToday: today.dueToday.length, overdue: today.overdue.length, dueTomorrow: today.dueTomorrow.length, nodeIds },
          collapseId: `due:${date}`,
        });
        res.sent.push('due_summary');
      }
    }
  } else res.skipped.push('due_summary');

  if (toggles.nudgeDue) {
    if (await alreadySent(ctx, 'nudge_due', date)) res.skipped.push('nudge_due');
    else if (today.nudgeDue.length) {
      const titles = today.nudgeDue.map((i) => i.node.title);
      const shown = titles.slice(0, 5).join('、') + (titles.length > 5 ? ` 等 ${titles.length} 项` : '');
      await notify(ctx, {
        kind: 'nudge_due', title: '该催了', body: `该催了：${shown}`,
        nodeId: today.nudgeDue[0]!.node.id, projectId: today.nudgeDue[0]!.projectId,
        payload: { date, nodeIds: today.nudgeDue.map((i) => i.node.id), count: titles.length },
        collapseId: `nudge:${date}`,
      });
      res.sent.push('nudge_due');
    }
  } else res.skipped.push('nudge_due');

  return res;
}

/** Compact picture of the week that the digest is written from. */
export interface WeekSummary {
  today: string;
  weekStart: string;
  weekEnd: string;
  overdue: { project: string; title: string; owner: string; due: string; daysOverdue: number; progress: number }[];
  dueThisWeek: { project: string; title: string; owner: string; due: string; progress: number }[];
  pending: { project: string; title: string; field: string; from: unknown; to: unknown }[];
  nudgeDue: { project: string; title: string; owner: string; due: string | null }[];
  completedLastWeek: number;
}

export async function summarizeWeek(ctx: Ctx, date: string): Promise<WeekSummary> {
  // Week = Monday … Sunday containing `date`.
  const dow = localClock(new Date(`${date}T12:00:00Z`), 'UTC').weekday;
  const monday = addDays(date, dow === 0 ? -6 : 1 - dow);
  const sunday = addDays(monday, 6);
  const account = await loadAccount(ctx.sql);
  const contacts = await loadContacts(ctx.sql, { includeArchived: true });
  const ownerName = (id: string | null) => (id ? (contacts.find((c) => c.id === id)?.name ?? '?') : account.name);
  const dueThisWeek: WeekSummary['dueThisWeek'] = [];
  for (const p of await loadProjects(ctx.sql)) {
    const store = await loadStore(ctx.sql, p.id);
    const derived = computeRollup(store);
    for (const n of store.all()) {
      const d = derived.get(n.id);
      if (!d || d.hasChildren || n.kind === 'note' || d.status === 'done' || !d.dueDate) continue;
      if (d.dueDate >= monday && d.dueDate <= sunday) dueThisWeek.push({ project: p.name, title: n.title, owner: ownerName(n.ownerId), due: d.dueDate, progress: d.progress });
    }
  }
  dueThisWeek.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  const today = await getToday(ctx);
  const doneRows = await ctx.sql`
    select count(*)::int as n from activity
    where kind = 'field_changed' and payload->'fields'->'status'->>'to' = 'done' and created_at >= now() - interval '7 days'`;
  return {
    today: date,
    weekStart: monday,
    weekEnd: sunday,
    overdue: today.overdue.map((i) => ({ project: i.projectName, title: i.node.title, owner: ownerName(i.node.ownerId), due: i.derived.dueDate!, daysOverdue: i.daysOverdue, progress: i.derived.progress })),
    dueThisWeek,
    pending: today.pending.map((c) => ({ project: c.projectName, title: c.nodeTitle, field: c.field, from: c.oldValue, to: c.newValue })),
    nudgeDue: today.nudgeDue.map((i) => ({ project: i.projectName, title: i.node.title, owner: ownerName(i.node.ownerId), due: i.derived.dueDate })),
    completedLastWeek: Number(doneRows[0]?.n ?? 0),
  };
}

const DIGEST_SYSTEM =
  '你是 Tsai Mind 的助手。根据用户给的一周 JSON（逾期、本周到期、待确认、该催办、上周完成数）写一条周一早上的推送正文，简体中文，纯文本不用 Markdown，200 字以内，分 3–5 行：先一句总览（上周完成几项、本周到期几项、逾期几项、待确认几项），再点名最要紧的逾期和本周到期事项（带负责人和日期，日期写成 M/D），最后一行给一个本周最该先做的建议。没有的类别就不提，不要编造。';

const templateDigest = (w: WeekSummary): string => `本周到期 ${w.dueThisWeek.length}、逾期 ${w.overdue.length}、待确认 ${w.pending.length}`;

/** Ask Claude for the digest text; null when unconfigured, refused, empty or failing (caller falls back to the template). */
export async function writeDigestWithClaude(ctx: Ctx, week: WeekSummary): Promise<string | null> {
  if (!ctx.anthropic) return null;
  try {
    const msg = await ctx.anthropic.create({
      model: ctx.config.assistantModel,
      max_tokens: 600,
      effort: 'low',
      system: DIGEST_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(week) }],
    });
    if (msg.stop_reason === 'refusal') return null;
    const text = textOf(msg).trim();
    return text || null;
  } catch (err) {
    ctx.log.error(err, 'digest: Claude call failed, using the template');
    return null;
  }
}

/** Monday 08:00: the weekly digest — written by Claude when configured, otherwise "本周到期 n、逾期 m、待确认 k". */
export async function runWeekly(ctx: Ctx, opts: { date?: string } = {}): Promise<RunResult> {
  const date = opts.date ?? todayIso(ctx);
  const res: RunResult = { date, sent: [], skipped: [] };
  const toggles = notificationToggles((await loadAccount(ctx.sql)).settings);
  if (!toggles.digest || (await alreadySent(ctx, 'digest', date))) {
    res.skipped.push('digest');
    return res;
  }
  const week = await summarizeWeek(ctx, date);
  const generated = await writeDigestWithClaude(ctx, week);
  await notify(ctx, {
    kind: 'digest',
    title: generated ? '本周计划' : '本周',
    body: generated ?? templateDigest(week),
    payload: {
      date, weekStart: week.weekStart, weekEnd: week.weekEnd, dueThisWeek: week.dueThisWeek.length, overdue: week.overdue.length, pending: week.pending.length,
      completedLastWeek: week.completedLastWeek, source: generated ? 'claude' : 'template', text: generated ?? templateDigest(week),
    },
    collapseId: `digest:${week.weekStart}`,
  });
  res.sent.push('digest');
  return res;
}

export interface Scheduler {
  stop(): void;
  /** Run whatever is due at `at` (exposed for tests). */
  tick(at?: Date): Promise<void>;
}

export function startScheduler(ctx: Ctx, opts: { intervalMs?: number; daily?: { hour: number; minute: number }; weekly?: { weekday: number; hour: number; minute: number } } = {}): Scheduler {
  const daily = opts.daily ?? { hour: 9, minute: 0 };
  const weekly = opts.weekly ?? { weekday: 1, hour: 8, minute: 0 };
  let running = false;
  const tick = async (at: Date = new Date()) => {
    if (running) return;
    running = true;
    try {
      const c = localClock(at, ctx.config.tzName);
      if (c.hour === daily.hour && c.minute === daily.minute) {
        const r = await runDaily(ctx, { date: c.date });
        if (r.sent.length) ctx.log.info({ date: c.date, sent: r.sent }, 'scheduler: daily notifications sent');
      }
      if (c.weekday === weekly.weekday && c.hour === weekly.hour && c.minute === weekly.minute) {
        const r = await runWeekly(ctx, { date: c.date });
        if (r.sent.length) ctx.log.info({ date: c.date, sent: r.sent }, 'scheduler: weekly digest sent');
      }
    } catch (err) {
      ctx.log.error(err, 'scheduler: tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
