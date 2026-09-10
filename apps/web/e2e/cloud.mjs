// Smoke check for the single-file cloud build (dist-cloud/index.html): the page is served by a tiny
// static server and gets a fake `window.claude` (db persisted to localStorage, a scripted `sample`,
// a recording `downloads`) via page.addInitScript — the same shapes the artifact runtime provides.
// Usage (from apps/web, after `pnpm build:cloud`): node e2e/cloud.mjs
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../dist-cloud/index.html'));

const assert = (cond, msg) => {
  if (!cond) throw new Error('ASSERT: ' + msg);
  console.log('ok  ', msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- static server ----
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;

// ---- the fake runtime (runs in the page before any script) ----
function fakeClaude(cfg) {
  const KEY = 'fakedb.docs';
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {
      return {};
    }
  };
  const docs = load();
  const persist = () => localStorage.setItem(KEY, JSON.stringify(docs));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const listeners = new Set();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const inCol = (col, path) => path.startsWith(col + '/') && !path.slice(col.length + 1).includes('/');
  const colDocs = (col) => Object.keys(docs).filter((p) => inCol(col, p)).sort();
  const docSnap = (path, pending, dataOverride) => {
    const data = dataOverride !== undefined ? dataOverride : docs[path];
    return { id: path.split('/').pop(), exists: data !== undefined, data: () => clone(data), metadata: { fromCache: false, hasPendingWrites: pending } };
  };
  const colSnap = (l, pending, changedPath, removedData) => {
    const ids = colDocs(l.path);
    const prev = l.prev || new Set();
    const snaps = ids.map((p) => docSnap(p, pending));
    const changes = [];
    ids.forEach((p, i) => {
      if (!prev.has(p)) changes.push({ type: 'added', doc: snaps[i], oldIndex: -1, newIndex: i });
      else if (p === changedPath) changes.push({ type: 'modified', doc: snaps[i], oldIndex: i, newIndex: i });
    });
    for (const p of prev) if (!ids.includes(p)) changes.push({ type: 'removed', doc: docSnap(p, pending, removedData || {}), oldIndex: 0, newIndex: -1 });
    l.prev = new Set(ids);
    return { docs: snaps, size: snaps.length, empty: !snaps.length, docChanges: () => changes, metadata: { fromCache: false, hasPendingWrites: pending } };
  };
  const notify = (path, pending, removedData) => {
    for (const l of listeners) {
      try {
        if (l.kind === 'doc' && l.path === path) l.next(docSnap(path, pending));
        else if (l.kind === 'col' && inCol(l.path, path)) l.next(colSnap(l, pending, path, removedData));
      } catch (e) {
        console.error('fake db listener threw', e);
      }
    }
  };
  const write = async (path, data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw { code: 'invalid_argument', message: 'body must be an object' };
    const s = JSON.stringify(data);
    if (s.length > 256 * 1024) throw { code: 'invalid_argument', message: 'document over 256 KiB' };
    window.__dbWrites.push({ path, bytes: s.length });
    docs[path] = JSON.parse(s);
    persist();
    notify(path, true);
    await wait(5);
    notify(path, false);
  };
  const doc = (path) => {
    if (path.split('/').length % 2 !== 0) throw new TypeError('document path needs an even number of segments: ' + path);
    return {
      id: path.split('/').pop(),
      path,
      get: async () => {
        await wait(3);
        return docSnap(path, false);
      },
      set: (data) => write(path, data),
      update: async (data) => {
        if (docs[path] === undefined) throw { code: 'invalid_argument', message: 'no such document' };
        return write(path, { ...docs[path], ...data });
      },
      delete: async () => {
        const old = docs[path];
        delete docs[path];
        persist();
        notify(path, true, old);
        await wait(5);
        notify(path, false, old);
      },
      onSnapshot: (next) => {
        const l = { kind: 'doc', path, next };
        listeners.add(l);
        setTimeout(() => listeners.has(l) && next(docSnap(path, false)), 5);
        return () => listeners.delete(l);
      },
      collection: (sub) => collection(path + '/' + sub),
    };
  };
  const collection = (path) => {
    if (path.split('/').length % 2 !== 1) throw new TypeError('collection path needs an odd number of segments: ' + path);
    const q = {
      path,
      doc: (id) => doc(path + '/' + (id || Math.random().toString(36).slice(2, 12))),
      add: (data) => q.doc().set(data),
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      get: async () => {
        await wait(3);
        return colSnap({ path }, false);
      },
      onSnapshot: (next) => {
        const l = { kind: 'col', path, next };
        listeners.add(l);
        setTimeout(() => listeners.has(l) && next(colSnap(l, false)), 5);
        return () => listeners.delete(l);
      },
    };
    return q;
  };
  const db = { doc, collection };
  // test hook: "another device" wrote this document (delivered confirmed, no pending write)
  window.__fakeDb = {
    docs,
    externalSet: (path, data) => {
      docs[path] = clone(data);
      persist();
      notify(path, false);
    },
    externalDelete: (path) => {
      const old = docs[path];
      delete docs[path];
      persist();
      notify(path, false, old);
    },
  };
  window.__dbWrites = [];

  // ---- sample: streams a scripted answer, calls update_node once, finishes ----
  window.__sampleCalls = [];
  const sample = async (input, opts = {}) => {
    window.__sampleCalls.push({ input, tools: (opts.tools || []).map((t) => t.name), cache: opts.cache, modelTier: opts.modelTier });
    if (opts.cache !== false && opts.tools) throw { code: 'invalid_request', message: 'cache must be false with tools' };
    const turns = Array.isArray(input) ? input : [{ role: 'user', content: input }];
    if (turns[0].role !== 'user' || turns[turns.length - 1].role !== 'user') throw { code: 'invalid_request', message: 'turns must start and end on a user turn' };
    let text = '';
    const say = async (delta) => {
      await wait(25);
      if (opts.signal?.aborted) throw { code: 'cancelled', message: 'aborted', text };
      text += delta;
      opts.onText?.({ text, delta });
    };
    await wait(40);
    await say('好的，');
    const tool = (opts.tools || []).find((t) => t.name === 'update_node');
    if (tool) {
      const instr = turns[0].content;
      const ids = [...instr.matchAll(/\[([^\]\s]+)\]/g)].map((m) => m[1]);
      const nodeId = ids[1] || ids[0];
      const due = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
      const result = await tool.execute({ node_id: nodeId, patch: { due_date: due }, reason: '按你的要求顺延' }, { signal: new AbortController().signal }).catch((e) => ({ error: String(e?.message ?? e) }));
      window.__lastToolResult = result;
      await say(`我把第一个任务的截止日改到了 ${due}。`);
      await say('\n\n- 这条改动进了「待确认」，去确认一下');
    } else await say('（这次没有工具可用）我只能给建议。');
    return { text, truncated: false, modelTierApplied: opts.modelTier || 'default' };
  };
  sample.limits = async () => ({ maxPromptBytes: 65536, tools: { maxCount: 16 } });
  sample.json = async (input, opts) => JSON.parse((await sample(input, opts)).text);

  // ---- downloads ----
  window.__downloads = [];
  const downloads = {
    save: async ({ filename, data }) => {
      window.__downloads.push({ filename, size: typeof data === 'string' ? data.length : -1, head: typeof data === 'string' ? data.slice(0, 60) : '' });
      return { status: 'saved' };
    },
  };

  const ns = { db, sample, downloads };
  const memo = new Map();
  window.claude = {
    use: (name) => {
      if (!memo.has(name)) memo.set(name, new Promise((r) => setTimeout(() => r(cfg[name] === false ? null : (ns[name] ?? null)), 40)));
      return memo.get(name);
    },
  };
}

// ---- helpers ----
const cloudState = (page) => page.evaluate(() => window.tsaimindCloud?.status().state);
const waitState = async (page, want, timeout = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await cloudState(page);
    if (s === want) return;
    if (Date.now() - t0 > timeout) throw new Error(`cloud state is ${s}, wanted ${want}`);
    await sleep(100);
  }
};
const settled = async (page) => {
  // wait for pending writes to land (debounce 400 ms + fake latency)
  await sleep(700);
  await waitState(page, 'ready', 5000);
};
const badgeCount = async (page) => {
  const t = (await page.getByTestId('pending-toggle').innerText()).replace(/\s+/g, '');
  const m = /待确认(\d+)/.exec(t);
  return m ? Number(m[1]) : 0;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const consoleErrors = [];
const attach = (page) => {
  page.on('console', (m) => {
    if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)\.com/.test(m.location()?.url ?? '')) consoleErrors.push(`${m.text()} @ ${m.location()?.url ?? ''}`);
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => {
    if (!/fonts\.(googleapis|gstatic)\.com/.test(r.url())) consoleErrors.push('requestfailed: ' + r.url());
  });
};

let context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(fakeClaude, { db: true });
let page = await context.newPage();
attach(page);

try {
  // ---- first run: empty store → starter project, status ready, no demo banner ----
  await page.goto(URL_);
  await waitState(page, 'ready');
  assert(true, 'status reaches ready');
  await page.getByRole('heading', { name: '今天', exact: true }).waitFor({ timeout: 15000 });
  assert(!(await page.locator('.demo-banner').isVisible().catch(() => false)), 'demo banner hidden in cloud mode');
  const pill = page.locator('[data-testid="cloud-status"]').first();
  assert(await pill.isVisible(), `status pill visible: ${(await pill.innerText()).trim()}`);
  await settled(page);
  const writes = await page.evaluate(() => window.__dbWrites.map((w) => w.path));
  assert(writes.includes('meta/account') && writes.some((p) => p.startsWith('projects/')), `first run wrote meta/account + a project doc (${writes.join(', ')})`);
  const accountDoc = await page.evaluate(() => window.__fakeDb.docs['meta/account']);
  assert(accountDoc.firstRun === true && accountDoc.account?.name === '蔡', 'meta/account has firstRun=true and the seed name');

  await page.getByRole('link', { name: '项目' }).click();
  await page.getByText('我的第一个项目').first().waitFor();
  assert(true, 'project list shows the starter project 我的第一个项目');
  await page.getByText('我的第一个项目').first().click();
  await page.locator('.mm-node').first().waitFor();
  await page.waitForTimeout(300);
  const nodesBefore = await page.locator('.mm-node').count();
  assert(nodesBefore === 4, `starter project has root + 3 nodes (${nodesBefore})`);
  const projectId = /projects\/([^/?#]+)/.exec(page.url())?.[1];
  assert(!!projectId, `project id from url: ${projectId}`);

  // ---- create a node via Tab, then reload → persisted ----
  await page.locator('.mm-node').nth(1).click();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  assert((await page.locator('.mm-node').count()) === nodesBefore + 1, 'Tab created a child node');
  await page.keyboard.type('云端节点');
  await page.keyboard.press('Enter');
  await settled(page);
  assert(await page.evaluate(() => JSON.stringify(window.__fakeDb.docs).includes('云端节点')), 'new node title is in the persisted project doc');
  const firstRunAfter = await page.evaluate(() => window.__fakeDb.docs['meta/account'].firstRun);
  assert(firstRunAfter === false, 'firstRun flipped to false after the first edit');

  await page.reload();
  await waitState(page, 'ready');
  await page.locator('.mm-node').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  assert((await page.locator('.mm-node').count()) === nodesBefore + 1, 'after reload the created node is still there (persistence)');
  assert(await page.locator('.mm-node', { hasText: '云端节点' }).first().isVisible(), 'node title survived the reload');
  const writesAfterReload = await page.evaluate(() => window.__dbWrites.length);
  await sleep(900);
  assert((await page.evaluate(() => window.__dbWrites.length)) === writesAfterReload, 'a plain reload writes nothing back (no-op writes skipped)');

  // ---- Claude via sample: streams, tool chip, pending change, approve ----
  const badgeBefore = await badgeCount(page);
  await page.getByTestId('chat-toggle').click();
  const panel = page.getByTestId('chat-panel');
  await panel.waitFor();
  await panel.getByText('claude.ai 内置').waitFor({ timeout: 10000 });
  assert(true, 'assistant status shows the claude.ai model label');
  await panel.getByLabel('消息').fill('把第一个任务延后一周');
  await panel.getByLabel('消息').press('Enter');
  await panel.getByTestId('tool-chip').waitFor({ timeout: 15000 });
  const chipLabel = await panel.locator('.tool-chip-label').first().innerText();
  assert(chipLabel.includes('update_node') && chipLabel.includes('待确认'), `tool chip: ${chipLabel}`);
  await page.waitForTimeout(800);
  const reply = await panel.locator('.chat-md').last().innerText();
  assert(reply.includes('截止日'), `streamed reply rendered: ${reply.slice(0, 40)}…`);
  const call = await page.evaluate(() => window.__sampleCalls[0]);
  assert(call.cache === false && call.modelTier === 'default' && call.tools.includes('get_tree') && call.tools.includes('update_node'), `sample called with cache:false, tools (${call.tools.length})`);
  assert(Array.isArray(call.input) && call.input[0].role === 'user' && call.input[0].content.includes('今天是') && call.input[0].content.includes('我的第一个项目'), 'leading user turn carries instructions + outline');
  assert(call.input[call.input.length - 1].content === '把第一个任务延后一周', 'last turn is the new user message');
  const toolResult = await page.evaluate(() => window.__lastToolResult);
  assert(toolResult && toolResult.status === 'pending', `update_node result is pending: ${JSON.stringify(toolResult).slice(0, 80)}`);
  const badgeAfter = await badgeCount(page);
  assert(badgeAfter === badgeBefore + 1, `待确认 badge incremented to ${badgeAfter}`);
  await settled(page);
  const chatDocs = await page.evaluate(() => Object.keys(window.__fakeDb.docs).filter((k) => k.startsWith('chats/')));
  assert(chatDocs.length === 1, 'chat session persisted as chats/<id>');
  const chatDoc = await page.evaluate((k) => window.__fakeDb.docs[k], chatDocs[0]);
  assert(chatDoc.messages.length === 2 && chatDoc.messages[1].toolCalls?.length === 1, 'user + assistant messages (with the tool call) stored in the chat doc');
  await page.screenshot({ path: 'e2e/out/cloud-chat.png' });
  await page.keyboard.press('Escape');

  // approve from the pending panel → change applied, badge decremented
  await page.getByTestId('pending-toggle').click();
  const pp = page.getByTestId('pending-panel');
  await pp.waitFor();
  await pp.getByRole('button', { name: '确认', exact: true }).first().click();
  await page.getByText('已确认 1 项').waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  assert((await badgeCount(page)) === badgeAfter - 1, '待确认 badge decremented after approval');
  await pp.getByRole('button', { name: '关闭' }).click();
  await settled(page);
  const pdoc = await page.evaluate((id) => window.__fakeDb.docs['projects/' + id], projectId);
  assert(pdoc.changes.some((c) => c.status === 'approved') && pdoc.nodes.some((n) => n.dueDate), 'approved change + due date persisted in the project doc');
  assert(Array.isArray(pdoc.opLog) && pdoc.opLog.length > 0 && pdoc.opLog.every((e) => 'inverse' in e), 'opLog with inverses persisted');

  // ---- export → downloads.save ----
  const exported = await page.evaluate((id) => window.tsaimindCloud.exportOutline(id), projectId);
  const dl = await page.evaluate(() => window.__downloads);
  assert(exported === true && dl.length === 1 && dl[0].filename === '我的第一个项目.md' && dl[0].size > 20, `export called downloads.save(${dl[0]?.filename}, ${dl[0]?.size} chars)`);

  // ---- cross-device: a confirmed newer snapshot replaces the in-memory project ----
  await page.evaluate(() => {
    window.__events = [];
    window.addEventListener('tsaimind:project-changed', (e) => window.__events.push(e.detail));
  });
  await page.evaluate((id) => {
    const d = JSON.parse(JSON.stringify(window.__fakeDb.docs['projects/' + id]));
    const n = d.nodes.find((x) => x.title === '云端节点');
    n.title = '另一台设备改的';
    n.version += 1;
    d.serverSeq += 1;
    d.updatedAt = new Date(Date.now() + 1000).toISOString();
    window.__fakeDb.externalSet('projects/' + id, d);
  }, projectId);
  await page.locator('.mm-node', { hasText: '另一台设备改的' }).first().waitFor({ timeout: 5000 });
  const events = await page.evaluate(() => window.__events);
  assert(events.length === 1 && events[0].projectId === projectId, 'tsaimind:project-changed fired once and the map shows the remote edit');

  await page.getByTitle('适应窗口').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/out/cloud.png' });

  // settings → PATCH /api/me → meta/account written
  await page.getByRole('link', { name: '设置' }).click();
  await page.getByTestId('settings').waitFor();
  await page.getByTestId('settings').getByLabel('名字').fill('蔡先生');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('设置已保存').waitFor();
  await settled(page);
  assert((await page.evaluate(() => window.__fakeDb.docs['meta/account'].account.name)) === '蔡先生', 'PATCH /api/me persisted to meta/account');

  await page.close();
  await context.close();

  // ---- offline: use('db') resolves null → in-memory only, app still works ----
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(fakeClaude, { db: false });
  page = await context.newPage();
  attach(page);
  await page.goto(URL_);
  await waitState(page, 'offline');
  const off = await page.evaluate(() => window.tsaimindCloud.status());
  assert(off.message && off.message.includes('刷新就没了'), `offline message: ${off.message}`);
  const pillText = (await page.locator('[data-testid="cloud-status"]').first().innerText()).trim();
  assert(/离线/.test(pillText), `status pill says offline: ${pillText}`);
  await page.getByRole('link', { name: '项目' }).click();
  await page.getByText('我的第一个项目').first().click();
  await page.locator('.mm-node').first().waitFor();
  await page.waitForTimeout(300);
  const offBefore = await page.locator('.mm-node').count();
  await page.locator('.mm-node').nth(1).click();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  assert((await page.locator('.mm-node').count()) === offBefore + 1, 'offline: editing still works in memory');
  await page.keyboard.press('Escape');
  await page.getByTestId('chat-toggle').click();
  await page.getByTestId('chat-panel').getByLabel('消息').fill('你好');
  await page.getByTestId('chat-panel').getByLabel('消息').press('Enter');
  await page.getByTestId('chat-panel').getByTestId('tool-chip').waitFor({ timeout: 15000 });
  assert(true, 'offline: Claude (sample) still answers');
  await page.screenshot({ path: 'e2e/out/cloud-offline.png' });

  assert(consoleErrors.length === 0, `zero console errors (${consoleErrors.length ? consoleErrors.join(' | ') : 'clean'})`);
  console.log('\nCLOUD SMOKE PASSED');
} catch (e) {
  await page.screenshot({ path: 'e2e/out/cloud-failure.png' }).catch(() => undefined);
  console.error('\nCLOUD SMOKE FAILED:', e.message);
  if (consoleErrors.length) console.error('console errors:', consoleErrors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
