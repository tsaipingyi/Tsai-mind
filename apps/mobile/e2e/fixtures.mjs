// API fixtures for the Playwright smoke run: project 官网改版 with 8 nodes, one pending change, one overdue node.
const NOW = '2026-09-01T08:00:00.000Z';
export const PROJECT_ID = 'p1';

export const contacts = [
  { id: 'c_lin', name: '林', company: '设计工作室', email: null, phone: null, notes: null, archivedAt: null },
  { id: 'c_wang', name: '王芳', company: null, email: 'wang@example.com', phone: null, notes: null, archivedAt: null },
  { id: 'c_chen', name: '陈小明', company: '外包', email: null, phone: '138', notes: null, archivedAt: null },
];

function n(partial) {
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

export const nodes = [
  n({ id: 'root', parentId: null, rank: 'V', title: '官网改版', kind: 'goal' }),
  n({ id: 'design', parentId: 'root', rank: 'V', title: '设计', ownerId: 'c_lin' }),
  n({ id: 'visual', parentId: 'design', rank: 'V', title: '视觉稿', ownerId: 'c_lin', startDate: '2026-09-01', dueDate: '2026-09-08', status: 'done', progress: 100 }),
  n({ id: 'proto', parentId: 'design', rank: 'k', title: '交互原型', ownerId: 'c_lin', startDate: '2026-09-05', dueDate: '2026-09-12', status: 'done', progress: 100 }),
  n({ id: 'dev', parentId: 'root', rank: 'k', title: '开发', ownerId: 'c_wang' }),
  n({ id: 'fe', parentId: 'dev', rank: 'V', title: '前端页面', ownerId: 'c_wang', startDate: '2026-09-08', dueDate: '2026-09-24', status: 'in_progress', progress: 60, estimateHours: 40 }),
  n({ id: 'api', parentId: 'dev', rank: 'k', title: '接口联调', ownerId: 'c_chen', startDate: '2026-09-15', dueDate: '2026-08-30', status: 'blocked', progress: 10, estimateHours: 24, lastNudgedAt: '2026-08-29T02:00:00.000Z' }),
  n({ id: 'launch', parentId: 'root', rank: 's', title: '上线', kind: 'milestone', dueDate: '2026-10-10' }),
];

export const project = { id: PROJECT_ID, name: '官网改版', rootNodeId: 'root', createdAt: NOW, archivedAt: null };

export const pendingChanges = [
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

const apiEntry = {
  node: nodes[6],
  derived: { progress: 10, startDate: '2026-09-15', dueDate: '2026-08-30', status: 'blocked', hasChildren: false, leafCount: 1, doneLeafCount: 0 },
  path: ['官网改版', '开发'],
  projectId: PROJECT_ID,
  projectName: '官网改版',
  daysOverdue: 4,
};
const feEntry = {
  node: nodes[5],
  derived: { progress: 60, startDate: '2026-09-08', dueDate: '2026-09-24', status: 'in_progress', hasChildren: false, leafCount: 1, doneLeafCount: 0 },
  path: ['官网改版', '开发'],
  projectId: PROJECT_ID,
  projectName: '官网改版',
  daysOverdue: -21,
};

export const todayResponse = {
  today: '2026-09-03',
  overdue: [apiEntry],
  dueToday: [],
  dueTomorrow: [feEntry],
  nudgeDue: [apiEntry],
  pending: pendingChanges.map((c) => ({ ...c, nodeTitle: '接口联调', projectId: PROJECT_ID, projectName: '官网改版' })),
};

export const nodeDetail = {
  node: nodes[6],
  derived: apiEntry.derived,
  path: ['官网改版', '开发'],
  projectId: PROJECT_ID,
  projectName: '官网改版',
  children: [],
  dependsOn: [{ id: 'fe', title: '前端页面' }],
  blocks: [],
  notes: [],
  activity: [
    { id: 1, nodeId: 'api', actor: 'claude', kind: 'change_proposed', payload: { field: 'dueDate', to: '2026-10-05' }, createdAt: '2026-09-01T08:00:00.000Z' },
    { id: 2, nodeId: 'api', actor: 'user', kind: 'nudged', payload: {}, createdAt: '2026-08-29T02:00:00.000Z' },
    { id: 3, nodeId: 'api', actor: 'user', kind: 'field_changed', payload: { fields: { status: { from: 'in_progress', to: 'blocked' } } }, createdAt: '2026-08-27T09:00:00.000Z' },
  ],
  pendingChanges,
};

export const draftBatch = {
  id: 'b1',
  projectId: PROJECT_ID,
  parentId: 'dev',
  mode: 'append',
  outline: '- 性能优化\n- 无障碍检查',
  diff: {
    ops: [],
    summary: { create: 2, update: 0, move: 0, delete: 0 },
    created: [
      { lineNo: 1, id: 'new1', title: '性能优化' },
      { lineNo: 2, id: 'new2', title: '无障碍检查' },
    ],
    errors: [],
  },
  status: 'draft',
};
