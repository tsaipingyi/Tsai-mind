import { expect, test, type Page, type Route } from '@playwright/test';
import type { Op, TNode } from '@tsai-mind/core';
import * as fx from './fixtures';

const TOKEN = 'tm_test_token';

interface Recorded {
  posted: Op[];
  undone: number[];
  deps: { method: string; body: Record<string, unknown> }[];
  mePatches: Record<string, unknown>[];
  projectGets: number;
  opsGets: number;
  chatPosts: Record<string, unknown>[];
  /** `${changeId}:${decision}` for POST /api/changes/:id/(approve|reject) */
  decisions: string[];
}

function recorder(): Recorded {
  return { posted: [], undone: [], deps: [], mePatches: [], projectGets: 0, opsGets: 0, chatPosts: [], decisions: [] };
}

async function mockApi(page: Page, posted: Op[], undone: number[], rec: Recorded = recorder(), opts: { extraNodes?: TNode[] } = {}) {
  let seq = fx.projectDetail.serverSeq;
  const addedDeps: { fromNode: string; toNode: string }[] = [];
  const sessions: (typeof fx.assistantSession)[] = [];
  await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const auth = req.headers()['authorization'];
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (auth !== `Bearer ${TOKEN}`) return json({ error: 'unauthorized', message: 'bad token' }, 401);

    if (path === '/api/me' && method === 'GET') return json(fx.me);
    if (path === '/api/me' && method === 'PATCH') {
      const body = req.postDataJSON() as Record<string, unknown>;
      rec.mePatches.push(body);
      return json({ account: { ...fx.me.account, ...body } });
    }
    if (path === '/api/tokens') return json(fx.tokens);
    if (path === '/api/dependencies') {
      const body = req.postDataJSON() as Record<string, unknown>;
      rec.deps.push({ method, body });
      const from = String(body.fromNode ?? body.fromNodeId);
      const to = String(body.toNode ?? body.toNodeId);
      if (method === 'POST') {
        addedDeps.push({ fromNode: from, toNode: to });
        return json({ fromNode: from, toNode: to }, 201);
      }
      const i = addedDeps.findIndex((d) => d.fromNode === from && d.toNode === to);
      if (i >= 0) addedDeps.splice(i, 1);
      return json({ removed: true });
    }
    if (path === '/api/assistant/status') return json(fx.assistantStatus);
    if (path === '/api/assistant/sessions' && method === 'GET') return json(sessions);
    if (path === '/api/assistant/sessions' && method === 'POST') {
      const s = { ...fx.assistantSession, id: `s${sessions.length + 1}` };
      sessions.unshift(s);
      return json({ session: s }, 201);
    }
    if (/^\/api\/assistant\/sessions\/[^/]+$/.test(path) && method === 'GET') {
      const id = path.split('/')[4]!;
      return json({ session: sessions.find((x) => x.id === id) ?? { ...fx.assistantSession, id }, messages: [] });
    }
    if (/^\/api\/assistant\/sessions\/[^/]+\/messages$/.test(path) && method === 'POST') {
      rec.chatPosts.push(req.postDataJSON() as Record<string, unknown>);
      const sid = path.split('/')[4]!;
      const s = sessions.find((x) => x.id === sid);
      if (s) s.title = '改接口联调进度';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: fx.assistantStream });
    }
    if (path === '/api/projects' && method === 'GET') return json(fx.projectRows);
    if (path === `/api/projects/${fx.PROJECT_ID}` && method === 'GET') {
      rec.projectGets++;
      return json({ ...fx.projectDetail, nodes: [...fx.projectDetail.nodes, ...(opts.extraNodes ?? [])], dependencies: [...fx.projectDetail.dependencies, ...addedDeps] });
    }
    if (path === `/api/projects/${fx.PROJECT_ID}/activity`) {
      return json([
        { id: 1, projectId: fx.PROJECT_ID, nodeId: 'api', actor: 'claude', kind: 'field_changed', payload: { title: '接口联调', fields: { progress: { from: 0, to: 10 } } }, createdAt: '2026-09-02T09:00:00.000Z' },
        { id: 2, projectId: fx.PROJECT_ID, nodeId: 'fe', actor: 'user', kind: 'field_changed', payload: { title: '前端页面', fields: { status: { from: 'todo', to: 'in_progress' } } }, createdAt: '2026-09-02T10:00:00.000Z' },
      ]);
    }
    if (path === `/api/projects/${fx.PROJECT_ID}/outline`) return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: fx.outlineText });
    if (path === `/api/projects/${fx.PROJECT_ID}/ops` && method === 'GET') {
      rec.opsGets++;
      return json([]);
    }
    if (path === `/api/projects/${fx.PROJECT_ID}/plan-batches`) return json([]);
    if (path === `/api/projects/${fx.PROJECT_ID}/ops` && method === 'POST') {
      const body = req.postDataJSON() as { ops: Op[] };
      posted.push(...body.ops);
      const results = body.ops.map((op) => ({ opId: op.opId, ok: true, serverSeq: ++seq }));
      return json({ results, serverSeq: seq });
    }
    if (path === '/api/today') return json(fx.todayResponse);
    if (path === '/api/contacts') return json(fx.contacts);
    if (path === '/api/changes') return json(fx.todayResponse.pending);
    if (/^\/api\/changes\/[^/]+\/(approve|reject)$/.test(path) && method === 'POST') {
      const [, , , id, decision] = path.split('/');
      rec.decisions.push(`${id}:${decision}`);
      return json({ ok: true });
    }
    if (/^\/api\/ops\/\d+\/undo$/.test(path) && method === 'POST') {
      undone.push(Number(path.split('/')[3]));
      return json({ results: [] });
    }
    if (path.startsWith('/api/nodes/') && path.endsWith('/nudge')) {
      const id = path.split('/')[3]!;
      const node = fx.nodes.find((n) => n.id === id)!;
      return json({ text: `小明，关于「${node.title}」，原定 8/30，现在进度 10%，方便同步一下进展吗？`, node: { ...node, lastNudgedAt: new Date().toISOString() } });
    }
    return json({ error: 'not_found', message: `no mock for ${method} ${path}` }, 404);
  });
}

test('login, open project, mind map renders, Tab creates a child node', async ({ page }) => {
  const posted: Op[] = [];
  const undone: number[] = [];
  await mockApi(page, posted, undone);

  await page.goto('/login');
  await page.getByLabel('访问令牌').fill(TOKEN);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  // today page sections
  await expect(page.getByText('逾期 4 天').first()).toBeVisible();
  await expect(page.getByText('截止日 8/30 → 10/5').first()).toBeVisible();

  await page.goto(`/projects/${fx.PROJECT_ID}`);
  const boxes = page.locator('.mm-node');
  await expect(boxes).toHaveCount(8);
  await expect(page.locator('.mm-node.root')).toContainText('官网改版');
  await expect(page.locator('.mm-node[data-node-id="api"]')).toHaveClass(/blocked/);
  await expect(page.locator('.mm-node[data-node-id="api"] .dot-pending')).toBeVisible();
  await expect(page.locator('.mm-node[data-node-id="visual"]')).toHaveClass(/done/);
  await expect(page.locator('.mm-node[data-node-id="launch"]')).toHaveClass(/milestone/);
  await expect(page.locator('.mm-node[data-node-id="api"] .d')).toHaveClass(/overdue/);
  // critical path root → 上线 gets the thicker connector; slip badge in the top bar
  await expect(page.locator('.mindmap svg.links path.critical')).toHaveCount(1);
  await expect(page.getByTestId('slip-badge')).toHaveText('1 处延误');
  // parent rollup: 开发 = (60*40 + 10*24) / 64 = 41%
  await expect(page.locator('.mm-node[data-node-id="dev"] .p')).toContainText('41%');

  // select 前端页面, press Tab -> create_node posted
  await page.locator('.mm-node[data-node-id="fe"]').click();
  await expect(page.locator('.mm-node[data-node-id="fe"]')).toHaveClass(/selected/);
  await expect(page.getByTestId('sidebar').getByLabel('标题')).toHaveValue('前端页面');
  await expect(page.getByTestId('sidebar')).toContainText('状态 → 进行中');
  await page.keyboard.press('Tab');
  await expect(boxes).toHaveCount(9);
  await page.keyboard.type('埋点接入');
  await page.keyboard.press('Enter');
  await expect.poll(() => posted.filter((o) => o.type === 'create_node').length).toBe(1);
  const create = posted.find((o) => o.type === 'create_node')!;
  expect(create.type === 'create_node' && create.node.parentId).toBe('fe');
  expect(create.type === 'create_node' && create.node.ownerId).toBe('c_wang');
  expect(create.actor).toBe('user');
  expect(create.opId).toMatch(/^[0-9a-f-]{36}$/);
  await expect.poll(() => posted.filter((o) => o.type === 'update_node').length).toBe(1);
  const upd = posted.find((o) => o.type === 'update_node')!;
  expect(upd.type === 'update_node' && upd.patch.title).toBe('埋点接入');

  // pending panel
  await page.getByTestId('pending-toggle').click();
  await expect(page.getByTestId('pending-panel')).toContainText('接口联调');
  await expect(page.getByTestId('pending-panel')).toContainText('截止日 8/30 → 10/5');
  await page.getByTestId('pending-panel').getByRole('button', { name: '关闭' }).click();

  // @ owner picker on 上线
  await page.locator('.mm-node[data-node-id="launch"]').click();
  await page.keyboard.press('@');
  await expect(page.getByRole('dialog', { name: '负责人' })).toBeVisible();
  await page.keyboard.type('陈');
  await page.keyboard.press('Enter');
  await expect.poll(() => posted.filter((o) => o.type === 'update_node' && o.patch.ownerId === 'c_chen').length).toBe(1);
  await expect(page.locator('.mm-node[data-node-id="launch"] .avatar')).toHaveText('陈');

  // / command palette -> 状态 -> 进行中
  await page.keyboard.press('/');
  await expect(page.getByRole('dialog', { name: '命令' })).toBeVisible();
  await page.keyboard.type('状态');
  await page.keyboard.press('Enter');
  await page.keyboard.type('进行中');
  await page.keyboard.press('Enter');
  await expect.poll(() => posted.filter((o) => o.type === 'update_node' && o.patch.status === 'in_progress').length).toBe(1);
  await expect(page.locator('.mm-node[data-node-id="launch"]')).toHaveAttribute('data-status', 'in_progress');

  // drag 上线 onto 设计 -> move_node
  const from = await page.locator('.mm-node[data-node-id="launch"]').boundingBox();
  const to = await page.locator('.mm-node[data-node-id="design"]').boundingBox();
  await page.mouse.move(from!.x + 40, from!.y + 20);
  await page.mouse.down();
  await page.mouse.move(from!.x + 60, from!.y + 30, { steps: 3 });
  await page.mouse.move(to!.x + 60, to!.y + 26, { steps: 8 });
  await expect(page.locator('.mm-node[data-node-id="design"]')).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect.poll(() => posted.filter((o) => o.type === 'move_node').length).toBe(1);
  const mv = posted.find((o) => o.type === 'move_node')!;
  expect(mv.type === 'move_node' && mv.parentId).toBe('design');
  await expect(page.locator('.mm-node[data-node-id="design"] .toggle')).toHaveText('−');

  // undo the move -> POST /api/ops/:seq/undo with the acked serverSeq
  await page.keyboard.press('Control+z');
  await expect.poll(() => undone.length).toBe(1);
  expect(undone[0]).toBeGreaterThan(fx.projectDetail.serverSeq);
  await expect(page.getByText('已撤销')).toBeVisible();

  // select 接口联调 so the branch highlight is visible, fit and screenshot
  await expect(boxes).toHaveCount(8); // reload after undo returns the fixture
  await page.locator('.mm-node[data-node-id="api"]').click();
  await expect(page.getByTestId('sidebar').locator('.via')).toHaveText('经 Claude');
  await page.getByTitle('适应窗口').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/out/mindmap.png' });

  // outline view renders rows and supports keyboard sibling creation
  await page.getByRole('tab', { name: '大纲' }).click();
  await expect(page.locator('.ol-row')).toHaveCount(8);
  await expect(page.locator('.ol-row.selected')).toContainText('接口联调');
  await page.keyboard.press('Enter');
  await expect(page.locator('.ol-row')).toHaveCount(9);
  await page.keyboard.type('埋点接入');
  await page.keyboard.press('Enter');
  await expect.poll(() => posted.filter((o) => o.type === 'create_node').length).toBe(2);
  // Escape on a fresh empty node removes it again
  await page.keyboard.press('Enter');
  await expect(page.locator('.ol-row')).toHaveCount(10);
  await page.keyboard.press('Escape');
  await expect(page.locator('.ol-row')).toHaveCount(9);
  await expect.poll(() => posted.filter((o) => o.type === 'delete_node').length).toBe(1);
  await page.screenshot({ path: 'e2e/out/outline.png' });

  // other pages render
  await page.goto('/');
  await page.screenshot({ path: 'e2e/out/today.png' });
  await page.goto('/contacts');
  await expect(page.getByText('陈小明')).toBeVisible();
  await page.goto('/projects');
  await expect(page.getByRole('cell', { name: /官网改版/ })).toBeVisible();
  await expect(page.locator('.projects-table .slip-badge')).toHaveText('1 处延误');
  await page.screenshot({ path: 'e2e/out/projects.png' });
});

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('访问令牌').fill(TOKEN);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test('gantt: bars, dependencies, drag changes dates; sidebar dependency editing', async ({ page }) => {
  const rec = recorder();
  await mockApi(page, rec.posted, rec.undone, rec);
  await login(page);
  await page.goto(`/projects/${fx.PROJECT_ID}`);
  await expect(page.locator('.mm-node')).toHaveCount(8);

  await page.getByRole('tab', { name: '甘特' }).click();
  const gantt = page.getByTestId('gantt');
  await expect(gantt).toBeVisible();
  await expect(gantt.locator('.gantt-row')).toHaveCount(8);
  await expect(gantt.locator('.gantt-bar')).toHaveCount(8);
  // parents are thin, leaves solid, milestone a diamond, critical path outlined
  await expect(gantt.locator('.gantt-bar[data-node-id="launch"] path')).toHaveCount(1);
  await expect(gantt.locator('.gantt-bar.critical')).toHaveCount(2);
  // fe → api is a slipped dependency (fe due 9/24 after api start 9/15)
  await expect(gantt.locator('.gantt-dep.slipped')).toHaveCount(1);
  await expect(gantt.locator('.gantt-dep.slipped title')).toContainText('延误 9 天');
  // the selected row follows the global selection
  await expect(gantt.locator('.gantt-row.selected')).toContainText('官网改版');
  await gantt.locator('.gantt-row[data-node-id="fe"]').click();
  await expect(gantt.locator('.gantt-row.selected')).toContainText('前端页面');
  await expect(page.getByTestId('sidebar').getByLabel('标题')).toHaveValue('前端页面');

  // drag the 前端页面 bar two days (week zoom: 16px per day) to the right → one update_node with both dates
  const bar = gantt.locator('.gantt-bar[data-node-id="fe"] rect').first();
  const bb = (await bar.boundingBox())!;
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2 + 10, bb.y + bb.height / 2, { steps: 3 });
  await page.mouse.move(bb.x + bb.width / 2 + 32, bb.y + bb.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => rec.posted.filter((o) => o.type === 'update_node').length).toBe(1);
  const moved = rec.posted.find((o) => o.type === 'update_node')!;
  expect(moved.type === 'update_node' && moved.patch).toEqual({ startDate: '2026-09-10', dueDate: '2026-09-26' });
  await expect(page.getByTestId('sidebar').locator('input[type="date"]').nth(1)).toHaveValue('2026-09-26');

  // drag the right end of 前端页面 one more day → only dueDate changes
  const feEnd = gantt.locator('.gantt-bar[data-node-id="fe"] .gantt-handle.end');
  const hb = (await feEnd.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 8, hb.y + hb.height / 2, { steps: 2 });
  await page.mouse.move(hb.x + hb.width / 2 + 16, hb.y + hb.height / 2, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => rec.posted.filter((o) => o.type === 'update_node').length).toBe(2);
  const resized = rec.posted.filter((o) => o.type === 'update_node')[1]!;
  expect(resized.type === 'update_node' && resized.patch).toEqual({ dueDate: '2026-09-27' });

  // zoom to 日
  await page.getByRole('tab', { name: '日' }).click();
  await expect(gantt.locator('.gantt-bar')).toHaveCount(8);
  await page.getByRole('tab', { name: '周' }).click();

  // sidebar dependencies for 接口联调: predecessor 前端页面, waiting, add 视觉稿 as predecessor
  await gantt.locator('.gantt-row[data-node-id="api"]').click();
  const deps = page.getByTestId('deps');
  await expect(deps.locator('.dep-item')).toHaveCount(1);
  await expect(deps.locator('.dep-item')).toContainText('前端页面');
  await expect(page.getByTestId('waiting')).toHaveText('等待中：前置任务未完成');
  await deps.getByLabel('添加前置').fill('视觉');
  await expect(deps.getByRole('option', { name: /视觉稿/ })).toBeEnabled();
  await deps.getByRole('option', { name: /视觉稿/ }).click();
  await expect.poll(() => rec.deps.length).toBe(1);
  expect(rec.deps[0]!.method).toBe('POST');
  expect(rec.deps[0]!.body.fromNode).toBe('visual');
  expect(rec.deps[0]!.body.toNode).toBe('api');
  await expect(deps.locator('.dep-item')).toHaveCount(2);
  await expect(gantt.locator('.gantt-dep')).toHaveCount(2);
  // adding 接口联调 as a predecessor of 前端页面 would cycle → option disabled
  await gantt.locator('.gantt-row[data-node-id="fe"]').click();
  await deps.getByLabel('添加前置').fill('接口');
  await expect(deps.getByRole('option', { name: /接口联调/ })).toBeDisabled();
  await deps.getByLabel('添加前置').fill('');
  // remove the 视觉稿 predecessor again
  await gantt.locator('.gantt-row[data-node-id="api"]').click();
  await deps.getByRole('button', { name: '移除前置 视觉稿' }).click();
  await expect.poll(() => rec.deps.length).toBe(2);
  expect(rec.deps[1]!.method).toBe('DELETE');
  await expect(deps.locator('.dep-item')).toHaveCount(1);

  await gantt.locator('.gantt-row[data-node-id="fe"]').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'e2e/out/gantt.png' });
});

test('people board renders columns and drag changes the owner; contact filter narrows it', async ({ page }) => {
  const rec = recorder();
  await mockApi(page, rec.posted, rec.undone, rec);
  await login(page);
  await page.goto(`/projects/${fx.PROJECT_ID}`);
  await expect(page.locator('.mm-node')).toHaveCount(8);
  await page.getByRole('tab', { name: '按人' }).click();
  const board = page.getByTestId('board');
  await expect(board.locator('.board-col')).toHaveCount(5); // 我 + 3 contacts + 未分配
  await expect(board.locator('.board-col[data-col-key="c_wang"] .board-card')).toHaveCount(1);
  await expect(board.locator('.board-col[data-col-key="c_wang"]')).toContainText('40 h');
  await expect(board.locator('.board-col[data-col-key="c_chen"] .board-card')).toContainText('接口联调');
  await expect(board.locator('.board-col[data-col-key="c_chen"] .board-card .red')).toHaveText('8/30');
  await expect(board.locator('.board-col[data-col-key="c_chen"] .board-card .dot-pending')).toBeVisible();
  await expect(board.locator('.board-col[data-col-key=""] .board-card')).toHaveCount(1); // 上线 (milestone, mine)
  await board.locator('.board-card[data-node-id="fe"]').click();
  await expect(page.getByTestId('sidebar').getByLabel('标题')).toHaveValue('前端页面');
  await page.screenshot({ path: 'e2e/out/board.png' });

  // drag 前端页面 (王芳) to 我 — both columns are fully visible without scrolling the board
  const card = (await board.locator('.board-card[data-node-id="fe"]').boundingBox())!;
  const me = (await board.locator('.board-col[data-col-key=""]').boundingBox())!;
  await page.mouse.move(card.x + 40, card.y + 20);
  await page.mouse.down();
  await page.mouse.move(card.x + 60, card.y + 30, { steps: 3 });
  await page.mouse.move(me.x + me.width / 2, me.y + 150, { steps: 8 });
  await expect(board.locator('.board-col[data-col-key=""]')).toHaveClass(/drop-target/);
  await expect(board.locator('.board-card.ghost')).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => rec.posted.filter((o) => o.type === 'update_node' && o.patch.ownerId === null).length).toBe(1);
  const mv = rec.posted.find((o) => o.type === 'update_node')!;
  expect(mv.type === 'update_node' && mv.nodeId).toBe('fe');
  await expect(board.locator('.board-col[data-col-key=""] .board-card')).toHaveCount(2);
  await expect(board.locator('.board-col[data-col-key="c_wang"] .board-card')).toHaveCount(0);

  // top bar contact filter narrows the board to one column
  await page.locator('.owner-filter button[title="王芳"]').click();
  await expect(board.locator('.board-col')).toHaveCount(1);
  await page.locator('.owner-filter button[title="王芳"]').click();
  await expect(board.locator('.board-col')).toHaveCount(5);
});

test('Claude panel streams a reply with a tool chip and refreshes the project', async ({ page }) => {
  const rec = recorder();
  await mockApi(page, rec.posted, rec.undone, rec);
  await login(page);
  await page.goto(`/projects/${fx.PROJECT_ID}`);
  await expect(page.locator('.mm-node')).toHaveCount(8);
  const getsBefore = rec.projectGets;

  await page.keyboard.press('Control+j');
  const panel = page.getByTestId('chat-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('和 Claude 聊「官网改版」');
  await panel.getByLabel('消息').fill('把接口联调的进度改成 30%');
  await panel.getByLabel('消息').press('Enter');
  await expect.poll(() => rec.chatPosts.length).toBe(1);
  expect(rec.chatPosts[0]!.text).toBe('把接口联调的进度改成 30%');
  expect(rec.chatPosts[0]!.projectId).toBe(fx.PROJECT_ID);
  await expect(panel.locator('.chat-bubble')).toHaveText('把接口联调的进度改成 30%');
  const chip = panel.getByTestId('tool-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip.locator('.tool-chip-label')).toHaveText('调用 update_node · 接口联调 · 待确认');
  await expect(panel.locator('.chat-md strong')).toHaveText('接口联调');
  await expect(panel.locator('.chat-md li')).toHaveCount(2);
  await chip.locator('.tool-chip-head').click();
  await expect(chip.locator('pre').first()).toContainText('"progress": 30');
  // the tool produced a pending change → the project reloaded
  await expect.poll(() => rec.projectGets).toBeGreaterThan(getsBefore);
  // session title comes from the server
  await expect(panel.locator('select[aria-label="会话"] option:checked')).toContainText('改接口联调进度');
  await page.screenshot({ path: 'e2e/out/chat.png' });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // export menu: download the outline as .md
  await page.getByRole('button', { name: '导出' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: '下载大纲 .md' }).click()]);
  // headless Chromium reports non-ASCII download names as "download"; real browsers keep 「官网改版.md」
  expect(['官网改版.md', 'download']).toContain(download.suggestedFilename());
  const saved = await download.path();
  expect(await (await import('node:fs/promises')).readFile(saved!, 'utf8')).toBe(fx.outlineText);

  // print page renders the outline and the gantt svg without chrome
  await page.goto(`/projects/${fx.PROJECT_ID}/print`);
  await expect(page.getByTestId('print')).toBeVisible();
  await expect(page.locator('.print-head h1')).toHaveText('官网改版');
  await expect(page.locator('.print-outline li')).toHaveCount(8);
  await expect(page.getByTestId('gantt-print')).toBeVisible();
  await expect(page.locator('.rail')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/out/print.png', fullPage: true });
});

test('settings page saves account, notifications and confirmation rules; lists tokens', async ({ page }) => {
  const rec = recorder();
  await mockApi(page, rec.posted, rec.undone, rec);
  await login(page);
  await page.goto('/settings');
  const s = page.getByTestId('settings');
  await expect(s.getByLabel('名字')).toHaveValue('蔡');
  await expect(s.getByLabel('时区')).toHaveValue('Asia/Shanghai');
  await expect(s.locator('.tokens-table tbody tr')).toHaveCount(2);
  await expect(s.locator('.tokens-table')).toContainText('Claude Code');
  await expect(s.locator('.tokens-table')).toContainText('oauth');
  await s.getByLabel('名字').fill('蔡先生');
  await s.getByLabel('周摘要', { exact: false }).uncheck();
  await s.getByLabel('催办模板').fill('{owner}你好，「{title}」{due} 到期，进度 {progress}%');
  await s.getByLabel(/^截止日/).uncheck();
  await s.getByRole('button', { name: '保存' }).click();
  await expect.poll(() => rec.mePatches.length).toBe(1);
  const body = rec.mePatches[0]!;
  expect(body.name).toBe('蔡先生');
  expect(body.timezone).toBe('Asia/Shanghai');
  const settings = body.settings as Record<string, unknown>;
  expect((settings.notifications as Record<string, boolean>).digest).toBe(false);
  expect((settings.notifications as Record<string, boolean>).dueSoon).toBe(true);
  expect(settings.nudgeTemplate).toBe('{owner}你好，「{title}」{due} 到期，进度 {progress}%');
  expect(settings.keyFields).toEqual(['startDate', 'ownerId', 'delete', 'status_done']);
  expect(settings.requireConfirmation).toBe(true);
  await expect(page.getByText('设置已保存')).toBeVisible();
  await expect(page.locator('.rail .name')).toHaveText('蔡先生');
  await page.screenshot({ path: 'e2e/out/settings.png', fullPage: true });
});

// ---------------------------------------------------------------------------
// Phone layout (design/mobile-v2): iPhone-sized viewport, touch, the same mocked API.
// ---------------------------------------------------------------------------
test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });

  test('今天 → 项目 → node page → Claude on a phone', async ({ page }) => {
    const rec = recorder();
    await mockApi(page, rec.posted, rec.undone, rec, { extraNodes: [fx.weekNode] });
    // no system share sheet in headless Chromium → 催 falls back to the clipboard + toast
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      } catch {
        /* ignore */
      }
    });
    // the fixtures are dated around 2026-09-03; pin the browser clock so 逾期 n 天 / 本周 are stable
    await page.clock.setFixedTime(new Date('2026-09-03T10:00:00'));
    await login(page);

    // shell: bottom tab bar instead of the rail
    await expect(page.getByTestId('tabbar')).toBeVisible();
    await expect(page.locator('.rail')).toHaveCount(0);
    const today = page.getByTestId('phone-today');
    await expect(today).toBeVisible();
    await expect(today.getByTestId('today-date')).toHaveText('9月3日 周四');
    // one pending card + the single 要做的 list
    const card = today.getByTestId('change-ch1');
    await expect(card).toContainText('Claude 提议 · 接口联调');
    await expect(card).toContainText('截止日 8/30 → 10/5');
    await expect(today.getByTestId('todo-label')).toHaveText('要做的 · 1');
    const apiRow = today.getByTestId('task-api');
    await expect(apiRow).toContainText('陈小明 · 逾期 4 天');
    await expect(apiRow.locator('.ph-task-date')).toHaveClass(/red/);
    // 本周还有 n 项 expands inline (computed from the project tree: 埋点接入 due 9/9)
    await expect(today.getByTestId('more-week')).toHaveText(/本周还有 1 项/);
    await page.screenshot({ path: 'e2e/out/phone-today.png' });
    await today.getByTestId('more-week').click();
    await expect(today.getByTestId('task-track')).toContainText('王芳 · 周三');
    // 催 → nudge text copied and shown
    await apiRow.getByTestId('nudge-api').click();
    await expect(page.locator('.toast')).toContainText('已复制到剪贴板');
    await expect(page.locator('.toast')).toContainText('小明，关于「接口联调」');
    // approve the pending change
    await card.getByTestId('approve-ch1').click();
    await expect.poll(() => rec.decisions).toEqual(['ch1:approve']);
    await expect(page.getByText('已确认', { exact: true })).toBeVisible();

    // 项目 tab → list → project page (列表 default)
    await page.getByTestId('tab-项目').click();
    await expect(page).toHaveURL(/\/projects$/);
    const row = page.getByTestId(`project-${fx.PROJECT_ID}`);
    await expect(row).toContainText('官网改版');
    await expect(row).toContainText('1 项逾期 · 1 待确认 · 1 处延误');
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${fx.PROJECT_ID}$`));
    const project = page.getByTestId('phone-project');
    await expect(project.getByTestId('view-outline')).toHaveAttribute('aria-selected', 'true');
    await expect(project.getByTestId('project-meta')).toContainText('10/10 上线 · 1 处延误');
    const outline = project.getByTestId('phone-outline');
    await expect(outline.locator('.ph-row')).toHaveCount(8); // root's children, all expanded (+ 埋点接入)
    await expect(outline.getByTestId('outline-api').locator('.ph-row-date')).toHaveClass(/red/);
    await expect(outline.getByTestId('outline-api').locator('.ph-dot.pend')).toBeVisible();
    await expect(outline.getByTestId('outline-design').locator('.ph-row-title')).toHaveClass(/parent/);
    await page.screenshot({ path: 'e2e/out/phone-project.png' });
    // collapse 设计 → its two children disappear
    await outline.getByTestId('outline-design').getByRole('button', { name: '收起' }).click();
    await expect(outline.locator('.ph-row')).toHaveCount(6);
    // 导图 toggle shows the read-only mind map
    await project.getByTestId('view-map').click();
    await expect(page.locator('.mindmap')).toBeVisible();
    await expect(page.locator('.mm-node')).toHaveCount(7); // 9 nodes, 设计 still collapsed
    await expect(page.locator('.mm-hint')).toHaveCount(0);
    await project.getByTestId('view-outline').click();
    // + adds a child under the root and opens the node page with the title focused
    await project.getByTestId('add-node').click();
    await expect(page).toHaveURL(new RegExp(`/projects/${fx.PROJECT_ID}/node/[0-9a-f-]{36}\\?focus=1$`));
    await expect.poll(() => rec.posted.filter((o) => o.type === 'create_node').length).toBe(1);
    const created = rec.posted.find((o) => o.type === 'create_node')!;
    expect(created.type === 'create_node' && created.node.parentId).toBe('root');
    const titleInput = page.getByTestId('node-title');
    await expect(titleInput).toBeFocused();
    await titleInput.fill('埋点复核');
    await titleInput.press('Enter');
    await expect.poll(() => rec.posted.filter((o) => o.type === 'update_node' && o.patch.title === '埋点复核').length).toBe(1);
    await page.getByTestId('node-back').click();
    await expect(outline.locator('.ph-row')).toHaveCount(7);
    await expect(outline).toContainText('埋点复核');

    // node page for 接口联调
    await page.goto(`/projects/${fx.PROJECT_ID}/node/api`);
    const node = page.getByTestId('phone-node');
    await expect(node.getByTestId('node-title')).toHaveValue('接口联调');
    await expect(node.locator('.ph-crumb')).toHaveText('官网改版 / 开发');
    await expect(node.getByTestId('status-blocked')).toHaveAttribute('aria-pressed', 'true');
    await expect(node.getByTestId('due-row')).toContainText('8/30 · 逾期 4 天');
    await expect(node.getByTestId('owner-row')).toContainText('陈小明');
    await expect(node.getByTestId('progress-value')).toHaveText('10%');
    await expect(node.getByTestId('change-ch1')).toContainText('截止日 8/30 → 10/5');
    await expect(node.getByTestId('nudge-note')).toHaveText('还没催过');
    await page.screenshot({ path: 'e2e/out/phone-node.png' });
    await node.getByTestId('status-in_progress').click();
    await expect.poll(() => rec.posted.filter((o) => o.type === 'update_node' && o.patch.status === 'in_progress').length).toBe(1);
    await expect(node.getByTestId('status-in_progress')).toHaveAttribute('aria-pressed', 'true');
    // owner sheet → 我
    await node.getByTestId('owner-row').click();
    await expect(page.getByTestId('owner-sheet')).toBeVisible();
    await page.getByTestId('owner-me').click();
    await expect.poll(() => rec.posted.filter((o) => o.type === 'update_node' && o.patch.ownerId === null).length).toBe(1);
    await expect(node.getByTestId('owner-row')).toContainText('我');
    // 更多 expands the rest
    await node.getByTestId('more-toggle').click();
    const more = node.getByTestId('more-body');
    await expect(more).toBeVisible();
    await expect(more.getByTestId('start-row')).toContainText('9/15');
    await expect(more.getByTestId('dep-waiting')).toHaveText('等待中：前置任务未完成');
    await expect(more.getByTestId('dep-slip-fe')).toContainText('延误 9 天');
    await expect(more.getByTestId('dep-fe')).toContainText('前端页面');
    await expect(more.locator('.via')).toHaveText('经 Claude');

    // Claude: 问 Claude from the project scopes a new conversation; the mocked SSE renders a tool chip
    await page.getByTestId('node-back').click();
    await project.getByTestId('ask-claude').click();
    await expect(page).toHaveURL(/\/claude\?projectId=p1/);
    const claude = page.getByTestId('phone-claude');
    await expect(claude.getByTestId('chat-scope')).toHaveText('官网改版');
    await claude.getByTestId('chat-input').fill('把接口联调的进度改成 30%');
    await claude.getByTestId('chat-send').click();
    await expect.poll(() => rec.chatPosts.length).toBe(1);
    expect(rec.chatPosts[0]!.projectId).toBe(fx.PROJECT_ID);
    await expect(claude.locator('.ph-msg.mine')).toHaveText('把接口联调的进度改成 30%');
    const chip = claude.getByTestId('tool-chip');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText('改了进度 · 待确认');
    await expect(chip).toHaveClass(/pending/);
    await expect(claude.locator('.ph-msg-text strong')).toHaveText('接口联调');
    await expect(page.getByTestId('tab-Claude')).toHaveClass(/active/);
    await page.screenshot({ path: 'e2e/out/phone-claude.png' });
    // history sheet lists the (server-titled) conversation
    await claude.getByTestId('chat-history').click();
    await expect(page.getByTestId('history-sheet')).toContainText('改接口联调进度');

    // contacts / settings only stack into one column on the phone
    await page.goto('/contacts');
    await expect(page.getByText('陈小明')).toBeVisible();
    await expect(page.getByTestId('tabbar')).toBeVisible();
    await page.goto('/settings');
    await expect(page.getByTestId('settings').getByLabel('名字')).toHaveValue('蔡');
    await page.screenshot({ path: 'e2e/out/phone-settings.png' });
    // the desktop-only URLs fold back into the phone pages
    await page.goto(`/projects/${fx.PROJECT_ID}?node=fe`);
    await expect(page).toHaveURL(new RegExp(`/projects/${fx.PROJECT_ID}/node/fe$`));
    await expect(page.getByTestId('node-title')).toHaveValue('前端页面');
  });
});
