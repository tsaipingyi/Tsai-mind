// Visual smoke run of the web export at an iPhone viewport.
// Usage: pnpm --filter @tsai-mind/mobile export:web && node e2e/run.mjs
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';
import * as F from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const out = path.resolve(here, 'out');
const PORT = Number(process.env.PORT || 4310);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json' };

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      let file = path.join(dist, decodeURIComponent(url.pathname));
      try {
        const st = await stat(file);
        if (st.isDirectory()) file = path.join(file, 'index.html');
      } catch {
        file = path.join(dist, 'index.html'); // SPA fallback
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockApi(page, log) {
  const state = { pending: [...F.todayResponse.pending], batches: [F.draftBatch], ops: [], mePatches: [], sessions: [...F.sessions], chatPosts: [], deletedSessions: [] };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const m = req.method();
    log.push(`${m} ${p}${u.search}`);
    if (p === '/api/me' && m === 'PATCH') {
      const body = req.postDataJSON();
      state.mePatches.push(body);
      const account = { ...F.me.account, ...body, settings: { ...F.me.account.settings, ...(body.settings ?? {}) } };
      return json(route, { account });
    }
    if (p === '/api/me') return json(route, F.me);
    // ---- assistant ----
    if (p === '/api/assistant/status') return json(route, F.assistantStatus);
    if (p === '/api/assistant/sessions' && m === 'GET') return json(route, state.sessions);
    if (p === '/api/assistant/sessions' && m === 'POST') {
      const body = req.postDataJSON() ?? {};
      const created = { id: `s${state.sessions.length + 1}`, title: null, projectId: body.projectId ?? null, lastText: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.sessions.unshift(created);
      return json(route, { session: created });
    }
    if (p.startsWith('/api/assistant/sessions/') && p.endsWith('/messages') && m === 'POST') {
      state.chatPosts.push({ id: p.split('/')[4], body: req.postDataJSON() });
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: F.sseReply });
    }
    if (p.startsWith('/api/assistant/sessions/') && m === 'DELETE') {
      const id = p.split('/')[4];
      state.deletedSessions.push(id);
      state.sessions = state.sessions.filter((x) => x.id !== id);
      return json(route, { ok: true });
    }
    if (p.startsWith('/api/assistant/sessions/') && m === 'GET') {
      const id = p.split('/')[4];
      if (id === 's1') return json(route, F.sessionDetail);
      const session = state.sessions.find((x) => x.id === id);
      return session ? json(route, { session, messages: [] }) : json(route, { error: 'not_found' }, 404);
    }
    if (p === '/api/projects' && m === 'GET') return json(route, F.projectRows);
    if (p === `/api/projects/${F.PROJECT_ID}` && m === 'GET') return json(route, F.projectDetail);
    if (p === `/api/projects/${F.PROJECT_ID}/plan-batches`) return json(route, state.batches);
    if (p === `/api/projects/${F.PROJECT_ID}/ops` && m === 'POST') {
      const body = req.postDataJSON();
      state.ops.push(...body.ops);
      return json(route, { results: body.ops.map((o, i) => ({ opId: o.opId, ok: true, serverSeq: 43 + i })), serverSeq: 43 + body.ops.length });
    }
    if (p === `/api/projects/${F.PROJECT_ID}/ops` && m === 'GET') return json(route, []);
    if (p === `/api/projects/${F.PROJECT_ID}/activity`) return json(route, F.nodeDetail.activity);
    if (p === '/api/today') return json(route, { ...F.todayResponse, pending: state.pending });
    if (p === '/api/contacts') return json(route, F.contacts);
    if (p === '/api/changes') return json(route, state.pending);
    if (p.startsWith('/api/changes/') && (p.endsWith('/approve') || p.endsWith('/reject'))) {
      const id = p.split('/')[3];
      state.pending = state.pending.filter((c) => c.id !== id);
      return json(route, { ok: true });
    }
    if (p === '/api/nodes/api' && m === 'GET') return json(route, F.nodeDetail);
    if (p.startsWith('/api/nodes/') && p.endsWith('/nudge')) return json(route, { text: `陈小明你好，「接口联调」原定 ${F.short(-4)} 完成，现在已经逾期 4 天，请问进展如何？`, node: { ...F.nodes.find((x) => x.id === 'api'), lastNudgedAt: new Date().toISOString() } });
    if (p.startsWith('/api/plan-batches/') && p.endsWith('/apply')) {
      state.batches = [];
      return json(route, { ok: true });
    }
    if (p === '/api/realtime') return route.abort();
    return json(route, { error: 'not_found', message: `no fixture for ${m} ${p}` }, 404);
  });
  return state;
}

async function main() {
  await mkdir(out, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ ...devices['iPhone 14'], deviceScaleFactor: 2, viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text().slice(0, 300)}`);
  });
  const log = [];
  const state = await mockApi(page, log);
  const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });
  const base = `http://127.0.0.1:${PORT}`;
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };

  // 1. login
  await page.goto(`${base}/login`);
  await page.getByTestId('login-server').waitFor({ timeout: 30_000 });
  await page.getByTestId('login-server').fill(base);
  await page.getByTestId('login-token').fill('tm_test_token');
  await shot('01-login');
  await page.getByTestId('login-submit').click();

  // 2. 今天: title + date, one pending card, 要做的 = overdue + today + tomorrow, 本周还有 n 项
  await page.getByTestId('todo-label').waitFor({ timeout: 30_000 });
  await page.getByTestId('more-week').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('v2-today');
  check(/^\d+月\d+日 周.$/.test(await page.getByTestId('today-date').innerText()), 'today: date label');
  check((await page.getByTestId('todo-label').innerText()) === '要做的 · 4', 'today: one merged list of 4');
  check(await page.getByText('陈小明 · 逾期 4 天').count(), 'today: overdue sub line');
  check(await page.getByText('王芳 · 今天').count(), 'today: due today sub line');
  check(await page.getByText('我 · 今天').count(), 'today: due today owned by me');
  check(await page.getByText('王芳 · 明天').count(), 'today: tomorrow row in the same list');
  check(!(await page.getByText('今天到期', { exact: true }).count()), 'today: no section headers');
  check((await page.getByTestId('change-ch1').count()) === 1, 'today: exactly one pending card');
  check(await page.getByText('Claude 提议 · 接口联调').count(), 'today: pending card header');
  check((await page.getByTestId('more-pending').innerText()).startsWith('还有 1 项待确认'), 'today: 还有 n 项待确认 row (the draft batch)');
  check(await page.getByTestId('nudge-api').count(), 'today: 催 on the overdue contact row');
  check(!(await page.getByTestId('nudge-track').count()), 'today: no 催 on a non-overdue row');
  check((await page.getByTestId('more-week').innerText()).startsWith('本周还有 2 项'), 'today: 本周还有 n 项');
  await page.getByTestId('more-week').click();
  await page.getByTestId('task-seo').waitFor({ timeout: 5_000 });
  check(await page.getByTestId('task-copy').count(), 'today: week rows expand inline');
  await page.getByTestId('nudge-api').click();
  await page.waitForTimeout(400);
  check(log.some((l) => l === 'POST /api/nodes/api/nudge'), 'today: 催 calls nudge');
  await page.waitForTimeout(4200); // the web fallback copies the text and toasts for 4s

  // 3. pending list from 还有 n 项待确认
  await page.getByTestId('more-pending').click();
  await page.getByTestId('batch-b1').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await shot('v2-pending');
  check(await page.getByText('草案 · 只新增').count(), 'pending: batch card');
  check(await page.getByTestId('change-ch1').count(), 'pending: change card');
  await page.goBack();
  await page.getByTestId('todo-label').waitFor({ timeout: 10_000 });

  // 4. 项目 tab → list → project (列表 default) → 导图 toggle
  await page.getByTestId('tab-projects').click();
  await page.getByTestId('project-p1').waitFor({ timeout: 15_000 });
  check(await page.getByText('1 项逾期 · 1 待确认').count(), 'projects: meta line');
  await shot('v2-projects');
  await page.getByTestId('project-p1').click();
  await page.getByTestId('outline-api').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('v2-project');
  check((await page.getByTestId('view-outline').getAttribute('aria-selected')) === 'true', 'project: 列表 is the default');
  const meta = await page.getByTestId('project-meta').innerText();
  check(/^进度 \d+% · \d+\/\d+ 上线 · 1 处延误$/.test(meta), `project: meta line (got ${meta})`);
  check(await page.getByTestId('ask-claude').count(), 'project: 问 Claude header entry');
  check(await page.getByTestId('outline-seo').count(), 'project: child rows listed');
  check(!(await page.getByTestId('outline-root').count()), 'project: root not repeated as a row');
  check(await page.getByTestId('add-node').count(), 'project: + button');
  await page.getByTestId('view-map').click();
  await page.locator('svg text', { hasText: '官网改版' }).first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('v2-project-map');
  check((await page.locator('[data-testid="critical-edge-root-launch"]').count()) > 0, 'map: critical path connector');
  await page.getByTestId('view-outline').click();
  await page.getByTestId('outline-api').waitFor({ timeout: 10_000 });

  // + adds an empty child under the root and opens it with the title focused
  await page.getByTestId('add-node').click();
  await page.getByTestId('node-title').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  check(state.ops.some((o) => o.type === 'create_node' && o.node.parentId === 'root' && o.node.title === ''), 'project: + posted create_node under root');
  check((await page.getByTestId('node-title').inputValue()) === '', 'node: new node opens with an empty title');
  await page.getByTestId('node-title').fill('性能预算');
  await page.getByTestId('node-title').press('Enter');
  await page.waitForTimeout(400);
  check(state.ops.some((o) => o.type === 'update_node' && o.patch.title === '性能预算'), 'node: title edit posted');
  await page.getByTestId('node-back').click();
  await page.getByTestId('outline-api').waitFor({ timeout: 10_000 });
  check(await page.getByText('性能预算').count(), 'project: new child shows in the list');

  // 5. node detail: four fields + 更多
  await page.getByTestId('outline-api').click();
  await page.getByTestId('node-title').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('v2-node');
  check((await page.getByTestId('node-title').inputValue()) === '接口联调', 'node: title');
  check(await page.getByText('官网改版 / 开发').count(), 'node: path');
  check((await page.getByTestId('status-blocked').getAttribute('aria-selected')) === 'true', 'node: 受阻 pill selected');
  check(!(await page.getByTestId('status-waiting').count()), 'node: 等待中 not on the pill row');
  check(new RegExp(`^${F.short(-4)} · 逾期 4 天$`).test(await page.getByTestId('due-row').innerText().then((s) => s.replace('截止', '').replace('›', '').trim())), 'node: 截止 row with overdue days');
  check(await page.getByTestId('owner-row').getByText('陈小明').count(), 'node: 负责人 row');
  check((await page.getByTestId('progress-value').innerText()) === '10%', 'node: 进度 value');
  check(await page.getByTestId('change-ch1').count(), 'node: pending card');
  check((await page.getByTestId('nudge-note').innerText()) === '3 天前催过', 'node: last nudged');
  check(!(await page.getByTestId('more-body').count()), 'node: 更多 collapsed by default');

  // status → op posted
  await page.getByTestId('status-in_progress').click();
  await page.waitForTimeout(600);
  check(state.ops.some((o) => o.type === 'update_node' && o.nodeId === 'api' && o.patch.status === 'in_progress' && o.actor === 'user' && o.clientId), 'node: status op posted');

  // 更多: start date, hours, dependencies, description, activity, 问 Claude
  await page.getByTestId('more-toggle').click();
  await page.getByTestId('more-body').waitFor({ timeout: 5_000 });
  await page.getByText('经 Claude').waitFor({ timeout: 10_000 });
  await page.getByTestId('start-row').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('v2-node-more');
  check(await page.getByTestId('start-row').count(), 'node: 开始日 under 更多');
  check((await page.getByTestId('estimate-input').inputValue()) === '24', 'node: 工时 under 更多');
  check(await page.getByTestId('status-waiting').count(), 'node: 等待中 under 更多');
  check(await page.getByTestId('dep-waiting').count(), 'node: waiting on dependency line');
  check(await page.getByText('延误 9 天', { exact: false }).count(), 'node: slip line');
  check(await page.getByTestId('dep-fe').count(), 'node: predecessor row');
  check(await page.getByText('前置任务', { exact: true }).count(), 'node: 前置任务 heading');

  // approve the pending change from the node screen
  await page.getByTestId('approve-ch1').last().click();
  await page.waitForTimeout(500);
  check(log.some((l) => l === 'POST /api/changes/ch1/approve'), 'node: approve called');

  // 问 Claude from the node → Claude tab, new conversation scoped to the project, prefilled
  await page.getByTestId('ask-claude-node').click();
  await page.getByTestId('chat-input').waitFor({ timeout: 15_000 });
  check((await page.getByTestId('chat-input').inputValue()).startsWith('关于「接口联调」'), 'chat: prefill from node');
  await page.getByTestId('chat-scope').getByText('官网改版').waitFor({ timeout: 10_000 });
  await page.getByTestId('chat-input').fill(`把接口联调延到 ${F.short(5)}，后端接口 ${F.short(4)} 才出。`);
  await page.getByTestId('chat-send').click();
  await page.getByTestId('tool-update_node').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(2600); // let the approve toast expire before the screenshot
  await shot('v2-claude');
  check(await page.getByText('改了截止日 · 待确认').count(), 'chat: tool chip in plain Chinese');
  check(await page.getByTestId('msg-m4').count(), 'chat: done event replaced the message id');
  check(await page.getByText('你确认后生效').count(), 'chat: streamed text rendered');
  check(state.chatPosts.some((c) => c.id === 's3' && c.body.projectId === 'p1'), `chat: message posted to the new scoped session (got ${JSON.stringify(state.chatPosts)})`);
  await page.getByTestId('tool-update_node').click();
  await page.getByText('change_id', { exact: false }).waitFor({ timeout: 5_000 });

  // 历史 sheet: pick an older session
  await page.getByTestId('chat-history').click();
  await page.getByTestId('session-s1').waitFor({ timeout: 10_000 });
  check(await page.getByText('接口联调怎么办').count(), 'claude: session title in 历史');
  check(await page.getByTestId('session-s2').count(), 'claude: untitled session row');
  await page.waitForTimeout(300);
  await shot('v2-claude-history');
  await page.getByTestId('session-s1').click();
  await page.getByTestId('msg-m2').waitFor({ timeout: 15_000 });
  check(await page.getByTestId('tool-get_node').count(), 'chat: stored tool call chip');
  check(await page.getByTestId('chat-scope').count(), 'chat: scope chip from the session');
  await page.getByTestId('chat-input').fill(`那就推到 ${F.short(5)} 吧`);
  await page.getByTestId('chat-send').click();
  await page.getByTestId('msg-m4').waitFor({ timeout: 15_000 });
  check(state.chatPosts.some((c) => c.id === 's1' && c.body.text === `那就推到 ${F.short(5)} 吧`), 'chat: message posted to the picked session');

  // new chat from the header clears the conversation
  await page.getByTestId('new-chat').click();
  await page.waitForTimeout(300);
  check(!(await page.getByTestId('msg-m2').count()), 'chat: 新对话 starts empty');

  // settings (from the 项目 tab): toggles come from the server, a change is PATCHed
  await page.getByTestId('tab-projects').click();
  await page.getByTestId('node-back').waitFor({ timeout: 10_000 }); // the tab keeps its stack: node → project → list
  await page.getByTestId('node-back').click();
  await page.getByTestId('project-back').waitFor({ timeout: 10_000 });
  await page.getByTestId('project-back').click();
  await page.getByTestId('open-settings').waitFor({ timeout: 10_000 });
  await page.getByTestId('open-settings').click();
  await page.getByText('通知', { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByTestId('nudge-template').waitFor();
  check(!(await page.getByTestId('toggle-nudgeDue').locator('input').isChecked().catch(() => true)), 'settings: nudgeDue toggle reflects server (off)');
  await page.getByTestId('toggle-digest').click();
  await page.waitForTimeout(500);
  const patch = state.mePatches.at(-1);
  check(!!patch && patch.settings?.notifications?.digest === false && patch.settings?.notifications?.nudgeDue === false, `settings: PATCH /api/me with digest off (got ${JSON.stringify(patch)})`);
  await page.getByTestId('nudge-template').fill('{title} 进度如何？');
  await page.getByText('通知', { exact: true }).click(); // blur
  await page.waitForTimeout(500);
  check(state.mePatches.at(-1)?.settings?.nudgeTemplate === '{title} 进度如何？', 'settings: nudge template PATCHed');
  await shot('v2-settings');

  await browser.close();
  server.close();
  const realErrors = errors.filter((e) => !/realtime|WebSocket|favicon/i.test(e));
  console.log(`requests: ${log.length}, ops posted: ${state.ops.length}`);
  if (realErrors.length) console.log('browser errors:\n' + realErrors.join('\n'));
  if (failures.length) {
    console.error('FAILED checks:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log(`ok — screenshots in ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
