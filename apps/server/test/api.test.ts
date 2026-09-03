import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TNode } from '@tsai-mind/core';
import { SAMPLE_OUTLINE, op, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let token: string;

type ProjectRes = { project: { id: string; rootNodeId: string }; nodes: TNode[]; warnings: unknown[] };
type OpsRes = { results: { opId: string; ok: boolean; serverSeq?: number; error?: string; current?: TNode; changeIds?: string[]; node?: TNode }[]; serverSeq: number };

async function createProject(name = '官网改版', outline = SAMPLE_OUTLINE) {
  const r = await s.api<ProjectRes>('POST', '/api/projects', { body: { name, outline }, token });
  expect(r.status).toBe(201);
  return r.body;
}
const byTitle = (nodes: TNode[], title: string) => nodes.find((n) => n.title === title)!;

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

describe('auth', () => {
  it('rejects missing and invalid tokens with 401', async () => {
    expect((await s.api('GET', '/api/me', { token: null })).status).toBe(401);
    expect((await s.api('GET', '/api/me', { token: 'tm_nope' })).status).toBe(401);
    expect((await s.api('POST', '/mcp', { token: null, body: {} })).status).toBe(401);
  });
  it('accepts a valid token and reports scopes', async () => {
    const r = await s.api<{ account: { name: string }; scopes: string[] }>('GET', '/api/me', { token });
    expect(r.status).toBe(200);
    expect(r.body.account.name).toBe('蔡');
    expect(r.body.scopes).toEqual(['read', 'write', 'decide']);
  });
  it('enforces scopes with 403', async () => {
    const ro = await s.token(['read']);
    expect((await s.api('GET', '/api/projects', { token: ro })).status).toBe(200);
    expect((await s.api('POST', '/api/projects', { token: ro, body: { name: 'x' } })).status).toBe(403);
    const rw = await s.token(['read', 'write']);
    expect((await s.api('POST', '/api/changes/batch', { token: rw, body: { decisions: [] } })).status).toBe(403);
  });
  it('rejects revoked tokens', async () => {
    const t = await s.token();
    expect((await s.api('GET', '/api/me', { token: t })).status).toBe(200);
    await s.sql`update access_token set revoked_at = now()`;
    expect((await s.api('GET', '/api/me', { token: t })).status).toBe(401);
  });
  it('never returns the token itself from /api/tokens', async () => {
    const r = await s.api<{ label: string }[]>('GET', '/api/tokens', { token });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('tm_');
    expect(r.body[0]!.label).toBe('test');
  });
});

describe('projects', () => {
  it('creates a project from an outline and serves outline/tree/today', async () => {
    const created = await createProject();
    expect(created.warnings).toEqual([]);
    expect(created.nodes).toHaveLength(7);
    const dev = byTitle(created.nodes, '开发');
    expect(byTitle(created.nodes, '前端页面').parentId).toBe(dev.id);
    expect(byTitle(created.nodes, '上线').kind).toBe('milestone');
    expect(byTitle(created.nodes, '视觉稿').dueDate).toBe('2026-09-08');

    const list = await s.api<{ id: string; nodeCount: number; overdueCount: number; pendingCount: number }[]>('GET', '/api/projects', { token });
    expect(list.body).toHaveLength(1);
    expect(list.body[0]!.nodeCount).toBe(7);

    const outline = await s.api<string>('GET', `/api/projects/${created.project.id}/outline`, { token, raw: true });
    expect(outline.status).toBe(200);
    expect(outline.body).toContain(`- 官网改版 [${created.project.rootNodeId}]`);
    expect(outline.body).toContain('- 设计 [');
    expect(outline.body).toContain('◆ 上线');

    const detail = await s.api<{ nodes: TNode[]; derived: Record<string, { progress: number; status: string }>; serverSeq: number }>('GET', `/api/projects/${created.project.id}`, { token });
    expect(detail.body.nodes).toHaveLength(7);
    expect(detail.body.derived[created.project.rootNodeId]!.status).toBe('blocked');
    expect(detail.body.serverSeq).toBe(6);
  });

  it('merges a single outline root named like the project into the root', async () => {
    const created = await createProject('P', '- P\n  - a\n  - b');
    expect(created.nodes).toHaveLength(3);
    expect(byTitle(created.nodes, 'a').parentId).toBe(created.project.rootNodeId);
  });

  it('reports unknown contacts as warnings', async () => {
    const created = await createProject('P', '- a @nobody');
    expect(created.warnings[0]).toMatchObject({ lineNo: 1 });
    expect(created.nodes).toHaveLength(2);
  });

  it('patches name and archive', async () => {
    const { project } = await createProject();
    const r = await s.api<{ name: string; archivedAt: string | null }>('PATCH', `/api/projects/${project.id}`, { token, body: { name: 'New', archivedAt: new Date().toISOString() } });
    expect(r.body.name).toBe('New');
    expect(r.body.archivedAt).not.toBeNull();
    expect((await s.api<unknown[]>('GET', '/api/projects', { token })).body).toHaveLength(0);
  });
});

describe('ops', () => {
  it('create / update / move / delete and version conflicts', async () => {
    const { project, nodes } = await createProject();
    const pid = project.id;
    const dev = byTitle(nodes, '开发');
    const design = byTitle(nodes, '设计');
    const newId = crypto.randomUUID();

    const r1 = await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, {
      token,
      body: {
        ops: [
          op(pid, { type: 'create_node', node: { id: newId, projectId: pid, parentId: dev.id, rank: 'z', title: '埋点接入', dueDate: '2026-09-28', tags: ['fe', 'tracking'] } }),
          op(pid, { type: 'update_node', nodeId: dev.id, patch: { title: '开发（改）', progress: 50 }, baseVersion: dev.version }),
        ],
      },
    });
    expect(r1.status).toBe(200);
    expect(r1.body.results.map((r) => r.ok)).toEqual([true, true]);
    expect(r1.body.serverSeq).toBe(8);
    expect(r1.body.results[0]!.node!.tags).toEqual(['fe', 'tracking']);

    // stale version → version_conflict with current
    const r2 = await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, {
      token,
      body: { ops: [op(pid, { type: 'update_node', nodeId: dev.id, patch: { title: 'x' }, baseVersion: dev.version })] },
    });
    expect(r2.body.results[0]).toMatchObject({ ok: false, error: 'version_conflict' });
    expect(r2.body.results[0]!.current!.title).toBe('开发（改）');
    expect(r2.body.results[0]!.current!.version).toBe(dev.version + 1);

    // move under 设计, cycle rejected
    const r3 = await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, {
      token,
      body: {
        ops: [
          op(pid, { type: 'move_node', nodeId: newId, parentId: design.id, rank: 'zz' }),
          op(pid, { type: 'move_node', nodeId: dev.id, parentId: newId, rank: 'a' }),
        ],
      },
    });
    expect(r3.body.results[0]!.ok).toBe(true);
    expect(r3.body.results[1]!.ok).toBe(true); // 埋点接入 now lives under 设计, so 开发 may move under it
    // a real cycle: 设计 under 埋点接入 (which is under 设计)
    const r3b = await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, {
      token,
      body: { ops: [op(pid, { type: 'move_node', nodeId: design.id, parentId: newId, rank: 'a' })] },
    });
    expect(r3b.body.results[0]).toMatchObject({ ok: false, error: 'cycle' });

    // delete subtree, then ops log
    const r4 = await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, { token, body: { ops: [op(pid, { type: 'delete_node', nodeId: design.id })] } });
    expect(r4.body.results[0]!.ok).toBe(true);
    const detail = await s.api<{ nodes: TNode[] }>('GET', `/api/projects/${pid}`, { token });
    expect(detail.body.nodes.map((n) => n.title)).not.toContain('设计');
    expect(detail.body.nodes.map((n) => n.title)).not.toContain('埋点接入');

    const ops = await s.api<{ serverSeq: number; op: { type: string } }[]>('GET', `/api/projects/${pid}/ops?since=8`, { token });
    expect(ops.body.map((o) => o.op.type)).toEqual(['move_node', 'move_node', 'delete_node']);

    // duplicate opId is idempotent
    const dup = op(pid, { type: 'update_node', nodeId: dev.id, patch: { description: 'd' } });
    const a = await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, { token, body: { ops: [dup] } });
    const b = await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, { token, body: { ops: [dup] } });
    expect(b.body.results[0]!.serverSeq).toBe(a.body.results[0]!.serverSeq);

    // activity
    const act = await s.api<{ kind: string; actor: string }[]>('GET', `/api/projects/${pid}/activity`, { token });
    expect(act.body.map((x) => x.kind)).toContain('deleted');
    expect(act.body.map((x) => x.kind)).toContain('moved');
  });

  it('validates op bodies', async () => {
    const { project } = await createProject();
    const r = await s.api<{ error: string }>('POST', `/api/projects/${project.id}/ops`, { token, body: { ops: [{ type: 'nope' }] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid');
  });

  it('rejects start after due', async () => {
    const { project, nodes } = await createProject();
    const n = byTitle(nodes, '前端页面');
    const r = await s.api<OpsRes>('POST', `/api/projects/${project.id}/ops`, {
      token,
      body: { ops: [op(project.id, { type: 'update_node', nodeId: n.id, patch: { startDate: '2026-12-01' } })] },
    });
    expect(r.body.results[0]).toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe('changes (claude confirmation flow)', () => {
  it('holds a claude dueDate change as pending, applies it on approve', async () => {
    const { project, nodes } = await createProject();
    const pid = project.id;
    const n = byTitle(nodes, '接口联调');
    const r = await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, {
      token,
      body: { ops: [op(pid, { type: 'update_node', nodeId: n.id, patch: { dueDate: '2026-10-15', description: 'moved' }, baseVersion: n.version }, 'claude')] },
    });
    const res = r.body.results[0]!;
    expect(res.ok).toBe(true);
    expect(res.changeIds).toHaveLength(1);
    expect(res.serverSeq).toBeDefined(); // the direct part (description) applied
    expect(res.node!.description).toBe('moved');
    expect(res.node!.dueDate).toBe('2026-09-30');

    const pending = await s.api<{ id: string; field: string; newValue: string; nodeTitle: string; projectName: string }[]>('GET', '/api/changes?status=pending', { token });
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]).toMatchObject({ field: 'dueDate', newValue: '2026-10-15', nodeTitle: '接口联调', projectName: '官网改版' });

    // same field again → same change id
    const again = await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, {
      token,
      body: { ops: [op(pid, { type: 'update_node', nodeId: n.id, patch: { dueDate: '2026-10-20' } }, 'claude')] },
    });
    expect(again.body.results[0]!.changeIds).toEqual(res.changeIds);

    const list = await s.api<{ pendingCount: number }[]>('GET', '/api/projects', { token });
    expect(list.body[0]!.pendingCount).toBe(1);

    const approve = await s.api<{ change: { status: string } }>('POST', `/api/changes/${res.changeIds![0]}/approve`, { token });
    expect(approve.status).toBe(200);
    expect(approve.body.change.status).toBe('approved');
    const detail = await s.api<{ nodes: TNode[] }>('GET', `/api/projects/${pid}`, { token });
    expect(byTitle(detail.body.nodes, '接口联调').dueDate).toBe('2026-10-15');
    expect((await s.api<unknown[]>('GET', '/api/changes?status=pending', { token })).body).toHaveLength(0);
    expect((await s.api('POST', `/api/changes/${res.changeIds![0]}/approve`, { token })).status).toBe(409);
  });

  it('claude delete is held; reject leaves the node; batch decisions work', async () => {
    const { project, nodes } = await createProject();
    const pid = project.id;
    const n = byTitle(nodes, '上线');
    const r = await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, { token, body: { ops: [op(pid, { type: 'delete_node', nodeId: n.id }, 'claude')] } });
    expect(r.body.results[0]!.changeIds).toHaveLength(1);
    expect(r.body.results[0]!.serverSeq).toBeUndefined();
    const b = await s.api<{ results: { ok: boolean }[] }>('POST', '/api/changes/batch', { token, body: { decisions: [{ id: r.body.results[0]!.changeIds![0], decision: 'reject' }] } });
    expect(b.body.results[0]!.ok).toBe(true);
    const detail = await s.api<{ nodes: TNode[] }>('GET', `/api/projects/${pid}`, { token });
    expect(byTitle(detail.body.nodes, '上线')).toBeDefined();
  });

  it('a direct owner edit supersedes the pending proposal on that field', async () => {
    const { project, nodes } = await createProject();
    const pid = project.id;
    const n = byTitle(nodes, '上线');
    await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, { token, body: { ops: [op(pid, { type: 'update_node', nodeId: n.id, patch: { dueDate: '2026-10-15' } }, 'claude')] } });
    await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, { token, body: { ops: [op(pid, { type: 'update_node', nodeId: n.id, patch: { dueDate: '2026-10-12' } })] } });
    expect((await s.api<unknown[]>('GET', '/api/changes?status=pending', { token })).body).toHaveLength(0);
    expect((await s.api<unknown[]>('GET', '/api/changes?status=expired', { token })).body).toHaveLength(1);
  });
});

describe('undo', () => {
  it('undoes an update and a delete', async () => {
    const { project, nodes } = await createProject();
    const pid = project.id;
    const n = byTitle(nodes, '前端页面');
    const r = await s.api<OpsRes>('POST', `/api/projects/${pid}/ops`, {
      token,
      body: { ops: [op(pid, { type: 'update_node', nodeId: n.id, patch: { title: 'renamed', progress: 90 } }), op(pid, { type: 'delete_node', nodeId: byTitle(nodes, '设计').id })] },
    });
    const [u, d] = r.body.results;
    const undo1 = await s.api<{ results: { ok: boolean }[] }>('POST', `/api/ops/${u!.serverSeq}/undo`, { token });
    expect(undo1.status).toBe(200);
    expect(undo1.body.results[0]!.ok).toBe(true);
    const undo2 = await s.api('POST', `/api/ops/${d!.serverSeq}/undo`, { token });
    expect(undo2.status).toBe(200);
    const detail = await s.api<{ nodes: TNode[] }>('GET', `/api/projects/${pid}`, { token });
    expect(byTitle(detail.body.nodes, '前端页面').progress).toBe(60);
    expect(byTitle(detail.body.nodes, '设计')).toBeDefined();
    expect(byTitle(detail.body.nodes, '视觉稿')).toBeDefined();
    // already undone
    expect((await s.api('POST', `/api/ops/${u!.serverSeq}/undo`, { token })).status).toBe(409);
    expect((await s.api('POST', `/api/ops/99999/undo`, { token })).status).toBe(404);
  });
});

describe('today & nudge', () => {
  it('lists overdue, due today and nudge-due items across projects', async () => {
    const today = new Date().toISOString().slice(0, 10); // tests run close to UTC; Asia/Taipei date may differ by a day, so use relative dates via API
    const t = await s.api<{ today: string }>('GET', '/api/today', { token });
    const tz = t.body.today;
    const iso = (d: number) => {
      const [y, m, dd] = tz.split('-').map(Number) as [number, number, number];
      const x = new Date(Date.UTC(y, m - 1, dd + d));
      return x.toISOString().slice(0, 10);
    };
    void today;
    const contact = await s.api<{ id: string }>('POST', '/api/contacts', { token, body: { name: '陈小明', company: 'ACME' } });
    expect(contact.status).toBe(201);
    await createProject('A', `- late @陈小明 ${iso(-5)}\n- now ${iso(0)}\n- soon ${iso(1)}\n- fine ${iso(10)}`);
    await createProject('B', `- also-late ${iso(-1)}`);
    const r = await s.api<{ overdue: { node: TNode; projectName: string; daysOverdue: number }[]; dueToday: { node: TNode }[]; dueTomorrow: { node: TNode }[]; nudgeDue: { node: TNode }[] }>('GET', '/api/today', { token });
    expect(r.body.overdue.map((i) => i.node.title).sort()).toEqual(['also-late', 'late']);
    expect(r.body.overdue.find((i) => i.node.title === 'late')!.daysOverdue).toBe(5);
    expect(r.body.dueToday.map((i) => i.node.title)).toEqual(['now']);
    expect(r.body.dueTomorrow.map((i) => i.node.title)).toEqual(['soon']);
    expect(r.body.nudgeDue.map((i) => i.node.title)).toEqual(['late']);

    const late = r.body.nudgeDue[0]!.node;
    const nudge = await s.api<{ text: string; node: TNode }>('POST', `/api/nodes/${late.id}/nudge`, { token, body: {} });
    expect(nudge.status).toBe(200);
    expect(nudge.text ?? nudge.body.text).toContain('关于「late」');
    expect(nudge.body.text).toContain('进度 0%');
    expect(nudge.body.node.lastNudgedAt).not.toBeNull();
    const after = await s.api<{ nudgeDue: unknown[] }>('GET', '/api/today', { token });
    expect(after.body.nudgeDue).toHaveLength(0);

    const custom = await s.api<{ text: string }>('POST', `/api/nodes/${late.id}/nudge`, { token, body: { template: '{owner}: {title} due {due}' } });
    expect(custom.body.text).toBe(`陈小明: late due ${Number(iso(-5).slice(5, 7))}/${Number(iso(-5).slice(8, 10))}`);

    const workload = await s.api<{ node: TNode; projectName: string; path: string[] }[]>('GET', `/api/contacts/${contact.body.id}/nodes`, { token });
    expect(workload.body).toHaveLength(1);
    expect(workload.body[0]!.projectName).toBe('A');
    expect(workload.body[0]!.path).toEqual(['A']);
  });
});

describe('plan batches', () => {
  it('drafts and applies an append batch, reporting version conflicts', async () => {
    const { project, nodes } = await createProject();
    const pid = project.id;
    const dev = byTitle(nodes, '开发');
    const draft = await s.api<{ id: string; status: string; diff: { summary: { create: number }; created: unknown[]; errors: unknown[] }; previewUrl: string }>('POST', `/api/projects/${pid}/plan-batches`, {
      token,
      body: { parentId: dev.id, outline: '- 埋点接入 9/20–9/28\n  - 事件表\n- 性能优化', mode: 'append' },
    });
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe('draft');
    expect(draft.body.diff.summary.create).toBe(3);
    expect(draft.body.diff.errors).toEqual([]);
    expect(draft.body.previewUrl).toContain(draft.body.id);
    // nothing applied yet
    expect((await s.api<{ nodes: TNode[] }>('GET', `/api/projects/${pid}`, { token })).body.nodes).toHaveLength(7);

    const got = await s.api<{ id: string }>('GET', `/api/plan-batches/${draft.body.id}`, { token });
    expect(got.body.id).toBe(draft.body.id);

    const applied = await s.api<{ batch: { status: string }; results: { ok: boolean }[] }>('POST', `/api/plan-batches/${draft.body.id}/apply`, { token });
    expect(applied.status).toBe(200);
    expect(applied.body.batch.status).toBe('applied');
    expect(applied.body.results.every((r) => r.ok)).toBe(true);
    const detail = await s.api<{ nodes: TNode[] }>('GET', `/api/projects/${pid}`, { token });
    expect(detail.body.nodes).toHaveLength(10);
    expect(byTitle(detail.body.nodes, '埋点接入').parentId).toBe(dev.id);
    expect(byTitle(detail.body.nodes, '事件表').parentId).toBe(byTitle(detail.body.nodes, '埋点接入').id);
    expect(byTitle(detail.body.nodes, '埋点接入').dueDate).toBe('2026-09-28');
    const act = await s.api<{ kind: string; actor: string }[]>('GET', `/api/projects/${pid}/activity`, { token });
    expect(act.body.find((a) => a.kind === 'batch_applied')).toBeDefined();
    expect((await s.api('POST', `/api/plan-batches/${draft.body.id}/apply`, { token })).status).toBe(409);
  });

  it('sync batch updates existing nodes and fails stale ones', async () => {
    const { project, nodes } = await createProject();
    const pid = project.id;
    const fe = byTitle(nodes, '前端页面');
    const api = byTitle(nodes, '接口联调');
    const draft = await s.api<{ id: string; diff: { summary: { update: number } } }>('POST', `/api/projects/${pid}/plan-batches`, {
      token,
      body: { parentId: byTitle(nodes, '开发').id, outline: `- 前端页面 [${fe.id}] 80%\n- 接口联调（新名） [${api.id}]`, mode: 'sync' },
    });
    expect(draft.body.diff.summary.update).toBe(2);
    // bump 接口联调 behind the batch's back
    await s.api('POST', `/api/projects/${pid}/ops`, { token, body: { ops: [op(pid, { type: 'update_node', nodeId: api.id, patch: { description: 'x' } })] } });
    const applied = await s.api<{ results: { ok: boolean; error?: string }[] }>('POST', `/api/plan-batches/${draft.body.id}/apply`, { token });
    expect(applied.body.results.map((r) => r.ok)).toEqual([true, false]);
    expect(applied.body.results[1]!.error).toBe('version_conflict');
    const detail = await s.api<{ nodes: TNode[] }>('GET', `/api/projects/${pid}`, { token });
    expect(byTitle(detail.body.nodes, '前端页面').progress).toBe(80);
  });

  it('discards a draft', async () => {
    const { project } = await createProject();
    const draft = await s.api<{ id: string }>('POST', `/api/projects/${project.id}/plan-batches`, { token, body: { parentId: project.rootNodeId, outline: '- x', mode: 'append' } });
    const d = await s.api<{ status: string }>('POST', `/api/plan-batches/${draft.body.id}/discard`, { token });
    expect(d.body.status).toBe('discarded');
  });
});

describe('contacts & search', () => {
  it('CRUD contacts and searches nodes with path', async () => {
    const c = await s.api<{ id: string; name: string }>('POST', '/api/contacts', { token, body: { name: '王芳', email: 'w@x.io' } });
    expect(c.status).toBe(201);
    const u = await s.api<{ company: string }>('PATCH', `/api/contacts/${c.body.id}`, { token, body: { company: 'ACME' } });
    expect(u.body.company).toBe('ACME');
    await createProject('P', '- 开发 @王芳\n  - 前端 @王芳 9/1');
    const search = await s.api<{ node: TNode; path: string[]; projectName: string }[]>('GET', '/api/search?query=前端', { token });
    expect(search.body).toHaveLength(1);
    expect(search.body[0]!.path).toEqual(['P', '开发']);
    const byOwner = await s.api<unknown[]>('GET', `/api/search?ownerId=${c.body.id}`, { token });
    expect(byOwner.body).toHaveLength(2);
    const del = await s.api<{ archivedAt: string }>('DELETE', `/api/contacts/${c.body.id}`, { token });
    expect(del.body.archivedAt).not.toBeNull();
    expect((await s.api<unknown[]>('GET', '/api/contacts', { token })).body).toHaveLength(0);
  });
});

describe('realtime', () => {
  it('broadcasts ops and changes over the websocket', async () => {
    const { project, nodes } = await createProject();
    const ws = new WebSocket(`${s.baseUrl.replace('http', 'ws')}/api/realtime?token=${token}`);
    const messages: { type: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws failed'));
    });
    ws.onmessage = (ev) => messages.push(JSON.parse(String(ev.data)));
    ws.send(JSON.stringify({ type: 'ping' }));
    const n = byTitle(nodes, '上线');
    await s.api('POST', `/api/projects/${project.id}/ops`, { token, body: { ops: [op(project.id, { type: 'update_node', nodeId: n.id, patch: { title: 'go-live', dueDate: '2026-10-20' } }, 'claude')] } });
    await new Promise((r) => setTimeout(r, 200));
    ws.close();
    const types = messages.map((m) => m.type);
    expect(types).toContain('pong');
    expect(types).toContain('op');
    expect(types).toContain('change');

    const bad = new WebSocket(`${s.baseUrl.replace('http', 'ws')}/api/realtime?token=tm_bad`);
    const closed = await new Promise<boolean>((resolve) => {
      bad.onerror = () => resolve(true);
      bad.onclose = () => resolve(true);
      bad.onopen = () => resolve(false);
    });
    expect(closed).toBe(true);
  });
});
