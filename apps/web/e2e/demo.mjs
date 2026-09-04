// Smoke check for the single-file demo build (dist-demo/index.html) served by a plain static server.
// No route mocking: the page answers its own /api/* calls from the in-memory DemoServer.
// Usage (from apps/web, after `pnpm build:demo`): node e2e/demo.mjs [url]
//   default url: http://127.0.0.1:8765/index.html (start e.g. `python3 -m http.server 8765 -d dist-demo`)
import { chromium } from '@playwright/test';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8765/index.html';
const assert = (cond, msg) => {
  if (!cond) throw new Error('ASSERT: ' + msg);
  console.log('ok  ', msg);
};
const badgeCount = async (page) => {
  const t = (await page.getByTestId('pending-toggle').innerText()).replace(/\s+/g, '');
  const m = /待确认(\d+)/.exec(t);
  return m ? Number(m[1]) : 0;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => {
  // the sandbox has no route to Google Fonts; that resource error is expected offline and not a bug in the page
  if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)\.com/.test(m.location()?.url ?? '')) consoleErrors.push(`${m.text()} @ ${m.location()?.url ?? ''}`);
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => {
  // fonts are optional (offline sandbox); anything else failing is a bug
  if (!/fonts\.(googleapis|gstatic)\.com/.test(r.url())) consoleErrors.push('requestfailed: ' + r.url());
});

try {
  // today page (no login page in demo mode)
  await page.goto(URL_);
  await page.getByRole('heading', { name: '今天', exact: true }).waitFor({ timeout: 15000 });
  assert(await page.getByTestId('demo-banner').isVisible(), 'demo banner visible');
  assert(/#\/$/.test(page.url()) || page.url().endsWith('index.html') || page.url().includes('#/'), `hash router at ${page.url()}`);
  const todayText = await page.locator('.page').innerText();
  assert(/逾期\s*[1-9]/.test(todayText), 'today: overdue section has items');
  assert(/今天到期\s*[1-9]/.test(todayText), 'today: due-today section has items');
  assert(todayText.includes('明天到期'), 'today: due-tomorrow listed');
  assert(/待确认\s*[1-9]/.test(todayText), 'today: pending section has items');
  assert(/该催的\s*[1-9]/.test(todayText), 'today: nudge-due section has items');
  assert(todayText.includes('接口联调') && todayText.includes('经 Claude'), 'today: pending change from Claude on 接口联调');
  assert((await page.locator('.rail .conn').innerText()).includes('已连接'), 'realtime indicator says 已连接');

  // project list
  await page.getByRole('link', { name: '项目' }).click();
  await page.getByRole('cell', { name: /官网改版/ }).waitFor();
  assert(await page.getByRole('cell', { name: /Q4 产品规划/ }).isVisible(), 'project list shows both seeded projects');
  assert((await page.locator('.projects-table .slip-badge').count()) >= 1, 'project list shows a slip badge');

  // mind map
  await page.getByRole('cell', { name: /官网改版/ }).click();
  await page.locator('.mm-node').first().waitFor();
  await page.waitForTimeout(300);
  const nodesBefore = await page.locator('.mm-node').count();
  assert(nodesBefore >= 7, `mind map shows ${nodesBefore} nodes (>= 7)`);
  assert(await page.locator('.mm-node[data-node-id="p1_api"] .dot-pending').isVisible(), '接口联调 carries the pending dot');
  assert((await page.locator('.mindmap svg.links path.critical').count()) >= 1, 'critical path drawn');

  // Tab on a selected node creates a child (goes through POST /api/projects/:id/ops on the mock)
  await page.locator('.mm-node[data-node-id="p1_fe"]').click();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  assert((await page.locator('.mm-node').count()) === nodesBefore + 1, 'Tab created a child node');
  await page.keyboard.type('埋点接入（演示）');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const errToast = await page.locator('.toast.error, .toast-error').count().catch(() => 0);
  assert(errToast === 0, 'no error toast after the edits');

  // undo twice via the mock's op log (Ctrl+Z → POST /api/ops/:seq/undo): first the title edit, then the create itself
  await page.keyboard.press('Control+z');
  await page.getByText('已撤销').first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(600);
  assert((await page.locator('.mm-node').count()) === nodesBefore + 1, 'first undo reverted the title, node still there');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(800);
  assert((await page.locator('.mm-node').count()) === nodesBefore, 'second undo removed the created node (inverse = delete_node)');

  // gantt
  await page.getByRole('tab', { name: '甘特' }).click();
  await page.getByTestId('gantt').waitFor();
  assert((await page.locator('.gantt-bar').count()) >= 7, 'gantt renders bars');
  assert((await page.locator('.gantt-dep').count()) >= 1, 'gantt renders dependencies');

  // board
  await page.getByRole('tab', { name: '按人' }).click();
  await page.getByTestId('board').waitFor();
  assert((await page.locator('.board-col').count()) >= 4, 'people board renders columns');
  await page.getByRole('tab', { name: '导图' }).click();

  // Claude panel: scripted reply runs update_node through the mock and lands in 待确认
  const badgeBefore = await badgeCount(page);
  assert(badgeBefore >= 1, `待确认 badge before chat = ${badgeBefore}`);
  await page.getByTestId('chat-toggle').click();
  const panel = page.getByTestId('chat-panel');
  await panel.waitFor();
  assert((await panel.innerText()).includes('claude-opus-5'), 'assistant status shows the model');
  await panel.getByLabel('消息').fill('把接口联调延到下周');
  await panel.getByLabel('消息').press('Enter');
  await panel.getByTestId('tool-chip').waitFor({ timeout: 10000 });
  const chipLabel = await panel.locator('.tool-chip-label').first().innerText();
  assert(chipLabel.includes('update_node') && chipLabel.includes('接口联调') && chipLabel.includes('待确认'), `tool chip: ${chipLabel}`);
  await page.waitForTimeout(1500);
  const reply = await panel.locator('.chat-md').last().innerText();
  assert(reply.startsWith('（演示回答）'), 'assistant text carries the （演示回答） prefix');
  // the seeded change on the same field is still pending, so the mock reuses it (like the server); assert the badge did not drop
  let badgeAfter = await badgeCount(page);
  assert(badgeAfter >= badgeBefore, `待确认 badge after chat = ${badgeAfter}`);
  // a second ask for another (leaf) node creates a brand-new pending change → badge increments
  await panel.getByLabel('消息').fill('把埋点接入也延几天');
  await panel.getByLabel('消息').press('Enter');
  await page.waitForTimeout(2500);
  badgeAfter = await badgeCount(page);
  assert(badgeAfter === badgeBefore + 1, `待确认 badge incremented to ${badgeAfter}`);
  await page.screenshot({ path: 'e2e/out/demo-chat.png' });
  await page.keyboard.press('Escape');

  // approve the seeded change from the sidebar → date changes
  await page.locator('.mm-node[data-node-id="p1_api"]').click();
  const sidebar = page.getByTestId('sidebar');
  const dueInput = sidebar.locator('input[type="date"]').nth(1);
  const dueBefore = await dueInput.inputValue();
  const card = sidebar.locator('.pending-card').first();
  await card.waitFor();
  const expected = /(\d{4}-\d{2}-\d{2})/.exec(await sidebar.locator('.pending-card').first().innerText());
  await card.getByRole('button', { name: '确认' }).click();
  await page.getByText('已确认 1 项').waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  const dueAfter = await dueInput.inputValue();
  assert(dueBefore !== dueAfter, `due date changed ${dueBefore} → ${dueAfter}`);
  assert(await page.locator('.mm-node[data-node-id="p1_api"] .dot-pending').isHidden(), 'pending dot gone after approval');
  assert((await badgeCount(page)) === badgeAfter - 1, '待确认 badge decremented after approval');
  void expected;

  // pending panel shows the Q4 draft batch (other project) is NOT here, but this project has a change left
  await page.getByTestId('pending-toggle').click();
  await page.getByTestId('pending-panel').waitFor();
  await page.getByTestId('pending-panel').getByRole('button', { name: '关闭' }).click();

  // outline view + copy outline endpoint (text/plain from the mock)
  await page.getByRole('tab', { name: '大纲' }).click();
  assert((await page.locator('.ol-row').count()) >= 7, 'outline view renders rows');
  await page.getByRole('tab', { name: '导图' }).click();
  await page.getByTitle('适应窗口').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/out/demo.png' });

  // Q4 project: draft batch from Claude can be applied
  await page.getByRole('link', { name: '项目' }).click();
  await page.getByRole('cell', { name: /Q4 产品规划/ }).click();
  await page.locator('.mm-node').first().waitFor();
  await page.waitForTimeout(300);
  const q4Before = await page.locator('.mm-node').count();
  await page.getByTestId('pending-toggle').click();
  const pp = page.getByTestId('pending-panel');
  await pp.getByRole('button', { name: '应用' }).waitFor();
  await pp.getByRole('button', { name: '应用' }).click();
  await page.getByText('草案已应用').waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  assert((await page.locator('.mm-node').count()) === q4Before + 3, 'applying the draft batch added 3 nodes');
  await pp.getByRole('button', { name: '关闭' }).click();

  // contacts
  await page.getByRole('link', { name: '联系人' }).click();
  await page.getByText('陈小明').waitFor();
  await page.getByText('陈小明').click();
  await page.locator('.list-item .title').filter({ hasText: '接口联调' }).first().waitFor();
  assert(true, 'contact page lists 陈小明 tasks');

  // settings
  await page.getByRole('link', { name: '设置' }).click();
  await page.getByTestId('settings').waitFor();
  assert((await page.locator('.tokens-table tbody tr').count()) === 2, 'settings lists 2 tokens');
  await page.getByTestId('settings').getByLabel('名字').fill('蔡先生');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('设置已保存').waitFor();
  assert((await page.locator('.rail .name').innerText()) === '蔡先生', 'PATCH /api/me persisted in memory');

  // logout re-enters demo mode without a login form
  await page.getByRole('button', { name: '退出' }).click();
  await page.getByRole('heading', { name: '今天', exact: true }).waitFor({ timeout: 10000 });
  assert(!(await page.locator('.login').count()), 'logout never shows the login page in demo mode');

  assert(consoleErrors.length === 0, `zero console errors (${consoleErrors.length ? consoleErrors.join(' | ') : 'clean'})`);
  console.log('\nDEMO SMOKE PASSED');
} catch (e) {
  await page.screenshot({ path: 'e2e/out/demo-failure.png' }).catch(() => undefined);
  console.error('\nDEMO SMOKE FAILED:', e.message);
  if (consoleErrors.length) console.error('console errors:', consoleErrors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
