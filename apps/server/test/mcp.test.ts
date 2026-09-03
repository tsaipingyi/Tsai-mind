import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { TNode } from '@tsai-mind/core';
import { SAMPLE_OUTLINE, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${s.baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): string {
  const r = result as { content: { type: string; text?: string }[] };
  return r.content.map((c) => c.text ?? '').join('');
}
const jsonOf = <T = unknown>(result: unknown): T => JSON.parse(textOf(result)) as T;

beforeAll(async () => {
  s = await startTestServer();
});
afterAll(async () => {
  await s.close();
});
beforeEach(async () => {
  await s.reset();
});

describe('MCP over Streamable HTTP', () => {
  it('rejects a bad token', async () => {
    const client = new Client({ name: 't', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${s.baseUrl}/mcp`), { requestInit: { headers: { authorization: 'Bearer tm_bad' } } });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('lists the documented tools, resources and prompts', async () => {
    const client = await connect(await s.token(['read', 'write']));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      [
        'list_projects', 'get_tree', 'get_node', 'search_nodes', 'today', 'list_pending_changes', 'get_activity', 'list_contacts', 'contact_workload',
        'create_node', 'update_node', 'move_node', 'delete_node', 'set_owner', 'add_dependency', 'remove_dependency', 'add_note', 'nudge', 'undo',
        'decide_change', 'withdraw_change', 'draft_plan', 'get_plan_batch', 'apply_plan_batch', 'discard_plan_batch', 'create_project', 'create_contact',
      ].sort(),
    );
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain('tsaimind://today');
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toContain('tsaimind://project/{id}/outline');
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual(['nudge_draft', 'weekly_review']);
    await client.close();
  });

  it('creates a project, reads the tree, and update_node on a key field yields a pending change', async () => {
    const client = await connect(await s.token(['read', 'write']));

    const created = jsonOf<{ project: { id: string; rootNodeId: string }; nodeCount: number }>(
      await client.callTool({ name: 'create_project', arguments: { name: '官网改版', outline: SAMPLE_OUTLINE } }),
    );
    expect(created.nodeCount).toBe(7);
    const pid = created.project.id;

    const outline = textOf(await client.callTool({ name: 'get_tree', arguments: { project_id: pid, format: 'outline' } }));
    expect(outline).toContain('- 官网改版 [');
    expect(outline).toContain('接口联调 [');
    const tree = jsonOf<{ nodes: (TNode & { derived: { status: string } })[] }>(await client.callTool({ name: 'get_tree', arguments: { project_id: pid, format: 'json', depth: 2 } }));
    expect(tree.nodes).toHaveLength(4); // root + 3 children at depth 2
    const api = jsonOf<{ nodes: TNode[] }>(await client.callTool({ name: 'get_tree', arguments: { project_id: pid, format: 'json' } })).nodes.find((n) => n.title === '接口联调')!;

    const found = jsonOf<{ node: TNode; path: string[] }[]>(await client.callTool({ name: 'search_nodes', arguments: { query: '联调' } }));
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toEqual(['官网改版', '开发']);

    // key field → pending
    const upd = jsonOf<{ status: string; changeIds: string[]; node: TNode }>(
      await client.callTool({ name: 'update_node', arguments: { node_id: api.id, version: api.version, patch: { due_date: '2026-10-15' }, reason: '后端延误' } }),
    );
    expect(upd.status).toBe('pending');
    expect(upd.changeIds).toHaveLength(1);
    expect(upd.node.dueDate).toBe('2026-09-30');

    const pending = jsonOf<{ id: string; field: string; newValue: string; reason: string }[]>(await client.callTool({ name: 'list_pending_changes', arguments: {} }));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ field: 'dueDate', newValue: '2026-10-15', reason: '后端延误' });

    // also visible through REST
    const rest = await s.api<{ nodeTitle: string }[]>('GET', '/api/changes?status=pending');
    expect(rest.body[0]!.nodeTitle).toBe('接口联调');

    // non-key field → applied
    const upd2 = jsonOf<{ status: string; serverSeq: number; node: TNode }>(
      await client.callTool({ name: 'update_node', arguments: { node_id: api.id, version: api.version, patch: { title: '接口联调 v2', progress: 20 } } }),
    );
    expect(upd2.status).toBe('applied');
    expect(upd2.node.title).toBe('接口联调 v2');

    // stale version → version_conflict error result
    const conflict = await client.callTool({ name: 'update_node', arguments: { node_id: api.id, version: api.version, patch: { title: 'x' } } });
    expect(conflict.isError).toBe(true);
    expect(jsonOf<{ error: string; current: TNode }>(conflict).error).toBe('version_conflict');
    expect(jsonOf<{ error: string; current: TNode }>(conflict).current.version).toBe(api.version + 1);

    // decide requires scope
    const denied = await client.callTool({ name: 'decide_change', arguments: { change_id: upd.changeIds[0], decision: 'approve' } });
    expect(denied.isError).toBe(true);
    expect(jsonOf<{ error: string }>(denied).error).toBe('forbidden');

    // withdraw own proposal
    const withdrawn = jsonOf<{ change: { status: string } }>(await client.callTool({ name: 'withdraw_change', arguments: { change_id: upd.changeIds[0] } }));
    expect(withdrawn.change.status).toBe('expired');

    // create_node + delete (pending) + undo of own op
    const child = jsonOf<{ status: string; serverSeq: number; node: TNode }>(
      await client.callTool({ name: 'create_node', arguments: { parent_id: api.id, title: '埋点', due_date: '2026-09-28' } }),
    );
    expect(child.status).toBe('applied');
    expect(child.node.parentId).toBe(api.id);
    const del = jsonOf<{ status: string; changeIds: string[] }>(await client.callTool({ name: 'delete_node', arguments: { node_id: child.node.id, version: child.node.version } }));
    expect(del.status).toBe('pending');
    const undone = jsonOf<{ undoneSeq: number; results: { ok: boolean }[] }>(await client.callTool({ name: 'undo', arguments: { server_seq: child.serverSeq } }));
    expect(undone.results[0]!.ok).toBe(true);
    const node = await client.callTool({ name: 'get_node', arguments: { node_id: child.node.id } });
    expect(node.isError).toBe(true);

    // resources & prompt
    const today = await client.readResource({ uri: 'tsaimind://today' });
    expect(JSON.parse((today.contents[0] as { text: string }).text)).toHaveProperty('overdue');
    const res = await client.readResource({ uri: `tsaimind://project/${pid}/outline` });
    expect((res.contents[0] as { text: string }).text).toContain('官网改版');
    const prompt = await client.getPrompt({ name: 'weekly_review', arguments: { project_id: pid } });
    expect(prompt.messages[0]!.content).toMatchObject({ type: 'text' });

    await client.close();
  });

  it('draft_plan produces a batch that only decide-scoped tokens can apply', async () => {
    const rw = await connect(await s.token(['read', 'write']));
    const created = jsonOf<{ project: { id: string; rootNodeId: string } }>(await rw.callTool({ name: 'create_project', arguments: { name: 'Q4' } }));
    const draft = jsonOf<{ batch_id: string; summary: { create: number }; preview_url: string }>(
      await rw.callTool({ name: 'draft_plan', arguments: { project_id: created.project.id, parent_id: created.project.rootNodeId, outline: '- ◆ 十月里程碑 10/31\n  - 任务一\n  - 任务二', mode: 'append' } }),
    );
    expect(draft.summary.create).toBe(3);
    const denied = await rw.callTool({ name: 'apply_plan_batch', arguments: { batch_id: draft.batch_id } });
    expect(denied.isError).toBe(true);
    await rw.close();

    const decider = await connect(await s.token(['read', 'write', 'decide']));
    const applied = jsonOf<{ batch: { status: string }; results: { ok: boolean }[] }>(await decider.callTool({ name: 'apply_plan_batch', arguments: { batch_id: draft.batch_id } }));
    expect(applied.batch.status).toBe('applied');
    expect(applied.results.every((r) => r.ok)).toBe(true);
    const tree = jsonOf<{ nodes: TNode[] }>(await decider.callTool({ name: 'get_tree', arguments: { project_id: created.project.id, format: 'json' } }));
    expect(tree.nodes.map((n) => n.title)).toContain('任务二');
    await decider.close();
  });

  it('nudge, notes, dependencies, contacts', async () => {
    const client = await connect(await s.token(['read', 'write']));
    const contact = jsonOf<{ id: string }>(await client.callTool({ name: 'create_contact', arguments: { name: '陈小明', company: 'ACME' } }));
    const created = jsonOf<{ project: { id: string; rootNodeId: string } }>(await client.callTool({ name: 'create_project', arguments: { name: 'P', outline: '- a @陈小明 9/30 in_progress 10%\n- b' } }));
    const nodes = jsonOf<{ nodes: TNode[] }>(await client.callTool({ name: 'get_tree', arguments: { project_id: created.project.id, format: 'json' } })).nodes;
    const a = nodes.find((n) => n.title === 'a')!;
    const b = nodes.find((n) => n.title === 'b')!;
    expect(a.ownerId).toBe(contact.id);

    const nudged = jsonOf<{ text: string }>(await client.callTool({ name: 'nudge', arguments: { node_id: a.id } }));
    expect(nudged.text).toBe('关于「a」，原定 9/30，现在进度 10%，方便同步一下进展吗？');

    await client.callTool({ name: 'add_note', arguments: { node_id: a.id, body: '等后端接口' } });
    await client.callTool({ name: 'add_dependency', arguments: { from_node_id: a.id, to_node_id: b.id } });
    const detail = jsonOf<{ notes: { body: string; actor: string }[]; blocks: { id: string }[]; activity: { kind: string }[] }>(await client.callTool({ name: 'get_node', arguments: { node_id: a.id } }));
    expect(detail.notes[0]).toMatchObject({ body: '等后端接口', actor: 'claude' });
    expect(detail.blocks.map((x) => x.id)).toEqual([b.id]);
    expect(detail.activity.map((x) => x.kind)).toContain('nudged');

    const outline = textOf(await client.callTool({ name: 'get_tree', arguments: { project_id: created.project.id, format: 'outline' } }));
    expect(outline).toContain('- b [');
    expect(outline).toContain('← a');

    const workload = jsonOf<{ nodes: { node: TNode }[] }>(await client.callTool({ name: 'contact_workload', arguments: { contact_id: contact.id } }));
    expect(workload.nodes.map((n) => n.node.title)).toEqual(['a']);

    const owner = jsonOf<{ status: string }>(await client.callTool({ name: 'set_owner', arguments: { node_id: b.id, version: b.version, contact_id: contact.id } }));
    expect(owner.status).toBe('pending');
    await client.close();
  });
});
