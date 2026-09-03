import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, type TNode } from '@tsai-mind/core';
import { draftPlan } from '../src/service/plans.js';
import { localClock, startScheduler } from '../src/scheduler.js';
import { op, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let token: string;

type ProjectRes = { project: { id: string; rootNodeId: string }; nodes: TNode[] };
type OpsRes = { results: { ok: boolean; changeIds?: string[]; node?: TNode; error?: string }[] };

const PUSH_TOKEN = 'ExponentPushToken[test-device-1]';

async function registerDevice(pushToken = PUSH_TOKEN) {
  return s.api<{ id: string; pushToken: string; name: string | null }>('POST', '/api/devices', { body: { platform: 'ios', pushToken, name: '我的 iPhone' }, token });
}

async function createProject(name = '官网改版') {
  const r = await s.api<ProjectRes>('POST', '/api/projects', { body: { name }, token });
  expect(r.status).toBe(201);
  return r.body;
}

async function createNode(projectId: string, parentId: string, fields: Partial<TNode> & { title: string }, rank = 'a0') {
  const id = randomUUID();
  const r = await s.api<OpsRes>('POST', `/api/projects/${projectId}/ops`, { body: { ops: [op(projectId, { type: 'create_node', node: { id, projectId, parentId, rank, ...fields } })] }, token });
  expect(r.status).toBe(200);
  expect(r.body.results[0]!.ok).toBe(true);
  return r.body.results[0]!.node!;
}

beforeAll(async () => {
  s = await startTestServer();
});
afterAll(async () => {
  await s.close();
});
beforeEach(async () => {
  await s.reset();
  token = await s.token(['read', 'write', 'decide']);
});

describe('devices', () => {
  it('upserts by push token and lists / deletes', async () => {
    const a = await registerDevice();
    expect(a.status).toBe(201);
    const b = await registerDevice();
    expect(b.body.id).toBe(a.body.id);
    const list = await s.api<{ id: string }[]>('GET', '/api/devices', { token });
    expect(list.body).toHaveLength(1);
    expect((await s.api('DELETE', `/api/devices/${a.body.id}`, { token })).status).toBe(200);
    expect((await s.api<unknown[]>('GET', '/api/devices', { token })).body).toHaveLength(0);
    expect((await s.api('DELETE', `/api/devices/${a.body.id}`, { token })).status).toBe(404);
  });
});

describe('change / batch pushes', () => {
  it('pushes one "change" notification per node when Claude touches key fields', async () => {
    await registerDevice();
    const p = await createProject();
    const n = await createNode(p.project.id, p.project.rootNodeId, { title: '接口联调', dueDate: '2026-10-01' });
    const r = await s.api<OpsRes>('POST', `/api/projects/${p.project.id}/ops`, {
      body: { ops: [op(p.project.id, { type: 'update_node', nodeId: n.id, patch: { dueDate: '2026-10-05', startDate: '2026-09-20' } }, 'claude')] }, token,
    });
    expect(r.status).toBe(200);
    const changeIds = r.body.results[0]!.changeIds!;
    expect(changeIds).toHaveLength(2);

    expect(s.pushes).toHaveLength(1);
    const push = s.pushes[0]!;
    expect(push.to).toBe(PUSH_TOKEN);
    expect(push.categoryId).toBe('change');
    expect(push.data).toMatchObject({ kind: 'change', nodeId: n.id, changeId: changeIds[0], projectId: p.project.id });
    expect((push.data as { changeIds: string[] }).changeIds.sort()).toEqual([...changeIds].sort());
    expect(push.body).toContain('Claude 提议修改「接口联调」');
    expect(push.body).toContain('截止日 → 10/5');

    const rows = await s.api<{ id: string; kind: string; changeId: string; sentAt: string | null; readAt: string | null }[]>('GET', '/api/notifications?unread=1', { token });
    expect(rows.body).toHaveLength(1);
    expect(rows.body[0]!.kind).toBe('change_proposed');
    expect(rows.body[0]!.changeId).toBe(changeIds[0]);
    expect(rows.body[0]!.sentAt).not.toBeNull();
    const read = await s.api<{ readAt: string | null }>('POST', `/api/notifications/${rows.body[0]!.id}/read`, { token });
    expect(read.body.readAt).not.toBeNull();
    expect((await s.api<unknown[]>('GET', '/api/notifications?unread=1', { token })).body).toHaveLength(0);
  });

  it('phrases a single due-date proposal and repeats nothing on a duplicate proposal', async () => {
    await registerDevice();
    const p = await createProject();
    const n = await createNode(p.project.id, p.project.rootNodeId, { title: '上线', dueDate: '2026-10-01' });
    const body = { ops: [op(p.project.id, { type: 'update_node', nodeId: n.id, patch: { dueDate: '2026-10-05' } }, 'claude')] };
    await s.api('POST', `/api/projects/${p.project.id}/ops`, { body, token });
    expect(s.pushes).toHaveLength(1);
    expect(s.pushes[0]!.body).toBe('Claude 提议把「上线」的截止日改到 10/5');
    // same field again while pending → existing change reused, no second push
    await s.api('POST', `/api/projects/${p.project.id}/ops`, { body: { ops: [op(p.project.id, { type: 'update_node', nodeId: n.id, patch: { dueDate: '2026-10-06' } }, 'claude')] }, token });
    expect(s.pushes).toHaveLength(1);
    // a user edit sends nothing
    await s.api('POST', `/api/projects/${p.project.id}/ops`, { body: { ops: [op(p.project.id, { type: 'update_node', nodeId: n.id, patch: { dueDate: '2026-10-07' } })] }, token });
    expect(s.pushes).toHaveLength(1);
  });

  it('pushes a "batch" notification when Claude drafts a plan', async () => {
    await registerDevice();
    const p = await createProject();
    const batch = await draftPlan(s.ctx, { projectId: p.project.id, parentId: p.project.rootNodeId, outline: '- 需求\n- 设计\n- 开发', mode: 'append', actor: 'claude' });
    expect(s.pushes).toHaveLength(1);
    expect(s.pushes[0]!.categoryId).toBe('batch');
    expect(s.pushes[0]!.data).toMatchObject({ kind: 'batch', batchId: batch.id, projectId: p.project.id });
    expect(s.pushes[0]!.body).toBe('Claude 拟了 3 个节点的草案：官网改版');
    // the owner drafting from the web is not pushed
    await draftPlan(s.ctx, { projectId: p.project.id, parentId: p.project.rootNodeId, outline: '- 测试', mode: 'append', actor: 'user' });
    expect(s.pushes).toHaveLength(1);
  });

  it('sends nothing when no device is registered but still records the notification', async () => {
    const p = await createProject();
    const n = await createNode(p.project.id, p.project.rootNodeId, { title: 'x', dueDate: '2026-10-01' });
    await s.api('POST', `/api/projects/${p.project.id}/ops`, { body: { ops: [op(p.project.id, { type: 'update_node', nodeId: n.id, patch: { dueDate: '2026-10-05' } }, 'claude')] }, token });
    expect(s.pushes).toHaveLength(0);
    const rows = await s.api<{ sentAt: string | null }[]>('GET', '/api/notifications', { token });
    expect(rows.body).toHaveLength(1);
    expect(rows.body[0]!.sentAt).toBeNull();
  });
});

describe('scheduled pushes', () => {
  async function fixture() {
    await registerDevice();
    const today = (await s.api<{ today: string }>('GET', '/api/today', { token })).body.today;
    const contact = await s.api<{ id: string }>('POST', '/api/contacts', { body: { name: '陈小明' }, token });
    const p = await createProject();
    const overdue = await createNode(p.project.id, p.project.rootNodeId, { title: '接口联调', dueDate: addDays(today, -5), ownerId: contact.body.id }, 'a0');
    const dueToday = await createNode(p.project.id, p.project.rootNodeId, { title: '前端页面', dueDate: today }, 'a1');
    const tomorrow = await createNode(p.project.id, p.project.rootNodeId, { title: '验收', dueDate: addDays(today, 1) }, 'a2');
    return { today, p, overdue, dueToday, tomorrow };
  }

  it('daily run sends a due summary and a nudge reminder, once per day', async () => {
    const f = await fixture();
    const run = await s.api<{ sent: string[]; skipped: string[] }>('POST', '/api/notifications/run?kind=daily', { token });
    expect(run.status).toBe(200);
    expect(run.body.sent).toEqual(['due_summary', 'nudge_due']);
    expect(s.pushes).toHaveLength(2);
    const due = s.pushes.find((m) => m.categoryId === 'due')!;
    expect(due.body).toBe('今天到期 1 项、逾期 1 项\n明天到期 1 项');
    expect(due.data).toMatchObject({ kind: 'due', date: f.today });
    const nudge = s.pushes.find((m) => m.categoryId === 'nudge')!;
    expect(nudge.body).toBe('该催了：接口联调');
    expect(nudge.data).toMatchObject({ kind: 'nudge', nodeId: f.overdue.id });

    // second run the same day sends nothing
    const again = await s.api<{ sent: string[]; skipped: string[] }>('POST', '/api/notifications/run?kind=daily', { token });
    expect(again.body.sent).toEqual([]);
    expect(again.body.skipped).toEqual(['due_summary', 'nudge_due']);
    expect(s.pushes).toHaveLength(2);
  });

  it('weekly run sends one digest', async () => {
    const f = await fixture();
    await s.api('POST', `/api/projects/${f.p.project.id}/ops`, { body: { ops: [op(f.p.project.id, { type: 'update_node', nodeId: f.dueToday.id, patch: { dueDate: addDays(f.today, 3) } }, 'claude')] }, token });
    s.pushes.splice(0);
    const run = await s.api<{ sent: string[] }>('POST', '/api/notifications/run?kind=weekly', { token });
    expect(run.body.sent).toEqual(['digest']);
    expect(s.pushes).toHaveLength(1);
    expect(s.pushes[0]!.categoryId).toBe('digest');
    expect(s.pushes[0]!.body).toMatch(/^本周到期 \d+、逾期 1、待确认 1$/);
    expect((await s.api<{ sent: string[] }>('POST', '/api/notifications/run?kind=weekly', { token })).body.sent).toEqual([]);
  });

  it('respects the notification toggles', async () => {
    await fixture();
    await s.sql`update account set settings = ${s.sql.json({ notifications: { dueSoon: false, overdue: false, nudgeDue: false, digest: false } } as never)}`;
    expect((await s.api<{ sent: string[] }>('POST', '/api/notifications/run?kind=daily', { token })).body.sent).toEqual([]);
    expect((await s.api<{ sent: string[] }>('POST', '/api/notifications/run?kind=weekly', { token })).body.sent).toEqual([]);
    expect(s.pushes).toHaveLength(0);
    // overdue off but dueSoon on → summary without the overdue count, nudges still go out
    await s.sql`update account set settings = ${s.sql.json({ notifications: { overdue: false } } as never)}`;
    await s.api('POST', '/api/notifications/run?kind=daily', { token });
    expect(s.pushes.map((m) => m.categoryId).sort()).toEqual(['due', 'nudge']);
    expect(s.pushes.find((m) => m.categoryId === 'due')!.body).toBe('今天到期 1 项\n明天到期 1 项');
  });

  it('requires the decide scope for manual runs', async () => {
    const rw = await s.token(['read', 'write']);
    expect((await s.api('POST', '/api/notifications/run?kind=daily', { token: rw })).status).toBe(403);
    expect((await s.api('POST', '/api/notifications/run?kind=hourly', { token })).status).toBe(400);
  });

  it('ticks at 09:00 and Monday 08:00 in the configured timezone', async () => {
    await fixture();
    const sched = startScheduler(s.ctx, { intervalMs: 3_600_000 });
    try {
      // 2026-09-07 is a Monday. 08:00 Asia/Taipei = 00:00Z.
      const monday8 = new Date('2026-09-07T00:00:00Z');
      expect(localClock(monday8, 'Asia/Taipei')).toEqual({ date: '2026-09-07', hour: 8, minute: 0, weekday: 1 });
      await sched.tick(new Date('2026-09-07T00:30:00Z'));
      expect(s.pushes).toHaveLength(0);
      await sched.tick(monday8);
      expect(s.pushes.map((m) => m.categoryId)).toEqual(['digest']);
      await sched.tick(new Date('2026-09-07T01:00:00Z')); // 09:00 local
      expect(s.pushes.map((m) => m.categoryId).sort()).toEqual(['digest', 'due', 'nudge']);
      await sched.tick(new Date('2026-09-07T01:00:30Z')); // same minute again (restart) → no duplicates
      expect(s.pushes).toHaveLength(3);
    } finally {
      sched.stop();
    }
  });
});

describe('notification actions', () => {
  it('marks a node done and postpones due dates', async () => {
    const p = await createProject();
    const parent = await createNode(p.project.id, p.project.rootNodeId, { title: '开发' }, 'a0');
    const leaf = await createNode(p.project.id, parent.id, { title: '前端页面', startDate: '2026-09-01', dueDate: '2026-09-10' }, 'a0');
    const other = await createNode(p.project.id, p.project.rootNodeId, { title: '无日期' }, 'a1');

    const post = await s.api<{ node: TNode; from: string; to: string }>('POST', `/api/nodes/${leaf.id}/postpone`, { body: { days: 2 }, token });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ from: '2026-09-10', to: '2026-09-12' });
    expect(post.body.node.dueDate).toBe('2026-09-12');
    const def = await s.api<{ to: string }>('POST', `/api/nodes/${leaf.id}/postpone`, { token });
    expect(def.body.to).toBe('2026-09-13');

    const auto = await s.api<{ message: string }>('POST', `/api/nodes/${parent.id}/postpone`, { body: { days: 1 }, token });
    expect(auto.status).toBe(400);
    expect(auto.body.message).toContain('子节点');
    expect((await s.api('POST', `/api/nodes/${other.id}/postpone`, { token })).status).toBe(400);

    const done = await s.api<{ node: TNode }>('POST', `/api/nodes/${leaf.id}/done`, { token });
    expect(done.status).toBe(200);
    expect(done.body.node.status).toBe('done');
    expect((await s.api('POST', `/api/nodes/${randomUUID()}/done`, { token })).status).toBe(404);
  });
});
