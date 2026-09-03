import { expect, test, type Page, type Route } from '@playwright/test';
import type { Op } from '@tsai-mind/core';
import * as fx from './fixtures';

const TOKEN = 'tm_test_token';

async function mockApi(page: Page, posted: Op[], undone: number[]) {
  let seq = fx.projectDetail.serverSeq;
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

    if (path === '/api/me') return json(fx.me);
    if (path === '/api/projects' && method === 'GET') return json(fx.projectRows);
    if (path === `/api/projects/${fx.PROJECT_ID}` && method === 'GET') return json(fx.projectDetail);
    if (path === `/api/projects/${fx.PROJECT_ID}/activity`) {
      return json([
        { id: 1, projectId: fx.PROJECT_ID, nodeId: 'api', actor: 'claude', kind: 'field_changed', payload: { title: '接口联调', fields: { progress: { from: 0, to: 10 } } }, createdAt: '2026-09-02T09:00:00.000Z' },
        { id: 2, projectId: fx.PROJECT_ID, nodeId: 'fe', actor: 'user', kind: 'field_changed', payload: { title: '前端页面', fields: { status: { from: 'todo', to: 'in_progress' } } }, createdAt: '2026-09-02T10:00:00.000Z' },
      ]);
    }
    if (path === `/api/projects/${fx.PROJECT_ID}/outline`) return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: fx.outlineText });
    if (path === `/api/projects/${fx.PROJECT_ID}/ops` && method === 'GET') return json([]);
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
  await expect(page.getByRole('cell', { name: '官网改版' })).toBeVisible();
  await page.screenshot({ path: 'e2e/out/projects.png' });
});
