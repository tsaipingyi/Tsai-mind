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
    if (p.startsWith('/api/nodes/') && p.endsWith('/nudge')) return json(route, { text: '陈小明你好，「接口联调」原定 8/30 完成，现在已经逾期 4 天，请问进展如何？', node: { ...F.nodes[6], lastNudgedAt: new Date().toISOString() } });
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

  // 2. today
  await page.getByText('逾期', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText('接口联调').first().waitFor();
  await page.waitForTimeout(400);
  await shot('02-today');
  check(await page.getByText('逾期 4 天').count(), 'today: overdue label');
  check(await page.getByText('前端页面').count(), 'today: tomorrow section');
  check(await page.getByTestId('change-ch1').count(), 'today: pending card');
  check(await page.getByTestId('nudge-api').count(), 'today: nudge button');

  // 3. pending tab
  await page.getByText('待确认', { exact: true }).last().click();
  await page.getByTestId('batch-b1').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await shot('03-pending');
  check(await page.getByText('草案 · 只新增').count(), 'pending: batch card');

  // 4. projects → mind map
  await page.getByText('项目', { exact: true }).last().click();
  await page.getByTestId('project-p1').waitFor({ timeout: 15_000 });
  await shot('04-projects');
  await page.getByTestId('project-p1').click();
  await page.locator('svg text', { hasText: '官网改版' }).first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('05-project-map');
  check((await page.locator('svg text', { hasText: '接口联调' }).count()) > 0, 'map: node rendered');

  // outline toggle
  check((await page.locator('[data-testid="critical-edge-root-launch"]').count()) > 0, 'map: critical path connector');
  check(await page.getByTestId('ask-claude').count(), 'project: 问 Claude header entry');
  check(await page.getByText('延误 1').count(), 'project: slip count in toolbar');

  await page.getByTestId('view-outline').click();
  await page.getByTestId('outline-api').waitFor({ timeout: 10_000 });
  await shot('06-project-outline');
  check(await page.getByTestId('critical-launch').count(), 'outline: critical path marker');
  check(!(await page.getByTestId('critical-fe').count()), 'outline: no marker off the critical path');

  // 5. node detail (from outline)
  await page.getByTestId('outline-api').click();
  await page.getByTestId('node-title').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('07-node');
  check(await page.getByText('经 Claude').count(), 'node: claude activity label');
  check(await page.getByText('上次催办').count(), 'node: last nudged');
  check(await page.getByTestId('dep-waiting').count(), 'node: waiting on dependency line');
  check(await page.getByText('延误 9 天', { exact: false }).count(), 'node: slip line');
  check(await page.getByTestId('dep-fe').count(), 'node: predecessor row');
  check(await page.getByText('前置任务', { exact: true }).count(), 'node: 前置任务 heading');

  // change status → op posted
  await page.getByText('等待中', { exact: true }).click();
  await page.waitForTimeout(600);
  check(state.ops.some((o) => o.type === 'update_node' && o.patch.status === 'waiting' && o.actor === 'user' && o.clientId), 'node: status op posted');
  await shot('08-node-after-edit');

  // approve the pending change from the node screen
  await page.getByTestId('approve-ch1').last().click();
  await page.waitForTimeout(500);
  check(log.some((l) => l === 'POST /api/changes/ch1/approve'), 'node: approve called');

  // 问 Claude from the node → prefilled chat scoped to the project
  await page.getByTestId('ask-claude-node').click();
  await page.getByTestId('chat-input').waitFor({ timeout: 15_000 });
  check((await page.getByTestId('chat-input').inputValue()).startsWith('关于「接口联调」'), 'chat: prefill from node');
  await page.getByTestId('chat-scope').getByText('在项目 官网改版 中').waitFor({ timeout: 10_000 });
  await page.goBack();

  // Claude tab: session list
  await page.goBack();
  await page.goBack();
  await page.goBack();
  await page.getByText('Claude', { exact: true }).last().click();
  await page.getByTestId('session-s1').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(2600); // let the approve toast from the node step expire before the screenshot
  await shot('10-claude-sessions');
  check(await page.getByText('接口联调怎么办').count(), 'claude: session title');
  check(await page.getByTestId('session-s2').count(), 'claude: untitled session row');

  // chat: history + streamed reply with a tool chip
  await page.getByTestId('session-s1').click();
  await page.getByTestId('msg-m2').waitFor({ timeout: 15_000 });
  check(await page.getByTestId('tool-get_node').count(), 'chat: stored tool call chip');
  await page.getByTestId('chat-input').fill('那就推到 10/5 吧');
  await page.getByTestId('chat-send').click();
  await page.getByTestId('tool-update_node').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  check(await page.getByText('调用 update_node · 待确认').count(), 'chat: tool chip label');
  check(await page.getByTestId('msg-m4').count(), 'chat: done event replaced the message id');
  check(await page.getByText('你确认后生效').count(), 'chat: streamed text rendered');
  check(state.chatPosts.some((c) => c.id === 's1' && c.body.text === '那就推到 10/5 吧' && c.body.projectId === undefined), 'chat: message posted');
  await page.getByTestId('tool-update_node').click();
  await page.getByText('change_id', { exact: false }).waitFor({ timeout: 5_000 });
  await shot('11-chat');

  // new chat scoped to a project posts projectId
  await page.goBack();
  await page.getByTestId('new-chat').waitFor({ timeout: 10_000 });

  // settings: toggles come from the server, a change is PATCHed
  await page.getByText('设置', { exact: true }).last().click();
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
  await shot('09-settings');

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
