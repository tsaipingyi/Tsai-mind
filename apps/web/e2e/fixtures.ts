import type { Change, Contact, Project, TNode } from '@tsai-mind/core';

const NOW = '2026-09-01T08:00:00.000Z';
export const PROJECT_ID = 'p1';

export const contacts: Contact[] = [
  { id: 'c_lin', name: '林', company: '设计工作室', email: null, phone: null, notes: null, archivedAt: null },
  { id: 'c_wang', name: '王芳', company: null, email: 'wang@example.com', phone: null, notes: null, archivedAt: null },
  { id: 'c_chen', name: '陈小明', company: '外包', email: null, phone: '138', notes: null, archivedAt: null },
];

function n(partial: Partial<TNode> & Pick<TNode, 'id' | 'parentId' | 'rank' | 'title'>): TNode {
  return {
    projectId: PROJECT_ID,
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
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...partial,
  };
}

export const nodes: TNode[] = [
  n({ id: 'root', parentId: null, rank: 'V', title: '官网改版', kind: 'goal' }),
  n({ id: 'design', parentId: 'root', rank: 'V', title: '设计', ownerId: 'c_lin' }),
  n({ id: 'visual', parentId: 'design', rank: 'V', title: '视觉稿', ownerId: 'c_lin', startDate: '2026-09-01', dueDate: '2026-09-08', status: 'done', progress: 100 }),
  n({ id: 'proto', parentId: 'design', rank: 'k', title: '交互原型', ownerId: 'c_lin', startDate: '2026-09-05', dueDate: '2026-09-12', status: 'done', progress: 100 }),
  n({ id: 'dev', parentId: 'root', rank: 'k', title: '开发', ownerId: 'c_wang' }),
  n({ id: 'fe', parentId: 'dev', rank: 'V', title: '前端页面', ownerId: 'c_wang', startDate: '2026-09-08', dueDate: '2026-09-24', status: 'in_progress', progress: 60, estimateHours: 40 }),
  n({ id: 'api', parentId: 'dev', rank: 'k', title: '接口联调', ownerId: 'c_chen', startDate: '2026-09-15', dueDate: '2026-08-30', status: 'blocked', progress: 10, estimateHours: 24 }),
  n({ id: 'launch', parentId: 'root', rank: 's', title: '上线', kind: 'milestone', dueDate: '2026-10-10' }),
];

export const project: Project = { id: PROJECT_ID, name: '官网改版', rootNodeId: 'root', createdAt: NOW, archivedAt: null };

export const pendingChanges: Change[] = [
  {
    id: 'ch1',
    nodeId: 'api',
    field: 'dueDate',
    oldValue: '2026-08-30',
    newValue: '2026-10-05',
    reason: '前端页面还没完成，接口联调顺延',
    source: 'claude',
    batchId: null,
    status: 'pending',
    decidedAt: null,
    createdAt: NOW,
    expiresAt: '2026-09-08T08:00:00.000Z',
  },
];

export const me = {
  account: { id: 'u1', email: 'tsai@example.com', name: '蔡', timezone: 'Asia/Shanghai', settings: {} },
  scopes: ['read', 'write', 'decide'],
};

export const projectDetail = { project, nodes, contacts, pendingChanges, dependencies: [{ fromNode: 'fe', toNode: 'api' }], serverSeq: 42 };

export const projectRows = [{ ...project, overdueCount: 1, pendingCount: 1 }];

export const todayResponse = {
  today: '2026-09-03',
  overdue: [
      { node: nodes[6], derived: { progress: 10, startDate: '2026-09-15', dueDate: '2026-08-30', status: 'blocked', hasChildren: false, leafCount: 1, doneLeafCount: 0 }, path: ['官网改版', '开发'], projectId: PROJECT_ID, projectName: '官网改版', daysOverdue: 4 },
    ],
  dueToday: [],
  dueTomorrow: [],
  nudgeDue: [
    { node: nodes[6], derived: { progress: 10, startDate: '2026-09-15', dueDate: '2026-08-30', status: 'blocked', hasChildren: false, leafCount: 1, doneLeafCount: 0 }, path: ['官网改版', '开发'], projectId: PROJECT_ID, projectName: '官网改版', daysOverdue: 4 },
  ],
  pending: pendingChanges.map((c) => ({ ...c, nodeTitle: '接口联调', projectId: PROJECT_ID, projectName: '官网改版' })),
};

export const outlineText = `- 官网改版 [root] 9/1–10/10
  - 设计 [design] @林 9/1–9/12 done
    - 视觉稿 [visual] @林 9/1–9/8 done
    - 交互原型 [proto] @林 9/5–9/12 done
  - 开发 [dev] @王芳 9/8–9/30 blocked 41%
    - 前端页面 [fe] @王芳 9/8–9/24 in_progress 60%
    - 接口联调 [api] @陈小明 9/15–8/30 blocked 10% ← 前端页面
  - ◆ 上线 [launch] 10/10`;
