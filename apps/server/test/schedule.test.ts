import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TNode } from '@tsai-mind/core';
import { scriptedClient, type BetaContentBlock } from '../src/assistant/client.js';
import { findTool, runTool } from '../src/tools/registry.js';
import { SAMPLE_OUTLINE, op, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let token: string;

type ProjectRes = { project: { id: string; rootNodeId: string }; nodes: TNode[] };
type OpsRes = { results: { ok: boolean; serverSeq?: number; changeIds?: string[]; node?: TNode; error?: string }[] };
const PUSH_TOKEN = 'ExponentPushToken[test-device-2]';

async function createNode(projectId: string, parentId: string, fields: Partial<TNode> & { title: string }, rank: string) {
  const id = randomUUID();
  const r = await s.api<OpsRes>('POST', `/api/projects/${projectId}/ops`, { body: { ops: [op(projectId, { type: 'create_node', node: { id, projectId, parentId, rank, ...fields } })] }, token });
  expect(r.body.results[0]!.ok).toBe(true);
  return r.body.results[0]!.node!;
}

async function setDue(projectId: string, node: TNode, dueDate: string, actor: 'user' | 'claude' = 'user') {
  const r = await s.api<OpsRes>('POST', `/api/projects/${projectId}/ops`, { body: { ops: [op(projectId, { type: 'update_node', nodeId: node.id, patch: { dueDate } }, actor)] }, token });
  expect(r.status).toBe(200);
  return r.body.results[0]!;
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

describe('dependency slips', () => {
  async function fixture() {
    await s.api('POST', '/api/devices', { body: { platform: 'ios', pushToken: PUSH_TOKEN }, token });
    const p = (await s.api<ProjectRes>('POST', '/api/projects', { body: { name: 'P' }, token })).body;
    const a = await createNode(p.project.id, p.project.rootNodeId, { title: '前置', startDate: '2026-09-01', dueDate: '2026-09-10' }, 'a0');
    const b = await createNode(p.project.id, p.project.rootNodeId, { title: '后续', startDate: '2026-09-15', dueDate: '2026-09-20' }, 'a1');
    const dep = await s.api('POST', '/api/dependencies', { body: { fromNodeId: a.id, toNodeId: b.id }, token });
    expect(dep.status).toBe(201);
    return { p, a, b };
  }

  it('pushes once per new slip, again when it grows, never when unchanged or resolved', async () => {
    const { p, a } = await fixture();
    expect(s.pushes).toHaveLength(0);

    // predecessor slips past the successor's start → one push
    const r1 = await setDue(p.project.id, a, '2026-10-05');
    expect(s.pushes).toHaveLength(1);
    expect(s.pushes[0]!.categoryId).toBe('dependency');
    expect(s.pushes[0]!.title).toBe('依赖延误');
    expect(s.pushes[0]!.body).toBe('「前置」延到 10/5，晚于「后续」的开始日 9/15，晚 20 天');
    expect(s.pushes[0]!.data).toMatchObject({ kind: 'dependency', nodeId: a.id, projectId: p.project.id, days: 20 });

    // an unrelated edit leaves the slip as it is → nothing
    await s.api<OpsRes>('POST', `/api/projects/${p.project.id}/ops`, { body: { ops: [op(p.project.id, { type: 'update_node', nodeId: a.id, patch: { title: '前置（改名）' } })] }, token });
    expect(s.pushes).toHaveLength(1);

    // one more day → a new slip state → one more push
    await setDue(p.project.id, r1.node!, '2026-10-06');
    expect(s.pushes).toHaveLength(2);
    expect(s.pushes[1]!.body).toBe('「前置（改名）」延到 10/6，晚于「后续」的开始日 9/15，晚 21 天');

    // moved back before the start → resolved, no push
    await setDue(p.project.id, r1.node!, '2026-09-10');
    expect(s.pushes).toHaveLength(2);

    const notifications = await s.api<{ kind: string; payload: { days: number } }[]>('GET', '/api/notifications', { token });
    expect(notifications.body.filter((n) => n.kind === 'dependency_slip').map((n) => n.payload.days)).toEqual([21, 20]);
  });

  it('project detail and get_tree json expose slips and the critical path', async () => {
    const { p, a, b } = await fixture();
    await setDue(p.project.id, a, '2026-10-05');
    const detail = await s.api<{ criticalPath: string[]; slips: { fromNode: string; toNode: string; fromDue: string; toStart: string; days: number }[] }>('GET', `/api/projects/${p.project.id}`, { token });
    expect(detail.body.slips).toEqual([{ fromNode: a.id, toNode: b.id, fromTitle: '前置', toTitle: '后续', fromDue: '2026-10-05', toStart: '2026-09-15', days: 20 }]);
    expect(detail.body.criticalPath).toEqual([p.project.rootNodeId, a.id]);

    const tree = (await runTool(findTool('get_tree')!, { project_id: p.project.id, format: 'json' }, s.ctx, { scopes: ['read'] })) as { criticalPath: string[]; slips: unknown[] };
    expect(tree.criticalPath).toEqual([p.project.rootNodeId, a.id]);
    expect(tree.slips).toHaveLength(1);

    // the sample project: the 10/10 milestone is the latest leaf under the root
    const sample = (await s.api<ProjectRes>('POST', '/api/projects', { body: { name: '官网改版', outline: SAMPLE_OUTLINE }, token })).body;
    const launch = sample.nodes.find((n) => n.title === '上线')!;
    const d2 = await s.api<{ criticalPath: string[]; slips: unknown[] }>('GET', `/api/projects/${sample.project.id}`, { token });
    expect(d2.body.criticalPath).toEqual([sample.project.rootNodeId, launch.id]);
    expect(d2.body.slips).toEqual([]);
  });

  it('rejects dependencies that would form a cycle, over REST and through the tool', async () => {
    const { p, a, b } = await fixture();
    const c = await createNode(p.project.id, p.project.rootNodeId, { title: 'c' }, 'a2');
    expect((await s.api('POST', '/api/dependencies', { body: { fromNodeId: b.id, toNodeId: c.id }, token })).status).toBe(201);
    const cyc = await s.api<{ error: string; message: string }>('POST', '/api/dependencies', { body: { fromNodeId: c.id, toNodeId: a.id }, token });
    expect(cyc.status).toBe(409);
    expect(cyc.body.error).toBe('dependency_cycle');
    expect(cyc.body.message).toContain('循环');
    await expect(runTool(findTool('add_dependency')!, { from_node_id: b.id, to_node_id: a.id }, s.ctx, { scopes: ['read', 'write'] })).rejects.toMatchObject({ code: 'dependency_cycle' });
    expect((await s.api('POST', '/api/dependencies', { body: { fromNodeId: a.id, toNodeId: a.id }, token })).status).toBe(400);
    // the graph is unchanged
    const detail = await s.api<{ dependencies: unknown[] }>('GET', `/api/projects/${p.project.id}`, { token });
    expect(detail.body.dependencies).toHaveLength(2);
  });
});

describe('owner settings', () => {
  it('PATCH /api/me merges name, timezone and settings', async () => {
    const r = await s.api<{ account: { name: string; timezone: string; settings: Record<string, unknown> } }>('PATCH', '/api/me', {
      token,
      body: { name: '小蔡', settings: { notifications: { digest: false }, nudgeTemplate: '{title} 进度如何？' } },
    });
    expect(r.status).toBe(200);
    expect(r.body.account.name).toBe('小蔡');
    expect(r.body.account.settings).toEqual({ notifications: { digest: false }, nudgeTemplate: '{title} 进度如何？' });
    // second patch merges instead of replacing
    const r2 = await s.api<{ account: { settings: Record<string, unknown>; timezone: string } }>('PATCH', '/api/me', { token, body: { timezone: 'Asia/Tokyo', settings: { notifications: { overdue: false }, requireConfirmation: false } } });
    expect(r2.body.account.timezone).toBe('Asia/Tokyo');
    expect(r2.body.account.settings).toEqual({ notifications: { digest: false, overdue: false }, nudgeTemplate: '{title} 进度如何？', requireConfirmation: false });
    expect((await s.api<{ account: { name: string } }>('GET', '/api/me', { token })).body.account.name).toBe('小蔡');
    // validation
    expect((await s.api('PATCH', '/api/me', { token, body: { timezone: 'Mars/Olympus' } })).status).toBe(400);
    expect((await s.api('PATCH', '/api/me', { token, body: { settings: { keyFields: ['colour'] } } })).status).toBe(400);
    // clearing the template
    const r3 = await s.api<{ account: { settings: Record<string, unknown> } }>('PATCH', '/api/me', { token, body: { settings: { nudgeTemplate: null } } });
    expect(r3.body.account.settings).not.toHaveProperty('nudgeTemplate');
  });

  it('requireConfirmation=false lets a claude due-date edit apply directly; keyFields narrows the guarded set', async () => {
    const p = (await s.api<ProjectRes>('POST', '/api/projects', { body: { name: '官网改版', outline: SAMPLE_OUTLINE }, token })).body;
    const n = p.nodes.find((x) => x.title === '接口联调')!;

    await s.api('PATCH', '/api/me', { token, body: { settings: { requireConfirmation: false } } });
    const direct = await setDue(p.project.id, n, '2026-10-15', 'claude');
    expect(direct.ok).toBe(true);
    expect(direct.changeIds).toBeUndefined();
    expect(direct.serverSeq).toBeDefined();
    expect(direct.node!.dueDate).toBe('2026-10-15');
    expect((await s.api<unknown[]>('GET', '/api/changes?status=pending', { token })).body).toHaveLength(0);

    // confirmation back on, but only deletes are guarded
    await s.api('PATCH', '/api/me', { token, body: { settings: { requireConfirmation: true, keyFields: ['delete'] } } });
    const direct2 = await setDue(p.project.id, direct.node!, '2026-10-16', 'claude');
    expect(direct2.changeIds).toBeUndefined();
    expect(direct2.node!.dueDate).toBe('2026-10-16');
    const del = await s.api<OpsRes>('POST', `/api/projects/${p.project.id}/ops`, { body: { ops: [op(p.project.id, { type: 'delete_node', nodeId: n.id }, 'claude')] }, token });
    expect(del.body.results[0]!.changeIds).toHaveLength(1);
    expect(del.body.results[0]!.serverSeq).toBeUndefined();

    // defaults restored → due date is guarded again
    await s.api('PATCH', '/api/me', { token, body: { settings: { keyFields: ['dueDate', 'startDate', 'ownerId', 'delete', 'status_done'] } } });
    const held = await setDue(p.project.id, direct2.node!, '2026-10-17', 'claude');
    expect(held.changeIds).toHaveLength(1);
    expect(held.node!.dueDate).toBe('2026-10-16');
  });
});

describe('weekly digest written by Claude', () => {
  const text = (t: string): BetaContentBlock => ({ type: 'text', text: t, citations: null } as BetaContentBlock);

  async function fixture() {
    await s.api('POST', '/api/devices', { body: { platform: 'ios', pushToken: PUSH_TOKEN }, token });
    const today = (await s.api<{ today: string }>('GET', '/api/today', { token })).body.today;
    const p = (await s.api<ProjectRes>('POST', '/api/projects', { body: { name: '官网改版' }, token })).body;
    const late = await createNode(p.project.id, p.project.rootNodeId, { title: '接口联调', dueDate: '2026-01-05' }, 'a0');
    const soon = await createNode(p.project.id, p.project.rootNodeId, { title: '前端页面', dueDate: today }, 'a1');
    const done = await createNode(p.project.id, p.project.rootNodeId, { title: '视觉稿', dueDate: today }, 'a2');
    await s.api<OpsRes>('POST', `/api/projects/${p.project.id}/ops`, { body: { ops: [op(p.project.id, { type: 'update_node', nodeId: done.id, patch: { status: 'done' } })] }, token });
    await setDue(p.project.id, soon, '2026-12-31', 'claude'); // pending change
    s.pushes.splice(0);
    return { today, p, late, soon };
  }

  it('asks Claude for the digest with the compact week JSON and pushes its text', async () => {
    const f = await fixture();
    const client = scriptedClient([[text('上周完成 1 项，本周到期 1 项，逾期 1 项，待确认 1 项。\n最要紧：接口联调（1/5）已经逾期。\n建议先把接口联调收尾。')]]);
    s.useClaude(client);
    const run = await s.api<{ sent: string[] }>('POST', '/api/notifications/run?kind=weekly', { token });
    expect(run.body.sent).toEqual(['digest']);
    expect(s.pushes).toHaveLength(1);
    expect(s.pushes[0]!.categoryId).toBe('digest');
    expect(s.pushes[0]!.title).toBe('本周计划');
    expect(s.pushes[0]!.body).toContain('上周完成 1 项');
    expect(s.pushes[0]!.body).toContain('建议先把接口联调收尾。');

    expect(client.requests).toHaveLength(1);
    const req = client.requests[0]!;
    expect(req.max_tokens).toBe(600);
    expect(req.effort).toBe('low');
    expect(req.tools).toBeUndefined();
    const week = JSON.parse(req.messages[0]!.content as string) as { today: string; overdue: { title: string; daysOverdue: number }[]; dueThisWeek: { title: string }[]; pending: { title: string; field: string }[]; completedLastWeek: number };
    expect(week.today).toBe(f.today);
    expect(week.overdue.map((o) => o.title)).toEqual(['接口联调']);
    expect(week.overdue[0]!.daysOverdue).toBeGreaterThan(200);
    expect(week.dueThisWeek.map((d) => d.title)).toEqual(['前端页面']);
    expect(week.pending).toEqual([{ project: '官网改版', title: '前端页面', field: 'dueDate', from: f.today, to: '2026-12-31' }]);
    expect(week.completedLastWeek).toBe(1);

    const notifications = await s.api<{ kind: string; payload: { source: string; text: string; completedLastWeek: number } }[]>('GET', '/api/notifications', { token });
    const digest = notifications.body.find((n) => n.kind === 'digest')!;
    expect(digest.payload.source).toBe('claude');
    expect(digest.payload.text).toBe(s.pushes[0]!.body);
    expect(digest.payload.completedLastWeek).toBe(1);
  });

  it('falls back to the template when Claude fails, refuses, or is unconfigured', async () => {
    await fixture();
    s.useClaude(scriptedClient([])); // no scripted answer → the fake throws
    let run = await s.api<{ sent: string[] }>('POST', '/api/notifications/run?kind=weekly', { token });
    expect(run.body.sent).toEqual(['digest']);
    expect(s.pushes[0]!.title).toBe('本周');
    expect(s.pushes[0]!.body).toBe('本周到期 1、逾期 1、待确认 1');
    const notifications = await s.api<{ kind: string; payload: { source: string } }[]>('GET', '/api/notifications', { token });
    expect(notifications.body.find((n) => n.kind === 'digest')!.payload.source).toBe('template');

    // a refusal on another day also falls back
    await s.sql`delete from notification where kind = 'digest'`;
    s.pushes.splice(0);
    s.useClaude({
      stream: async () => {
        throw new Error('unused');
      },
      create: async (req) => ({ ...(await scriptedClient([[text('')]]).create(req)), stop_reason: 'refusal' }),
    });
    run = await s.api<{ sent: string[] }>('POST', '/api/notifications/run?kind=weekly', { token });
    expect(run.body.sent).toEqual(['digest']);
    expect(s.pushes[0]!.body).toBe('本周到期 1、逾期 1、待确认 1');
  });
});
