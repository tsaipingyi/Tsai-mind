import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AuthInfo } from './auth.js';
import type { Scope } from './auth.js';
import { HttpError } from './errors.js';
import type { Ctx } from './service/context.js';
import * as q from './service/queries.js';
import { TOOLS, runTool, type AnyTool } from './tools/registry.js';

// ---------- helpers ----------

type ToolExtra = { authInfo?: { scopes: string[]; clientId: string; extra?: Record<string, unknown> } };

const json = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (error: string, message: string, extra: Record<string, unknown> = {}): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error, message, ...extra }, null, 2) }],
});

/** Run a registry tool for an MCP call: scope check, HttpErrors become isError results, strings become text. */
async function callRegistryTool(ctx: Ctx, def: AnyTool, input: unknown, extra: ToolExtra): Promise<CallToolResult> {
  try {
    const scopes = (extra.authInfo?.scopes ?? []) as Scope[];
    const result = await runTool(def, input, ctx, { scopes, label: extra.authInfo?.extra?.label as string | undefined });
    return typeof result === 'string' ? text(result) : json(result);
  } catch (err) {
    if (err instanceof HttpError) return fail(err.code, err.message, err.extra);
    const e = err as Error & { code?: string };
    return fail(e.code ?? 'error', e.message ?? String(err));
  }
}

// ---------- server ----------

export function createMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'tsai-mind', version: '0.1.0' });

  // ----- tools: every registry tool, same names and behaviour as the in-app assistant -----
  for (const def of TOOLS) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.schema.shape }, async (args: unknown, extra: unknown) => callRegistryTool(ctx, def, args, extra as ToolExtra));
  }

  // ----- resources -----
  server.registerResource('today', 'tsaimind://today', { description: 'Today: overdue, due today, pending changes and nodes to nudge.', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await q.getToday(ctx), null, 2) }],
  }));

  server.registerResource(
    'project-outline',
    new ResourceTemplate('tsaimind://project/{id}/outline', {
      list: async () => ({
        resources: (await q.listProjectSummaries(ctx)).map((p) => ({ uri: `tsaimind://project/${p.id}/outline`, name: p.name, mimeType: 'text/markdown' })),
      }),
    }),
    { description: 'Project outline in Markdown.', mimeType: 'text/markdown' },
    async (uri, vars) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await q.getOutline(ctx, String(vars.id)) }] }),
  );

  // ----- prompts -----
  server.registerPrompt('weekly_review', { description: 'Weekly review: recent activity, overdue items, pending changes, nudges due, and suggestions for next week.', argsSchema: { project_id: z.string().optional() } }, async ({ project_id }) => {
    const today = await q.getToday(ctx);
    const activity = project_id ? await q.listActivity(ctx, project_id, { since: new Date(Date.now() - 7 * 86_400_000).toISOString() }) : [];
    const body = [
      `Today is ${today.today}.`,
      `Overdue (${today.overdue.length}):`, ...today.overdue.map((i) => `- ${i.projectName} / ${i.path.join(' / ')} / ${i.node.title}: due ${i.derived.dueDate}, ${i.daysOverdue} days late, ${i.derived.progress}%`),
      `Due today (${today.dueToday.length}):`, ...today.dueToday.map((i) => `- ${i.projectName} / ${i.node.title}`),
      `Pending changes (${today.pending.length}):`, ...today.pending.map((c) => `- ${c.projectName} / ${c.nodeTitle}: ${c.field} ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`),
      `Nudges due (${today.nudgeDue.length}):`, ...today.nudgeDue.map((i) => `- ${i.projectName} / ${i.node.title}`),
      ...(project_id ? [`Activity in the last 7 days (${activity.length}):`, ...activity.slice(0, 50).map((a) => `- ${a.createdAt.slice(0, 10)} ${a.actor} ${a.kind} ${JSON.stringify(a.payload)}`)] : []),
      'Summarise the week, list what slipped and why, and propose concrete adjustments for next week.',
    ].join('\n');
    return { messages: [{ role: 'user', content: { type: 'text', text: body } }] };
  });

  server.registerPrompt('nudge_draft', { description: 'Draft a nudge message for a node.', argsSchema: { node_id: z.string() } }, async ({ node_id }) => {
    const d = await q.getNodeDetail(ctx, node_id);
    const body = `Write a short, polite follow-up message about the task "${d.node.title}" (project ${d.projectName}, path ${d.path.join(' / ')}), due ${d.derived.dueDate ?? 'unset'}, progress ${d.derived.progress}%, status ${d.derived.status}. Use the same language as the task title.`;
    return { messages: [{ role: 'user', content: { type: 'text', text: body } }] };
  });

  return server;
}

// ---------- HTTP wiring (stateful Streamable HTTP sessions) ----------

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  tokenId: string;
}

export async function registerMcp(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const sessions = new Map<string, McpSession>();

  const authInfoFor = (auth: AuthInfo) => ({ token: auth.tokenId, clientId: auth.tokenId, scopes: auth.scopes, extra: { label: auth.label } });

  const handle = async (request: FastifyRequest, reply: { hijack: () => unknown; raw: import('node:http').ServerResponse }) => {
    const sessionId = request.headers['mcp-session-id'];
    const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    const body = request.method === 'POST' ? request.body : undefined;
    let session = sid ? sessions.get(sid) : undefined;

    if (session && session.tokenId !== request.auth.tokenId) {
      reply.raw.writeHead(403, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'forbidden', message: 'session belongs to another token' }));
      reply.hijack();
      return;
    }

    if (!session) {
      const isInit = request.method === 'POST' && body && typeof body === 'object' && (body as { method?: string }).method === 'initialize';
      if (!isInit) {
        reply.raw.writeHead(sid ? 404 : 400, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sid ? 'session not found' : 'missing session; send initialize first' }, id: null }));
        reply.hijack();
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, tokenId: request.auth.tokenId });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      const server = createMcpServer(ctx);
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      session = { transport, server, tokenId: request.auth.tokenId };
    }

    reply.hijack();
    const raw = request.raw as Parameters<StreamableHTTPServerTransport['handleRequest']>[0];
    raw.auth = authInfoFor(request.auth) as (typeof raw)['auth'];
    await session.transport.handleRequest(raw, reply.raw, body);
  };

  app.post('/mcp', async (request, reply) => handle(request, reply));
  app.get('/mcp', async (request, reply) => handle(request, reply));
  app.delete('/mcp', async (request, reply) => handle(request, reply));

  app.addHook('onClose', async () => {
    for (const s of sessions.values()) await s.transport.close().catch(() => {});
    sessions.clear();
  });
}
