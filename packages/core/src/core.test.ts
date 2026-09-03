import { describe, expect, it } from 'vitest';
import {
  TreeStore,
  computeRollup,
  computeToday,
  firstRank,
  parseOutline,
  planOps,
  rankBetween,
  ranksBetween,
  serializeOutline,
  splitPatch,
  opNeedsConfirmation,
  addDays,
  daysBetween,
  type Contact,
  type Op,
  type NewNodeInput,
} from './index.js';

const NOW = '2026-09-03T08:00:00.000Z';
const P = 'proj';
let seq = 0;
const base = () => ({ opId: `op${seq++}`, clientId: 'test', projectId: P, actor: 'user' as const, at: NOW });
const create = (node: NewNodeInput): Op => ({ ...base(), type: 'create_node', node });

function fixture() {
  const s = new TreeStore();
  const r = ['V', 'k', 's'];
  const add = (node: NewNodeInput) => {
    const res = s.apply(create(node));
    if (!res.ok) throw new Error(res.message);
  };
  add({ id: 'root', projectId: P, parentId: null, rank: 'V', title: '官网改版' });
  add({ id: 'design', projectId: P, parentId: 'root', rank: r[0]!, title: '设计', ownerId: 'c_lin' });
  add({ id: 'visual', projectId: P, parentId: 'design', rank: r[0]!, title: '视觉稿', ownerId: 'c_lin', startDate: '2026-09-01', dueDate: '2026-09-08', status: 'done' });
  add({ id: 'proto', projectId: P, parentId: 'design', rank: r[1]!, title: '交互原型', ownerId: 'c_lin', startDate: '2026-09-05', dueDate: '2026-09-12', status: 'done' });
  add({ id: 'dev', projectId: P, parentId: 'root', rank: r[1]!, title: '开发', ownerId: 'c_wang' });
  add({ id: 'fe', projectId: P, parentId: 'dev', rank: r[0]!, title: '前端页面', ownerId: 'c_wang', startDate: '2026-09-08', dueDate: '2026-09-24', status: 'in_progress', progress: 60, estimateHours: 40 });
  add({ id: 'api', projectId: P, parentId: 'dev', rank: r[1]!, title: '接口联调', ownerId: 'c_chen', startDate: '2026-09-15', dueDate: '2026-09-30', status: 'blocked', progress: 10, estimateHours: 24 });
  add({ id: 'launch', projectId: P, parentId: 'root', rank: r[2]!, title: '上线', kind: 'milestone', dueDate: '2026-10-10' });
  return s;
}

const contacts: Contact[] = [
  { id: 'c_lin', name: '林', company: null, email: null, phone: null, notes: null, archivedAt: null },
  { id: 'c_wang', name: '王芳', company: null, email: null, phone: null, notes: null, archivedAt: null },
  { id: 'c_chen', name: '陈小明', company: null, email: null, phone: null, notes: null, archivedAt: null },
];

describe('rank', () => {
  it('produces ordered keys with room on both sides', () => {
    const a = firstRank();
    const after = rankBetween(a, null);
    const before = rankBetween(null, a);
    expect(before < a && a < after).toBe(true);
    const mid = rankBetween(before, a);
    expect(before < mid && mid < a).toBe(true);
    const many = ranksBetween(a, after, 50);
    for (let i = 1; i < many.length; i++) expect(many[i - 1]! < many[i]!).toBe(true);
    expect(many.every((k) => a < k && k < after)).toBe(true);
    expect(many.every((k) => !k.endsWith('0'))).toBe(true);
  });
  it('keeps working when repeatedly inserting at the front', () => {
    let k = firstRank();
    for (let i = 0; i < 200; i++) {
      const n = rankBetween(null, k);
      expect(n < k).toBe(true);
      k = n;
    }
    expect(k.length).toBeLessThan(60);
  });
  it('rejects inverted bounds', () => {
    expect(() => rankBetween('k', 'V')).toThrow();
  });
});

describe('TreeStore', () => {
  it('orders children by rank and finds paths', () => {
    const s = fixture();
    expect(s.children('root').map((n) => n.title)).toEqual(['设计', '开发', '上线']);
    expect(s.path('api')).toEqual(['官网改版', '开发']);
  });
  it('updates with version check and bumps version', () => {
    const s = fixture();
    const r1 = s.apply({ ...base(), type: 'update_node', nodeId: 'api', patch: { dueDate: '2026-10-05' }, baseVersion: 1 });
    expect(r1.ok).toBe(true);
    expect(s.get('api')!.version).toBe(2);
    const r2 = s.apply({ ...base(), type: 'update_node', nodeId: 'api', patch: { title: 'x' }, baseVersion: 1 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe('version_conflict');
  });
  it('setting done forces progress to 100 and inverse restores it', () => {
    const s = fixture();
    const op: Op = { ...base(), type: 'update_node', nodeId: 'fe', patch: { status: 'done' } };
    const inv = s.inverseOf(op)!;
    expect(s.apply(op).ok).toBe(true);
    expect(s.get('fe')!.progress).toBe(100);
    expect(s.apply(inv).ok).toBe(true);
    expect(s.get('fe')!.status).toBe('in_progress');
    expect(s.get('fe')!.progress).toBe(60);
  });
  it('rejects cycles and root moves', () => {
    const s = fixture();
    const cyc = s.apply({ ...base(), type: 'move_node', nodeId: 'dev', parentId: 'api', rank: 'V' });
    expect(cyc.ok).toBe(false);
    if (!cyc.ok) expect(cyc.error).toBe('cycle');
    const root = s.apply({ ...base(), type: 'move_node', nodeId: 'root', parentId: 'dev', rank: 'V' });
    expect(root.ok).toBe(false);
  });
  it('soft-deletes a subtree and restores it', () => {
    const s = fixture();
    const del: Op = { ...base(), type: 'delete_node', nodeId: 'dev' };
    const inv = s.inverseOf(del)!;
    const r = s.apply(del);
    expect(r.ok && r.changed.length).toBe(3);
    expect(s.live('fe')).toBeUndefined();
    expect(s.children('root').map((n) => n.id)).toEqual(['design', 'launch']);
    expect(s.apply(inv).ok).toBe(true);
    expect(s.live('fe')).toBeDefined();
    expect(s.children('root').map((n) => n.id)).toEqual(['design', 'dev', 'launch']);
  });
  it('rejects unknown patch fields', () => {
    const s = fixture();
    const r = s.apply({ ...base(), type: 'update_node', nodeId: 'fe', patch: { version: 9 } as never });
    expect(r.ok).toBe(false);
  });
});

describe('rollup', () => {
  it('rolls up progress by estimate weight, dates by min/max, and status', () => {
    const s = fixture();
    const d = computeRollup(s);
    expect(d.get('design')).toMatchObject({ progress: 100, status: 'done', startDate: '2026-09-01', dueDate: '2026-09-12', hasChildren: true });
    // dev: fe 60 * 40h + api 10 * 24h = 2400 + 240 = 2640 / 64 = 41.25 → 41
    expect(d.get('dev')).toMatchObject({ progress: 41, status: 'blocked', startDate: '2026-09-08', dueDate: '2026-09-30' });
    // root: design 100 + dev 41 + launch 0, equal weights → 47
    expect(d.get('root')).toMatchObject({ progress: 47, status: 'blocked', startDate: '2026-09-01', dueDate: '2026-10-10' });
    expect(d.get('launch')).toMatchObject({ hasChildren: false, progress: 0 });
  });
  it('respects manual modes and ignores notes', () => {
    const s = fixture();
    s.apply({ ...base(), type: 'update_node', nodeId: 'dev', patch: { progressMode: 'manual', progress: 80, dateMode: 'manual', dueDate: '2026-09-28' } });
    s.apply(create({ id: 'memo', projectId: P, parentId: 'dev', rank: 'z', title: '备忘', kind: 'note', dueDate: '2026-12-31' }));
    const d = computeRollup(s);
    expect(d.get('dev')).toMatchObject({ progress: 80, dueDate: '2026-09-28', startDate: null });
    expect(d.get('root')!.dueDate).toBe('2026-10-10');
  });
});

describe('outline', () => {
  it('parses tokens in any order and builds a tree', () => {
    const text = `- 官网改版 [root] 9/1–10/10
  - 设计 [design] @林 9/1–9/12 done
    - 视觉稿 [visual] @林 9/1–9/8 done
  - 开发 [dev] @王芳 9/8–9/30 in_progress 35%
    - 接口联调 [api] @陈小明 2026-09-15–2026-09-30 blocked 10% ← 前端页面, 视觉稿
    - 埋点接入 @王芳 9/20–9/28
  - ◆ 上线 [launch] 10/10
  - § 备忘`;
    const r = parseOutline(text, { year: 2026 });
    expect(r.errors).toEqual([]);
    expect(r.roots).toHaveLength(1);
    const root = r.roots[0]!;
    expect(root.title).toBe('官网改版');
    expect(root.startDate).toBe('2026-09-01');
    expect(root.dueDate).toBe('2026-10-10');
    const dev = root.children[1]!;
    expect(dev).toMatchObject({ id: 'dev', owner: '王芳', status: 'in_progress', progress: 35 });
    const api = dev.children[0]!;
    expect(api).toMatchObject({ startDate: '2026-09-15', dueDate: '2026-09-30', status: 'blocked', deps: ['前端页面', '视觉稿'] });
    expect(dev.children[1]).toMatchObject({ id: null, title: '埋点接入', owner: '王芳', startDate: '2026-09-20', dueDate: '2026-09-28' });
    expect(root.children[2]).toMatchObject({ kind: 'milestone', title: '上线', dueDate: '2026-10-10' });
    expect(root.children[3]).toMatchObject({ kind: 'note', title: '备忘' });
  });
  it('round-trips serialize → parse', () => {
    const s = fixture();
    const text = serializeOutline(s, 'root', { contacts, year: 2026, derived: computeRollup(s) });
    expect(text).toContain('- 官网改版 [root] 9/1–10/10 blocked 47%');
    expect(text).toContain('    - 接口联调 [api] @陈小明 9/15–9/30 blocked 10%');
    expect(text).toContain('  - ◆ 上线 [launch] 10/10');
    const r = parseOutline(text, { year: 2026 });
    expect(r.errors).toEqual([]);
    const ids: string[] = [];
    const walk = (l: (typeof r.roots)[number]) => {
      ids.push(l.id!);
      l.children.forEach(walk);
    };
    r.roots.forEach(walk);
    expect(ids).toEqual(['root', 'design', 'visual', 'proto', 'dev', 'fe', 'api', 'launch']);
  });
  it('reports indentation jumps and unknown contacts', () => {
    const r = parseOutline(`- a\n      - b @nobody`, { year: 2026 });
    expect(r.errors[0]!.message).toMatch(/indentation/);
    const s = fixture();
    const plan = planOps(s, r, { projectId: P, parentId: 'root', mode: 'append', contacts, newId: () => 'n1', opBase: { clientId: 'c', actor: 'claude', at: NOW } });
    expect(plan.errors.some((e) => e.message.includes('unknown contact'))).toBe(true);
  });
});

describe('planOps', () => {
  const newIds = () => {
    let i = 0;
    return () => `new${++i}`;
  };
  it('append creates only, inheriting owner from parent when unspecified', () => {
    const s = fixture();
    const r = parseOutline(`- 开发 [dev] @林 done\n  - 埋点接入 9/20–9/28\n  - 性能优化 @陈小明`, { year: 2026 });
    const plan = planOps(s, r, { projectId: P, parentId: 'dev', mode: 'append', contacts, newId: newIds(), opBase: { clientId: 'c', actor: 'claude', at: NOW } });
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toEqual({ create: 2, update: 0, move: 0, delete: 0 });
    const c1 = plan.ops[0]!;
    expect(c1.type === 'create_node' && c1.node.ownerId).toBe('c_wang');
    const c2 = plan.ops[1]!;
    expect(c2.type === 'create_node' && c2.node.ownerId).toBe('c_chen');
    for (const op of plan.ops) expect(s.apply(op).ok).toBe(true);
    expect(s.children('dev').map((n) => n.title)).toEqual(['前端页面', '接口联调', '埋点接入', '性能优化']);
  });
  it('sync updates and moves existing nodes', () => {
    const s = fixture();
    const r = parseOutline(`- 设计 [design]\n  - 视觉稿 [visual] 9/1–9/9\n  - 接口联调 [api] @林`, { year: 2026 });
    const plan = planOps(s, r, { projectId: P, parentId: 'root', mode: 'sync', contacts, newId: newIds(), opBase: { clientId: 'c', actor: 'user', at: NOW } });
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toEqual({ create: 0, update: 2, move: 1, delete: 0 });
    for (const op of plan.ops) expect(s.apply(op).ok).toBe(true);
    expect(s.get('visual')!.dueDate).toBe('2026-09-09');
    expect(s.get('api')!.parentId).toBe('design');
    expect(s.get('api')!.ownerId).toBe('c_lin');
  });
  it('replace deletes unmentioned nodes (top-most only)', () => {
    const s = fixture();
    const r = parseOutline(`- 官网改版 [root]\n  - 设计 [design]\n    - 视觉稿 [visual]\n  - ◆ 上线 [launch]`, { year: 2026 });
    const plan = planOps(s, r, { projectId: P, parentId: 'root', mode: 'replace', contacts, newId: newIds(), opBase: { clientId: 'c', actor: 'user', at: NOW } });
    expect(plan.errors).toEqual([]);
    expect(plan.summary.delete).toBe(2); // proto, dev (fe/api go with dev)
    for (const op of plan.ops) expect(s.apply(op).ok).toBe(true);
    expect(s.all().map((n) => n.id).sort()).toEqual(['design', 'launch', 'root', 'visual']);
  });
  it('rejects ids outside the target subtree', () => {
    const s = fixture();
    const r = parseOutline(`- 设计 [design]`, { year: 2026 });
    const plan = planOps(s, r, { projectId: P, parentId: 'dev', mode: 'sync', contacts, newId: newIds(), opBase: { clientId: 'c', actor: 'user', at: NOW } });
    expect(plan.errors[0]!.message).toMatch(/outside/);
  });
});

describe('rules', () => {
  it('guards key fields only for claude', () => {
    const p = { dueDate: '2026-10-05', title: 'x', status: 'done' as const, progress: 50 };
    expect(splitPatch(p, 'user')).toEqual({ direct: p, guarded: {} });
    const c = splitPatch(p, 'claude');
    expect(c.direct).toEqual({ title: 'x', progress: 50 });
    expect(c.guarded).toEqual({ dueDate: '2026-10-05', status: 'done' });
    expect(splitPatch({ status: 'in_progress' }, 'claude').guarded).toEqual({});
    expect(splitPatch(p, 'claude', { requireConfirmation: false, keyFields: [] }).guarded).toEqual({});
  });
  it('holds claude deletes', () => {
    expect(opNeedsConfirmation({ ...base(), actor: 'claude', type: 'delete_node', nodeId: 'x' })).toBe(true);
    expect(opNeedsConfirmation({ ...base(), actor: 'user', type: 'delete_node', nodeId: 'x' })).toBe(false);
  });
});

describe('today', () => {
  it('buckets leaves and finds nudge candidates', () => {
    const s = fixture();
    s.apply({ ...base(), type: 'update_node', nodeId: 'fe', patch: { dueDate: '2026-09-03' } });
    s.apply({ ...base(), type: 'update_node', nodeId: 'api', patch: { dueDate: '2026-08-25', startDate: '2026-08-20' } });
    s.apply(create({ id: 'mine', projectId: P, parentId: 'root', rank: 'zz', title: '我的事', dueDate: '2026-08-25' }));
    const t = computeToday(s, computeRollup(s), [], { today: '2026-09-03' });
    expect(t.dueToday.map((i) => i.node.id)).toEqual(['fe']);
    expect(t.overdue.map((i) => i.node.id)).toEqual(['api', 'mine']);
    expect(t.overdue[0]!.daysOverdue).toBe(9);
    expect(t.nudgeDue.map((i) => i.node.id)).toEqual(['api']); // 'mine' has no owner
    s.apply({ ...base(), type: 'update_node', nodeId: 'api', patch: { lastNudgedAt: '2026-09-02T00:00:00Z' } });
    expect(computeToday(s, computeRollup(s), [], { today: '2026-09-03' }).nudgeDue).toEqual([]);
  });
});

describe('dates', () => {
  it('adds days and measures spans across month ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(daysBetween('2026-08-25', '2026-09-03')).toBe(9);
  });
});
