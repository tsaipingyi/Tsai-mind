// API fixtures for the Playwright smoke run: project 官网改版 with an overdue task, two due today, one tomorrow,
// two later this week, a dependency slip, one pending change, one draft batch, two assistant sessions.
// Dates are relative to the real day so 今天's lists (computed against `new Date()`) stay stable.
export const PROJECT_ID = 'p1';

const pad = (n) => String(n).padStart(2, '0');
/** ISO date `days` from today (local time, like the app's `today()`). */
export function iso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** "9/4" like core `shortDate` for the current year. */
export function short(days) {
  const [, m, d] = iso(days).split('-').map(Number);
  return `${m}/${d}`;
}
const at = (days, hour = 8) => `${iso(days)}T${pad(hour)}:00:00.000Z`;
const NOW = at(-3);

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
  n({ id: 'visual', parentId: 'design', rank: 'V', title: '视觉稿', ownerId: 'c_lin', startDate: iso(-10), dueDate: iso(-3), status: 'done', progress: 100 }),
  n({ id: 'proto', parentId: 'design', rank: 'k', title: '交互原型', ownerId: 'c_lin', startDate: iso(-6), dueDate: iso(2), status: 'done', progress: 100 }),
  n({ id: 'review', parentId: 'design', rank: 's', title: '视觉稿复审', startDate: iso(-1), dueDate: iso(0), priority: 2 }),
  n({ id: 'dev', parentId: 'root', rank: 'k', title: '开发', ownerId: 'c_wang' }),
  n({ id: 'fe', parentId: 'dev', rank: 'V', title: '前端页面', ownerId: 'c_wang', startDate: iso(-15), dueDate: iso(1), status: 'in_progress', progress: 60, estimateHours: 40 }),
  n({ id: 'api', parentId: 'dev', rank: 'k', title: '接口联调', ownerId: 'c_chen', startDate: iso(-8), dueDate: iso(-4), status: 'blocked', progress: 10, estimateHours: 24, lastNudgedAt: at(-3, 2) }),
  n({ id: 'track', parentId: 'dev', rank: 's', title: '埋点接入', ownerId: 'c_wang', startDate: iso(-2), dueDate: iso(0), status: 'in_progress', progress: 30, priority: 1 }),
  n({ id: 'seo', parentId: 'dev', rank: 'w', title: 'SEO 检查', ownerId: 'c_wang', startDate: iso(1), dueDate: iso(3) }),
  n({ id: 'copy', parentId: 'dev', rank: 'y', title: '文案校对', startDate: iso(2), dueDate: iso(5) }),
  n({ id: 'launch', parentId: 'root', rank: 's', title: '上线', kind: 'milestone', dueDate: iso(36) }),
];

export const project = { id: PROJECT_ID, name: '官网改版', rootNodeId: 'root', createdAt: NOW, archivedAt: null };

export const pendingChanges = [
  {
    id: 'ch1',
    nodeId: 'api',
    field: 'dueDate',
    oldValue: iso(-4),
    newValue: iso(5),
    reason: '前端页面还没完成，接口联调顺延',
    source: 'claude',
    batchId: null,
    status: 'pending',
    decidedAt: null,
    createdAt: NOW,
    expiresAt: at(4),
  },
];

export const me = {
  account: {
    id: 'u1',
    email: 'tsai@example.com',
    name: '蔡',
    timezone: 'Asia/Shanghai',
    settings: { notifications: { dueSoon: true, overdue: true, nudgeDue: false, digest: true }, nudgeTemplate: '' },
  },
  scopes: ['read', 'write', 'decide'],
};

// phase-3 server: critical path and a dependency slip (fe due tomorrow > api start 8 days ago → 9 days)
export const criticalPath = ['root', 'launch'];
export const slips = [{ fromNode: 'fe', toNode: 'api', fromDue: iso(1), toStart: iso(-8), days: 9 }];

export const projectDetail = { project, nodes, contacts, pendingChanges, dependencies: [{ fromNode: 'fe', toNode: 'api' }], serverSeq: 42, criticalPath, slips };
export const projectRows = [{ ...project, overdueCount: 1, pendingCount: 1 }];

const byId = Object.fromEntries(nodes.map((x) => [x.id, x]));
const entry = (id, path, extra = {}) => {
  const node = byId[id];
  const days = Math.round((new Date(iso(0)) - new Date(node.dueDate)) / 86400000);
  return {
    node,
    derived: { progress: node.progress, startDate: node.startDate, dueDate: node.dueDate, status: node.status, hasChildren: false, leafCount: 1, doneLeafCount: 0, ...extra },
    path,
    projectId: PROJECT_ID,
    projectName: '官网改版',
    daysOverdue: days,
  };
};
const apiEntry = entry('api', ['官网改版', '开发']);

export const todayResponse = {
  today: iso(0),
  overdue: [apiEntry],
  dueToday: [entry('track', ['官网改版', '开发']), entry('review', ['官网改版', '设计'])],
  dueTomorrow: [entry('fe', ['官网改版', '开发'])],
  nudgeDue: [apiEntry],
  pending: pendingChanges.map((c) => ({ ...c, nodeTitle: '接口联调', projectId: PROJECT_ID, projectName: '官网改版' })),
};

export const nodeDetail = {
  node: byId.api,
  derived: apiEntry.derived,
  path: ['官网改版', '开发'],
  projectId: PROJECT_ID,
  projectName: '官网改版',
  children: [],
  dependsOn: [{ id: 'fe', title: '前端页面' }],
  blocks: [],
  notes: [],
  activity: [
    { id: 1, nodeId: 'api', actor: 'claude', kind: 'change_proposed', payload: { field: 'dueDate', to: iso(5) }, createdAt: at(-1) },
    { id: 2, nodeId: 'api', actor: 'user', kind: 'nudged', payload: {}, createdAt: at(-3, 2) },
    { id: 3, nodeId: 'api', actor: 'user', kind: 'field_changed', payload: { fields: { status: { from: 'in_progress', to: 'blocked' } } }, createdAt: at(-5) },
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

// ---- in-app assistant ----
export const assistantStatus = { configured: true, model: 'claude-opus-5' };

export const sessions = [
  { id: 's1', title: '接口联调怎么办', projectId: PROJECT_ID, lastText: `我已经提议把「接口联调」的截止日推到 ${short(5)}，等你确认。`, createdAt: at(-2, 2), updatedAt: at(-1, 1) },
  { id: 's2', title: null, projectId: null, lastText: '这周有 1 个逾期任务：接口联调（陈小明）。', createdAt: at(-3, 0), updatedAt: at(-3, 0) },
];

export const sessionDetail = {
  session: sessions[0],
  messages: [
    { id: 'm1', role: 'user', text: '接口联调已经逾期了，怎么办？', toolCalls: [], createdAt: at(-1, 1) },
    {
      id: 'm2',
      role: 'assistant',
      text: `「接口联调」原定 ${short(-4)}，负责人陈小明，前置任务「前端页面」要到 ${short(1)} 才完成，所以这个截止日本来就不现实。我建议推到 ${short(5)}，并催一下陈小明。`,
      toolCalls: [{ name: 'get_node', input: { node_id: 'api' }, resultText: `{"id":"api","title":"接口联调","status":"blocked","dueDate":"${iso(-4)}"}` }],
      createdAt: at(-1, 1),
    },
  ],
};

/** Streamed reply to the next user message: two text deltas, a tool call that lands in 待确认, a closing delta, done. */
export const sseReply = [
  'event: text',
  'data: {"delta":"好，我把「接口联调」的截止日"}',
  '',
  'event: text',
  `data: {"delta":"改成 ${short(5)}。"}`,
  '',
  'event: tool',
  `data: {"name":"update_node","input":{"node_id":"api","version":1,"patch":{"dueDate":"${iso(5)}"},"reason":"前端页面 ${short(1)} 才完成"},"result":{"status":"pending","change_id":"ch2"}}`,
  '',
  'event: text',
  'data: {"delta":"这是关键字段，已经进了「待确认」，你确认后生效。"}',
  '',
  'event: done',
  `data: {"messageId":"m4","text":"好，我把「接口联调」的截止日改成 ${short(5)}。这是关键字段，已经进了「待确认」，你确认后生效。"}`,
  '',
  '',
].join('\n');
