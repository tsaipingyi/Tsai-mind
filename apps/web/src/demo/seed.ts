/**
 * Seed data for demo mode. Everything is computed relative to `today` so the 今天 page
 * always has 逾期 / 今天到期 / 明天到期 / 该催的 entries and one pending change from Claude.
 */
import { TreeStore, addDays, planOps, parseOutline, rankBetween, shortDate } from '@tsai-mind/core';
import type { Change, Contact, Dependency, Project, TNode } from '@tsai-mind/core';
import type { Account, Activity, AssistantMessage, AssistantSession, PlanBatch, TokenSummary } from '../api/types';

export interface SeedProject {
  project: Project;
  nodes: TNode[];
  deps: Dependency[];
  activity: Activity[];
}

export interface Seed {
  account: Account;
  tokens: TokenSummary[];
  contacts: Contact[];
  projects: SeedProject[];
  changes: Change[];
  batches: PlanBatch[];
  sessions: AssistantSession[];
  messages: Map<string, AssistantMessage[]>;
}

export const CONTACT_LIN = 'c_lin';
export const CONTACT_WANG = 'c_wang';
export const CONTACT_CHEN = 'c_chen';
export const P1 = 'p1';
export const P2 = 'p2';
export const API_NODE = 'p1_api';

/** Ranks in sibling order: each call returns a rank after the previous one. */
function rankSeq(): () => string {
  let prev: string | null = null;
  return () => {
    prev = rankBetween(prev, null);
    return prev;
  };
}

export function buildSeed(today: string): Seed {
  const d = (n: number) => addDays(today, n);
  const at = (daysAgo: number, hour = 9) => `${d(-daysAgo)}T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

  let tz = 'Asia/Shanghai';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz;
  } catch {
    /* ignore */
  }

  const account: Account = { id: 'u_demo', email: 'demo@tsai.mind', name: '蔡', timezone: tz, settings: {} };

  const tokens: TokenSummary[] = [
    { id: 'tok_demo_1', label: 'Claude Code', kind: 'pat', clientName: null, scopes: ['read', 'write', 'decide'], createdAt: at(30), lastUsedAt: hoursAgo(3), expiresAt: null, revokedAt: null },
    { id: 'tok_demo_2', label: 'claude.ai', kind: 'oauth', clientName: 'Claude', scopes: ['read', 'write'], createdAt: at(12), lastUsedAt: at(1, 14), expiresAt: `${d(120)}T00:00:00.000Z`, revokedAt: null },
  ];

  const contacts: Contact[] = [
    { id: CONTACT_LIN, name: '林', company: '设计工作室', email: 'lin@studio.example', phone: null, notes: '视觉和交互都找她', archivedAt: null },
    { id: CONTACT_WANG, name: '王芳', company: null, email: 'wang@example.com', phone: null, notes: null, archivedAt: null },
    { id: CONTACT_CHEN, name: '陈小明', company: '外包', email: null, phone: '138-0000-0000', notes: '后端接口外包，周三例会', archivedAt: null },
  ];

  const mk = (projectId: string, created: string) => (partial: Partial<TNode> & Pick<TNode, 'id' | 'parentId' | 'rank' | 'title'>): TNode => ({
    projectId,
    description: '',
    kind: 'task',
    ownerId: null,
    status: 'todo',
    progress: 0,
    progressMode: 'auto',
    startDate: null,
    dueDate: null,
    dateMode: 'auto',
    estimateHours: null,
    priority: 3,
    tags: [],
    lastNudgedAt: null,
    version: 1,
    createdAt: created,
    updatedAt: created,
    deletedAt: null,
    ...partial,
  });

  // ---- 官网改版 ----
  const n1 = mk(P1, at(31));
  const r1 = rankSeq();
  const rDesign = rankSeq();
  const rDev = rankSeq();
  const rTest = rankSeq();
  const p1nodes: TNode[] = [
    n1({ id: 'p1_root', parentId: null, rank: r1(), title: '官网改版', kind: 'goal', description: '新官网上线：新视觉、新架构、接口全部换成 v2。' }),
    n1({ id: 'p1_design', parentId: 'p1_root', rank: r1(), title: '设计', ownerId: CONTACT_LIN }),
    n1({ id: 'p1_visual', parentId: 'p1_design', rank: rDesign(), title: '视觉稿', ownerId: CONTACT_LIN, startDate: d(-30), dueDate: d(-23), status: 'done', progress: 100, estimateHours: 32 }),
    n1({ id: 'p1_proto', parentId: 'p1_design', rank: rDesign(), title: '交互原型', ownerId: CONTACT_LIN, startDate: d(-26), dueDate: d(-19), status: 'done', progress: 100, estimateHours: 24 }),
    n1({ id: 'p1_dev', parentId: 'p1_root', rank: r1(), title: '开发', ownerId: CONTACT_WANG }),
    n1({ id: 'p1_fe', parentId: 'p1_dev', rank: rDev(), title: '前端页面', ownerId: CONTACT_WANG, startDate: d(-20), dueDate: d(1), status: 'in_progress', progress: 60, estimateHours: 40, version: 3 }),
    n1({ id: API_NODE, parentId: 'p1_dev', rank: rDev(), title: '接口联调', ownerId: CONTACT_CHEN, startDate: d(-13), dueDate: d(-5), status: 'blocked', progress: 10, estimateHours: 24, version: 2, description: '等后端 v2 接口；先用 mock 数据联调列表页。' }),
    n1({ id: 'p1_track', parentId: 'p1_dev', rank: rDev(), title: '埋点接入', ownerId: CONTACT_WANG, startDate: d(-3), dueDate: d(0), estimateHours: 8, priority: 2 }),
    n1({ id: 'p1_test', parentId: 'p1_root', rank: r1(), title: '测试', startDate: d(2), dueDate: d(20), estimateHours: 16 }),
    n1({ id: 'p1_regress', parentId: 'p1_test', rank: rTest(), title: '回归测试', ownerId: CONTACT_WANG, startDate: d(10), dueDate: d(20), estimateHours: 12 }),
    n1({ id: 'p1_launch', parentId: 'p1_root', rank: r1(), title: '上线', kind: 'milestone', dueDate: d(36), priority: 1 }),
  ];
  const p1deps: Dependency[] = [
    { fromNode: 'p1_fe', toNode: API_NODE },
    { fromNode: API_NODE, toNode: 'p1_test' },
  ];

  const change: Change = {
    id: 'ch_demo_1',
    nodeId: API_NODE,
    field: 'dueDate',
    oldValue: d(-5),
    newValue: d(5),
    reason: `后端接口 ${shortDate(d(3), Number(today.slice(0, 4)))} 才出`,
    source: 'claude',
    batchId: null,
    status: 'pending',
    decidedAt: null,
    createdAt: hoursAgo(2),
    expiresAt: `${d(7)}T00:00:00.000Z`,
  };

  let actId = 1;
  const act = (projectId: string, nodeId: string | null, actor: string, kind: string, payload: Record<string, unknown> | null, createdAt: string): Activity => ({
    id: actId++,
    nodeId,
    actor,
    kind,
    payload: { ...(payload ?? {}), projectId },
    createdAt,
  });
  const p1activity: Activity[] = [
    act(P1, 'p1_root', 'user', 'node_created', { title: '官网改版', parentId: null, project: true }, at(31)),
    act(P1, API_NODE, 'user', 'dependency_added', { fromNode: 'p1_fe', toNode: API_NODE }, at(12, 10)),
    act(P1, 'p1_visual', 'user', 'field_changed', { title: '视觉稿', fields: { status: { from: 'in_progress', to: 'done' } } }, at(22, 17)),
    act(P1, 'p1_proto', 'user', 'field_changed', { title: '交互原型', fields: { status: { from: 'in_progress', to: 'done' } } }, at(18, 16)),
    act(P1, API_NODE, 'claude', 'field_changed', { title: '接口联调', fields: { status: { from: 'in_progress', to: 'blocked' }, progress: { from: 0, to: 10 } } }, at(2, 11)),
    act(P1, 'p1_fe', 'user', 'field_changed', { title: '前端页面', fields: { progress: { from: 40, to: 60 } } }, at(1, 15)),
    act(P1, API_NODE, 'claude', 'change_proposed', { changeId: change.id, field: 'dueDate', from: change.oldValue, to: change.newValue, title: '接口联调' }, change.createdAt),
  ];

  // ---- Q4 产品规划 ----
  const n2 = mk(P2, at(12));
  const r2 = rankSeq();
  const p2nodes: TNode[] = [
    n2({ id: 'p2_root', parentId: null, rank: r2(), title: 'Q4 产品规划', kind: 'goal' }),
    n2({ id: 'p2_research', parentId: 'p2_root', rank: r2(), title: '用户调研', ownerId: CONTACT_WANG, startDate: d(-10), dueDate: d(-3), status: 'done', progress: 100, estimateHours: 20 }),
    n2({ id: 'p2_comp', parentId: 'p2_root', rank: r2(), title: '竞品分析', startDate: d(-7), dueDate: d(-1), status: 'in_progress', progress: 50, estimateHours: 12 }),
    n2({ id: 'p2_prio', parentId: 'p2_root', rank: r2(), title: '需求优先级排序', ownerId: CONTACT_LIN, startDate: d(0), dueDate: d(5), estimateHours: 6 }),
    n2({ id: 'p2_review', parentId: 'p2_root', rank: r2(), title: '路线图评审', kind: 'milestone', dueDate: d(14), priority: 2 }),
  ];
  const p2activity: Activity[] = [
    act(P2, 'p2_root', 'user', 'node_created', { title: 'Q4 产品规划', parentId: null, project: true }, at(12)),
    act(P2, 'p2_research', 'user', 'field_changed', { title: '用户调研', fields: { status: { from: 'in_progress', to: 'done' } } }, at(3, 18)),
    act(P2, 'p2_comp', 'claude', 'field_changed', { title: '竞品分析', fields: { progress: { from: 30, to: 50 } } }, at(1, 9)),
  ];

  // Claude's draft plan for Q4: 3 new nodes under the root (diff computed with the real planner).
  const p2store = new TreeStore(p2nodes);
  const outline = [`- 定价方案 @林 ${d(6)}–${d(12)}`, `- 渠道合作洽谈 @王芳 ${d(8)}–${d(20)}`, `- 发布计划 ${d(15)}–${d(25)}`].join('\n');
  const plan = planOps(p2store, parseOutline(outline, { year: Number(today.slice(0, 4)) }), {
    projectId: P2,
    parentId: 'p2_root',
    mode: 'append',
    contacts,
    newId: () => `p2_new_${Math.random().toString(36).slice(2, 8)}`,
    opBase: { clientId: 'claude', actor: 'claude', at: hoursAgo(5) },
  });
  const batch: PlanBatch = {
    id: 'pb_demo_1',
    projectId: P2,
    parentId: 'p2_root',
    mode: 'append',
    outline,
    diff: { ops: plan.ops, summary: plan.summary, created: plan.created, errors: plan.errors },
    status: 'draft',
  };

  const sessions: AssistantSession[] = [{ id: 's_demo_1', title: '接口联调卡在哪', projectId: P1, createdAt: hoursAgo(26), updatedAt: hoursAgo(25) }];
  const messages = new Map<string, AssistantMessage[]>();
  messages.set('s_demo_1', [
    { id: 'm_demo_1', role: 'user', text: '接口联调现在卡在哪？', createdAt: hoursAgo(26) },
    {
      id: 'm_demo_2',
      role: 'assistant',
      text: '（演示回答）**接口联调**目前 10%，状态受阻：它的前置任务**前端页面**还在做（60%），后端 v2 接口也要晚几天才出。\n\n- 建议把截止日顺延几天\n- 顺手提醒一下陈小明同步进展',
      toolCalls: [{ name: 'get_node', input: { nodeId: API_NODE }, resultText: JSON.stringify({ id: API_NODE, title: '接口联调', status: 'blocked', progress: 10, dueDate: d(-5), dependsOn: ['前端页面'] }, null, 2) }],
      createdAt: hoursAgo(25),
    },
  ]);

  return {
    account,
    tokens,
    contacts,
    projects: [
      { project: { id: P1, name: '官网改版', rootNodeId: 'p1_root', createdAt: at(31), archivedAt: null }, nodes: p1nodes, deps: p1deps, activity: p1activity },
      { project: { id: P2, name: 'Q4 产品规划', rootNodeId: 'p2_root', createdAt: at(12), archivedAt: null }, nodes: p2nodes, deps: [], activity: p2activity },
    ],
    changes: [change],
    batches: [batch],
    sessions,
    messages,
  };
}
