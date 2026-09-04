import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TNode } from '@tsai-mind/core';
import { scriptedClient, type BetaContentBlock, type BetaTextBlockParam } from '../src/assistant/client.js';
import { MAX_TOOL_ROUNDS } from '../src/assistant/service.js';
import { SAMPLE_OUTLINE, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let token: string;

type ProjectRes = { project: { id: string; rootNodeId: string }; nodes: TNode[] };
type SseEvent = { event: string; data: Record<string, unknown> };

const text = (t: string): BetaContentBlock => ({ type: 'text', text: t, citations: null } as BetaContentBlock);
const toolUse = (id: string, name: string, input: unknown): BetaContentBlock => ({ type: 'tool_use', id, name, input } as BetaContentBlock);

async function createProject() {
  const r = await s.api<ProjectRes>('POST', '/api/projects', { body: { name: '官网改版', outline: SAMPLE_OUTLINE }, token });
  expect(r.status).toBe(201);
  return r.body;
}

/** POST a message and parse the SSE stream into events. */
async function chat(sessionId: string, body: { text: string; projectId?: string }, t = token): Promise<{ status: number; events: SseEvent[]; contentType: string }> {
  const res = await fetch(`${s.baseUrl}/api/assistant/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const events: SseEvent[] = [];
  if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
    for (const block of raw.split('\n\n')) {
      if (!block.trim()) continue;
      const ev = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '{}';
      events.push({ event: ev, data: JSON.parse(data) });
    }
  } else events.push({ event: 'http', data: JSON.parse(raw) });
  return { status: res.status, events, contentType: res.headers.get('content-type') ?? '' };
}

beforeAll(async () => {
  s = await startTestServer();
});
afterAll(async () => {
  await s.close();
});
beforeEach(async () => {
  await s.reset();
  token = await s.token(['read', 'write', 'decide']);
});

describe('assistant status', () => {
  it('reports unconfigured and refuses to chat without a client', async () => {
    const st = await s.api<{ configured: boolean; model: string }>('GET', '/api/assistant/status', { token });
    expect(st.body).toEqual({ configured: false, model: 'claude-opus-5' });
    const session = await s.api<{ id: string }>('POST', '/api/assistant/sessions', { token, body: {} });
    expect(session.status).toBe(201);
    const r = await chat(session.body.id, { text: '你好' });
    expect(r.status).toBe(503);
    expect(r.events[0]!.data).toEqual({ error: 'assistant_unconfigured', message: '未配置 ANTHROPIC_API_KEY' });

    s.useClaude(scriptedClient([]));
    expect((await s.api<{ configured: boolean }>('GET', '/api/assistant/status', { token })).body.configured).toBe(true);
  });
});

describe('assistant conversation', () => {
  it('streams text, runs a tool through the registry (key field → pending change) and persists the turn', async () => {
    const p = await createProject();
    const api = p.nodes.find((n) => n.title === '接口联调')!;
    const client = scriptedClient([
      [text('我看一下接口联调。'), toolUse('toolu_1', 'update_node', { node_id: api.id, version: api.version, patch: { due_date: '2026-10-15' }, reason: '后端延误' })],
      [text('已经提议把「接口联调」的截止日改到 10/15，等你在手机上确认。')],
    ]);
    s.useClaude(client);

    const session = await s.api<{ id: string; projectId: string | null; title: string | null }>('POST', '/api/assistant/sessions', { token, body: { projectId: p.project.id } });
    expect(session.body.projectId).toBe(p.project.id);
    expect(session.body.title).toBeNull();

    const r = await chat(session.body.id, { text: '接口联调要延到 10 月 15 号，帮我改一下' });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/event-stream');
    const kinds = r.events.map((e) => e.event);
    expect(kinds[0]).toBe('text');
    expect(kinds).toContain('tool');
    expect(kinds[kinds.length - 1]).toBe('done');
    expect(kinds).not.toContain('error');

    const streamed = r.events.filter((e) => e.event === 'text').map((e) => e.data.delta as string).join('');
    expect(streamed).toBe('我看一下接口联调。\n\n已经提议把「接口联调」的截止日改到 10/15，等你在手机上确认。');
    const done = r.events.find((e) => e.event === 'done')!.data as { messageId: string; text: string };
    expect(done.text).toBe(streamed);
    expect(done.messageId).toMatch(/^[0-9a-f-]{36}$/);

    const toolEv = r.events.find((e) => e.event === 'tool')!.data as { name: string; input: Record<string, unknown>; result: { status: string; changeIds: string[] } };
    expect(toolEv.name).toBe('update_node');
    expect(toolEv.input.node_id).toBe(api.id);
    expect(toolEv.result.status).toBe('pending');
    expect(toolEv.result.changeIds).toHaveLength(1);

    // the change went through the same path as MCP: pending row, node untouched, push sent as "change"
    const pending = await s.api<{ field: string; newValue: string; reason: string; source: string }[]>('GET', '/api/changes?status=pending', { token });
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]).toMatchObject({ field: 'dueDate', newValue: '2026-10-15', reason: '后端延误', source: 'claude' });

    // what Claude was sent: system prompt with date, rules, outline and a cache breakpoint; scope-filtered tools; history round-trip
    expect(client.requests).toHaveLength(2);
    const first = client.requests[0]!;
    expect(first.model).toBe('claude-opus-5');
    const sys = first.system as BetaTextBlockParam[];
    expect(sys).toHaveLength(1);
    expect(sys[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[0]!.text).toContain('今天是 ');
    expect(sys[0]!.text).toContain('待确认');
    expect(sys[0]!.text).toContain(`- 官网改版 [${p.project.rootNodeId}]`);
    expect(sys[0]!.text).toContain(`接口联调 [${api.id}]`);
    const toolNames = (first.tools ?? []).map((t) => (t as { name: string }).name);
    expect(toolNames).toContain('update_node');
    expect(toolNames).toContain('decide_change');
    expect(toolNames).toHaveLength(27);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]!.role).toBe('user');
    const second = client.requests[1]!;
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const results = second.messages[2]!.content as { type: string; tool_use_id: string; content: string }[];
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(JSON.parse(results[0]!.content).status).toBe('pending');

    // persisted: title from the first message, listing, and the rendered transcript
    const list = await s.api<{ id: string; title: string; projectId: string; lastText: string }[]>('GET', '/api/assistant/sessions', { token });
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: session.body.id, title: '接口联调要延到 10 月 15 号，帮我改一下', projectId: p.project.id });
    expect(list.body[0]!.lastText).toBe(done.text);

    const detail = await s.api<{ session: { id: string }; messages: { id: string; role: string; text: string; toolCalls: { name: string; input: Record<string, unknown>; resultText: string; isError: boolean }[] }[] }>(
      'GET', `/api/assistant/sessions/${session.body.id}`, { token },
    );
    expect(detail.body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.body.messages[0]!.text).toBe('接口联调要延到 10 月 15 号，帮我改一下');
    expect(detail.body.messages[0]!.toolCalls).toEqual([]);
    const reply = detail.body.messages[1]!;
    expect(reply.id).toBe(done.messageId);
    expect(reply.text).toBe(done.text);
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0]!.name).toBe('update_node');
    expect(reply.toolCalls[0]!.isError).toBe(false);
    expect(JSON.parse(reply.toolCalls[0]!.resultText).status).toBe('pending');

    // a second turn replays the whole transcript (tool_use / tool_result split into API turns)
    const client2 = scriptedClient([[text('好的。')]]);
    s.useClaude(client2);
    const r2 = await chat(session.body.id, { text: '谢谢' });
    expect(r2.events.map((e) => e.event)).toEqual(['text', 'done']);
    expect(client2.requests[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect((await s.api<unknown[]>('GET', `/api/assistant/sessions/${session.body.id}`, { token })).body).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ text: '好的。' })]) });

    // delete
    expect((await s.api('DELETE', `/api/assistant/sessions/${session.body.id}`, { token })).status).toBe(200);
    expect((await s.api('GET', `/api/assistant/sessions/${session.body.id}`, { token })).status).toBe(404);
  });

  it('only offers tools the token can run, and reports tool errors back to Claude', async () => {
    const p = await createProject();
    const api = p.nodes.find((n) => n.title === '接口联调')!;
    const client = scriptedClient([
      [toolUse('toolu_x', 'update_node', { node_id: api.id, version: api.version + 5, patch: { title: 'x' } })],
      [text('版本不对，我再读一次。')],
    ]);
    s.useClaude(client);
    const rw = await s.token(['read', 'write']);
    const session = await s.api<{ id: string }>('POST', '/api/assistant/sessions', { token: rw, body: {} });
    const r = await chat(session.body.id, { text: '改标题', projectId: p.project.id }, rw);
    const tool = r.events.find((e) => e.event === 'tool')!.data as { result: { error: string } };
    expect(tool.result.error).toBe('version_conflict');
    const names = (client.requests[0]!.tools ?? []).map((t) => (t as { name: string }).name);
    expect(names).not.toContain('decide_change');
    expect(names).not.toContain('apply_plan_batch');
    expect(names).toContain('update_node');
    const results = client.requests[1]!.messages[2]!.content as { is_error?: boolean }[];
    expect(results[0]!.is_error).toBe(true);
    const detail = await s.api<{ messages: { toolCalls: { isError: boolean }[] }[] }>('GET', `/api/assistant/sessions/${session.body.id}`, { token: rw });
    expect(detail.body.messages[1]!.toolCalls[0]!.isError).toBe(true);
    // session picked up the project from the message
    expect((await s.api<{ session: { projectId: string } }>('GET', `/api/assistant/sessions/${session.body.id}`, { token: rw })).body.session.projectId).toBe(p.project.id);

    // read-only token: no write tools at all
    const ro = await s.token(['read']);
    const client2 = scriptedClient([[text('只能看。')]]);
    s.useClaude(client2);
    const session2 = await s.api<{ id: string }>('POST', '/api/assistant/sessions', { token: ro, body: {} });
    await chat(session2.body.id, { text: '看看' }, ro);
    const names2 = (client2.requests[0]!.tools ?? []).map((t) => (t as { name: string }).name);
    expect(names2).not.toContain('update_node');
    expect(names2).toContain('get_tree');
  });

  it('stops after the tool round cap and keeps the transcript valid', async () => {
    const turns = Array.from({ length: MAX_TOOL_ROUNDS + 1 }, (_v, i) => [toolUse(`toolu_${i}`, 'today', {})]);
    const client = scriptedClient(turns);
    s.useClaude(client);
    const session = await s.api<{ id: string }>('POST', '/api/assistant/sessions', { token, body: {} });
    const r = await chat(session.body.id, { text: '循环' });
    expect(r.events.filter((e) => e.event === 'tool')).toHaveLength(MAX_TOOL_ROUNDS);
    expect(client.requests).toHaveLength(MAX_TOOL_ROUNDS + 1);
    const done = r.events.find((e) => e.event === 'done')!.data as { text: string };
    expect(done.text).toContain(`${MAX_TOOL_ROUNDS} 次工具`);
    // next turn: every tool_use has a tool_result, so the replayed history alternates cleanly
    const client2 = scriptedClient([[text('继续。')]]);
    s.useClaude(client2);
    await chat(session.body.id, { text: '继续' });
    const roles = client2.requests[0]!.messages.map((m) => m.role);
    for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1]);
  });

  it('surfaces API failures as an error event and requires text', async () => {
    s.useClaude({
      stream: async () => {
        throw new Error('boom');
      },
      create: async () => {
        throw new Error('boom');
      },
    });
    const session = await s.api<{ id: string }>('POST', '/api/assistant/sessions', { token, body: {} });
    const r = await chat(session.body.id, { text: '你好' });
    expect(r.events.map((e) => e.event)).toEqual(['error']);
    expect(r.events[0]!.data.message).toBe('boom');
    expect((await chat(session.body.id, { text: '' })).status).toBe(400);
    expect((await s.api('GET', '/api/assistant/sessions/00000000-0000-0000-0000-000000000000', { token })).status).toBe(404);
  });
});
