// Live end-to-end check against the real server (:3000) and vite dev (:5173).
// Usage (from apps/web, with server on :3000 and `pnpm dev` on :5173): node e2e/live.mjs <token>
// Needs @modelcontextprotocol/sdk resolvable from apps/web (symlink from apps/server/node_modules works).
import { chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.argv[2];
const API = 'http://127.0.0.1:3000';
const WEB = 'http://127.0.0.1:5173';
const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = async (path, init = {}) => {
  const r = await fetch(API + path, { ...init, headers: H });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json();
};
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); console.log('ok  ', msg); };

// 1. fresh project from an outline
const stamp = Date.now().toString().slice(-5);
const { project, nodes, warnings } = await api('/api/projects', {
  method: 'POST',
  body: JSON.stringify({ name: `E2E ${stamp}`, outline: `- 设计 @林 9/1–9/12 done\n  - 视觉稿 9/1–9/8 done\n- 开发 @王芳 9/8–9/30 in_progress 35%\n  - 前端页面 9/8–9/24 60%\n  - 接口联调 @陈小明 9/15–9/30 blocked 10%\n- ◆ 上线 10/10` }),
});
console.log('project', project.id, 'nodes', nodes.length, 'warnings', warnings.length);
assert(nodes.length === 7, 'project created from outline with 7 nodes');
const api_node = nodes.find((n) => n.title === '接口联调');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));

// 2. login with the real token
await page.goto(WEB + '/login');
await page.getByPlaceholder(/tm_|令牌/).fill(token);
await page.getByRole('button', { name: '登录' }).click();
await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 10000 });
assert(true, 'logged in with real token');

// 3. open the project, wait for nodes
await page.goto(`${WEB}/projects/${project.id}`);
await page.locator('[data-node-id]').first().waitFor({ timeout: 10000 });
await page.waitForTimeout(500);
const count = await page.locator('[data-node-id]').count();
assert(count === 7, `mind map shows ${count} nodes`);

// 4. select 接口联调, Tab to add a child, type a title, Enter
await page.locator(`[data-node-id="${api_node.id}"]`).click();
await page.keyboard.press('Tab');
await page.waitForTimeout(200);
await page.keyboard.type('联调用例');
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
const after = await api(`/api/projects/${project.id}`);
const child = after.nodes.find((n) => n.parentId === api_node.id && n.title === '联调用例');
assert(!!child, 'Tab-created child persisted on the server with typed title');
assert(child.ownerId === api_node.ownerId, 'child inherited the owner');

// 5. Claude (MCP) proposes a due-date change → pending change
const t = new StreamableHTTPClientTransport(new URL(API + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const mcp = new Client({ name: 'live-e2e', version: '0.0.1' });
await mcp.connect(t);
const cur = JSON.parse((await mcp.callTool({ name: 'get_node', arguments: { node_id: api_node.id } })).content[0].text);
const version = cur.node?.version ?? cur.version;
const res = JSON.parse((await mcp.callTool({ name: 'update_node', arguments: { node_id: api_node.id, version, patch: { due_date: '2026-10-05', title: '接口联调（改）' }, reason: '后端接口 9/28 才出' } })).content[0].text);
console.log('mcp update_node →', JSON.stringify(res).slice(0, 160));
assert(res.status === 'pending' || res.status === 'partial', 'due date change from Claude is held for confirmation');
const pending = await api('/api/changes?status=pending');
const ch = pending.find((c) => c.nodeId === api_node.id && c.field === 'dueDate');
assert(!!ch, 'pending change visible via API');
const afterTitle = (await api(`/api/projects/${project.id}`)).nodes.find((n) => n.id === api_node.id);
assert(afterTitle.title === '接口联调（改）', 'non-key field (title) applied directly');
assert(afterTitle.dueDate === '2026-09-30', 'due date NOT applied yet');

// 6. web shows the pending change (realtime) and approves it
await page.waitForTimeout(800);
const badge = page.getByText(/待确认\s*1/);
await badge.first().waitFor({ timeout: 8000 });
assert(true, 'web shows 待确认 1 via realtime');
await page.locator(`[data-node-id="${api_node.id}"]`).click();
await page.waitForTimeout(500);
await page.getByRole('button', { name: '确认', exact: true }).first().click();
await page.waitForTimeout(1500);
const done = (await api(`/api/projects/${project.id}`)).nodes.find((n) => n.id === api_node.id);
assert(done.dueDate === '2026-10-05', 'approving in the web applied the due date');
const stillPending = (await api('/api/changes?status=pending')).filter((c) => c.nodeId === api_node.id);
assert(stillPending.length === 0, 'no pending change left');

// 7. today + outline via MCP reflect the state
const outline = (await mcp.callTool({ name: 'get_tree', arguments: { project_id: project.id, format: 'outline' } })).content[0].text;
assert(outline.includes('接口联调（改）') && outline.includes('10/5'), 'MCP outline reflects approved change');
await mcp.close();

await page.getByRole('button', { name: '适应' }).click().catch(() => {});
await page.waitForTimeout(300);
await page.screenshot({ path: 'e2e/out/live.png' });
await browser.close();
console.log('ALL OK');
