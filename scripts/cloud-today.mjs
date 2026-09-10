#!/usr/bin/env node
// Build the daily reminder from a folder of cloud documents (as saved by the Artifact tool's read_db
// with out_dir): <dir>/projects/*.json, <dir>/meta/contacts.json, <dir>/meta/account.json.
// Usage: node scripts/cloud-today.mjs <dir> [--json] [--date YYYY-MM-DD]
// Prints a JSON summary with `subject`, `text`, `html`, `shouldSend` (false when nothing is due).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TreeStore, computeRollup, computeToday, toISODate, addDays } from '../packages/core/dist/index.js';

const [dir, ...flags] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node scripts/cloud-today.mjs <dir> [--date YYYY-MM-DD]');
  process.exit(1);
}
const load = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const unwrap = (raw) => raw?.doc ?? raw?.data ?? raw;
const account = unwrap(load(join(dir, 'meta', 'account.json')))?.account ?? {};
const tz = account.timezone || 'Asia/Tokyo';
const dateFlag = flags.indexOf('--date');
const today = dateFlag >= 0 ? flags[dateFlag + 1] : toISODate(new Date(), tz);
const soonUntil = addDays(today, 3);
const contacts = unwrap(load(join(dir, 'meta', 'contacts.json')))?.contacts ?? [];
const nameOf = (id) => (id ? contacts.find((c) => c.id === id)?.name ?? '?' : '我');

const projDir = join(dir, 'projects');
const files = existsSync(projDir) ? readdirSync(projDir).filter((f) => f.endsWith('.json')) : [];
const overdue = [], dueToday = [], dueTomorrow = [], dueSoon = [], pending = [];
for (const f of files) {
  const doc = unwrap(load(join(projDir, f)));
  if (!doc?.project || doc.project.archivedAt) continue;
  const store = new TreeStore(doc.nodes ?? []);
  const derived = computeRollup(store);
  const t = computeToday(store, derived, doc.changes ?? [], { today });
  const tag = (item) => ({ project: doc.project.name, title: item.node.title, owner: nameOf(item.node.ownerId), due: item.derived.dueDate, days: item.daysOverdue, path: item.path.slice(1).join(' / ') });
  overdue.push(...t.overdue.map(tag));
  dueToday.push(...t.dueToday.map(tag));
  dueTomorrow.push(...t.dueTomorrow.map(tag));
  for (const n of store.all()) {
    const d = derived.get(n.id);
    if (!d || d.hasChildren || n.kind === 'note' || d.status === 'done' || !d.dueDate) continue;
    if (d.dueDate > addDays(today, 1) && d.dueDate <= soonUntil) dueSoon.push({ project: doc.project.name, title: n.title, owner: nameOf(n.ownerId), due: d.dueDate, path: store.path(n.id).slice(1).join(' / ') });
  }
  for (const c of t.pending) {
    const n = store.get(c.nodeId);
    pending.push({ project: doc.project.name, title: n?.title ?? c.nodeId, field: c.field, from: c.oldValue, to: c.newValue, reason: c.reason });
  }
}
const byDue = (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0);
overdue.sort(byDue); dueSoon.sort(byDue);
const md = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${m}/${d}`; };
const fieldName = { dueDate: '截止日', startDate: '开始日', ownerId: '负责人', delete: '删除', status: '状态' };
const shouldSend = overdue.length + dueToday.length + dueTomorrow.length + dueSoon.length + pending.length > 0;
const subject = `Tsai Mind ${md(today)}：逾期 ${overdue.length} · 今天 ${dueToday.length} · 明天 ${dueTomorrow.length}` + (pending.length ? ` · 待确认 ${pending.length}` : '');

const line = (i) => `- ${i.title}（${i.project}${i.path ? ' / ' + i.path : ''}）· ${i.owner} · ${md(i.due)}` + (i.days ? ` · 逾期 ${i.days} 天` : '');
const sections = [];
if (overdue.length) sections.push(`【逾期 ${overdue.length}】\n${overdue.map(line).join('\n')}`);
if (dueToday.length) sections.push(`【今天到期 ${dueToday.length}】\n${dueToday.map(line).join('\n')}`);
if (dueTomorrow.length) sections.push(`【明天到期 ${dueTomorrow.length}】\n${dueTomorrow.map(line).join('\n')}`);
if (dueSoon.length) sections.push(`【三天内到期 ${dueSoon.length}】\n${dueSoon.map(line).join('\n')}`);
if (pending.length) sections.push(`【待确认 ${pending.length}】\n${pending.map((p) => `- ${p.title}（${p.project}）：${fieldName[p.field] ?? p.field} ${JSON.stringify(p.from)} → ${JSON.stringify(p.to)}${p.reason ? '，理由：' + p.reason : ''}`).join('\n')}`);
const APP = 'https://claude.ai/code/artifact/8f2fc173-fffa-4d02-bf1e-0985bc1de260';
const text = `${today}（${tz}）\n\n${sections.join('\n\n')}\n\n打开 Tsai Mind：${APP}\n\n— 这封邮件由 Tsai Mind 的每日提醒自动发送。没有到期或待确认的日子不会发。`;

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const row = (i, red) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #E5E5E5"><b>${esc(i.title)}</b><div style="color:#6B6B6B;font-size:12px">${esc(i.project)}${i.path ? ' / ' + esc(i.path) : ''} · ${esc(i.owner)}</div></td><td style="padding:6px 10px;border-bottom:1px solid #E5E5E5;text-align:right;font-family:Menlo,monospace;color:${red ? '#D64545' : '#1C1C1C'};white-space:nowrap">${md(i.due)}${i.days ? `<div style="font-size:12px">逾期 ${i.days} 天</div>` : ''}</td></tr>`;
const block = (title, items, red = false) => items.length ? `<h3 style="margin:18px 0 6px;font-size:15px;color:#1C1C1C">${title} <span style="color:#6B6B6B;font-weight:400">${items.length}</span></h3><table style="border-collapse:collapse;width:100%">${items.map((i) => row(i, red)).join('')}</table>` : '';
const pendingHtml = pending.length ? `<h3 style="margin:18px 0 6px;font-size:15px">待确认 <span style="color:#6B6B6B;font-weight:400">${pending.length}</span></h3>` + pending.map((p) => `<div style="background:#FFF1E8;border-left:3px solid #F26B1D;padding:10px 12px;margin:0 0 8px;border-radius:0 8px 8px 0"><b>${esc(p.title)}</b> <span style="color:#6B6B6B">${esc(p.project)}</span><div style="font-family:Menlo,monospace;font-size:13px;margin-top:4px">${esc(fieldName[p.field] ?? p.field)} ${esc(JSON.stringify(p.from))} → ${esc(JSON.stringify(p.to))}</div>${p.reason ? `<div style="color:#6B6B6B;font-size:13px">${esc(p.reason)}</div>` : ''}</div>`).join('') : '';
const html = `<div style="font-family:'PingFang SC','Noto Sans SC',system-ui,sans-serif;max-width:560px;color:#1C1C1C;font-size:14px;line-height:1.5"><div style="font-size:12px;color:#6B6B6B">${today} · ${esc(tz)}</div>${block('逾期', overdue, true)}${block('今天到期', dueToday)}${block('明天到期', dueTomorrow)}${block('三天内到期', dueSoon)}${pendingHtml}<p style="margin:22px 0 0"><a href="${APP}" style="display:inline-block;background:#F26B1D;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:500">打开 Tsai Mind</a></p><p style="color:#A3A3A3;font-size:12px;margin-top:18px">这封邮件由 Tsai Mind 的每日提醒自动发送；没有到期或待确认的日子不会发。</p></div>`;

process.stdout.write(JSON.stringify({ today, tz, shouldSend, subject, counts: { overdue: overdue.length, dueToday: dueToday.length, dueTomorrow: dueTomorrow.length, dueSoon: dueSoon.length, pending: pending.length }, text, html }, null, 1));
