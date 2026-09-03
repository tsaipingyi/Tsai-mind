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
  const state = { pending: [...F.todayResponse.pending], batches: [F.draftBatch], ops: [] };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const m = req.method();
    log.push(`${m} ${p}${u.search}`);
    if (p === '/api/me') return json(route, F.me);
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
  await page.getByTestId('view-outline').click();
  await page.getByTestId('outline-api').waitFor({ timeout: 10_000 });
  await shot('06-project-outline');

  // 5. node detail (from outline)
  await page.getByTestId('outline-api').click();
  await page.getByTestId('node-title').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('07-node');
  check(await page.getByText('经 Claude').count(), 'node: claude activity label');
  check(await page.getByText('上次催办').count(), 'node: last nudged');

  // change status → op posted
  await page.getByText('等待中', { exact: true }).click();
  await page.waitForTimeout(600);
  check(state.ops.some((o) => o.type === 'update_node' && o.patch.status === 'waiting' && o.actor === 'user' && o.clientId), 'node: status op posted');
  await shot('08-node-after-edit');

  // approve the pending change from the node screen
  await page.getByTestId('approve-ch1').last().click();
  await page.waitForTimeout(500);
  check(log.some((l) => l === 'POST /api/changes/ch1/approve'), 'node: approve called');

  // settings
  await page.goBack();
  await page.goBack();
  await page.goBack();
  await page.getByTestId('open-settings').waitFor({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await page.getByText('通知', { exact: true }).waitFor({ timeout: 10_000 });
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
