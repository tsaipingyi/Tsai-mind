import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { z, type ZodTypeAny } from 'zod';
import { authenticate, bearerFrom, hasScope, listTokens, type AuthInfo, type Scope } from './auth.js';
import { HttpError, badRequest } from './errors.js';
import type { Ctx } from './service/context.js';
import { applyOps, undoOp } from './service/ops.js';
import { approveChange, listChanges, rejectChange } from './service/changes.js';
import { applyPlanBatch, discardPlanBatch, draftPlan, getPlanBatch, listPlanBatches } from './service/plans.js';
import * as q from './service/queries.js';
import { loadAccount } from './service/store.js';
import { contactInput, opsBody, planMode, uuid } from './schemas.js';
import { registerMcp } from './mcp.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo;
  }
  interface FastifyContextConfig {
    scope?: Scope;
  }
}

function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '), { issues: r.error.issues });
  return r.data;
}

const idParam = z.object({ id: uuid });

export async function buildApp(ctx: Ctx, opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true, forceCloseConnections: true });
  ctx.log = app.log;

  await app.register(cors, { origin: ctx.config.corsOrigins, credentials: true });
  await app.register(websocket);

  // ---- auth: every /api/* and /mcp request needs a valid bearer token ----
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    if (!url.startsWith('/api/') && !url.startsWith('/mcp')) return;
    const fromQuery = typeof (request.query as Record<string, unknown>)?.token === 'string' ? ((request.query as Record<string, string>).token as string) : undefined;
    const token = bearerFrom(request.headers.authorization) ?? (url.startsWith('/api/realtime') ? fromQuery : undefined);
    const auth = await authenticate(ctx.sql, token);
    if (!auth) {
      if (url.startsWith('/mcp')) reply.header('WWW-Authenticate', 'Bearer realm="tsai-mind"');
      throw new HttpError(401, 'unauthorized', 'missing or invalid token');
    }
    request.auth = auth;
    const scope = request.routeOptions.config.scope ?? (request.method === 'GET' ? 'read' : 'write');
    if (!url.startsWith('/mcp') && !hasScope(auth, scope)) throw new HttpError(403, 'forbidden', `token lacks scope "${scope}"`);
  });

  app.setErrorHandler((err: unknown, _request, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...err.extra });
    }
    const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message ?? 'bad request' });
    }
    ctx.log.error(err, 'unhandled error');
    return reply.status(500).send({ error: 'internal', message: 'internal error' });
  });

  app.get('/health', async () => ({ ok: true }));

  // ---- me / tokens ----
  app.get('/api/me', async (request) => {
    const account = await loadAccount(ctx.sql);
    return { account, scopes: request.auth.scopes };
  });
  app.get('/api/tokens', async () => listTokens(ctx.sql));

  // ---- projects ----
  app.get('/api/projects', async (request) => {
    const includeArchived = (request.query as Record<string, string>).archived === 'true';
    return q.listProjectSummaries(ctx, { includeArchived });
  });
  app.post('/api/projects', async (request, reply) => {
    const body = parse(z.object({ name: z.string().min(1), outline: z.string().optional() }), request.body);
    const res = await q.createProject(ctx, { name: body.name, outline: body.outline, actor: 'user' });
    return reply.status(201).send(res);
  });
  app.get('/api/projects/:id', async (request) => q.getProjectDetail(ctx, parse(idParam, request.params).id));
  app.patch('/api/projects/:id', async (request) => {
    const body = parse(z.object({ name: z.string().optional(), archivedAt: z.string().nullable().optional() }), request.body);
    return q.updateProject(ctx, parse(idParam, request.params).id, body);
  });
  app.get('/api/projects/:id/outline', async (request, reply) => {
    const text = await q.getOutline(ctx, parse(idParam, request.params).id);
    return reply.type('text/plain; charset=utf-8').send(text);
  });
  app.get('/api/projects/:id/ops', async (request) => {
    const { since } = parse(z.object({ since: z.coerce.number().int().min(0).default(0) }), request.query);
    return q.listOps(ctx, parse(idParam, request.params).id, since);
  });
  app.post('/api/projects/:id/ops', async (request) => {
    const { id } = parse(idParam, request.params);
    const { ops } = parse(opsBody, request.body);
    for (const op of ops) if (op.projectId !== id) throw badRequest(`op ${op.opId} targets another project`);
    const out = await applyOps(ctx, id, ops);
    return { results: out.results, serverSeq: out.serverSeq };
  });
  app.get('/api/projects/:id/activity', async (request) => {
    const { since, limit } = parse(z.object({ since: z.string().optional(), limit: z.coerce.number().int().optional() }), request.query);
    return q.listActivity(ctx, parse(idParam, request.params).id, { since, limit });
  });
  app.post('/api/projects/:id/plan-batches', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const body = parse(z.object({ parentId: uuid, outline: z.string().min(1), mode: planMode.default('append') }), request.body);
    const batch = await draftPlan(ctx, { projectId: id, parentId: body.parentId, outline: body.outline, mode: body.mode, actor: 'user' });
    return reply.status(201).send(batch);
  });
  app.get('/api/projects/:id/plan-batches', async (request) => {
    const status = (request.query as Record<string, string>).status ?? 'draft';
    return listPlanBatches(ctx, parse(idParam, request.params).id, status);
  });

  // ---- today ----
  app.get('/api/today', async () => q.getToday(ctx));

  // ---- contacts ----
  app.get('/api/contacts', async (request) => {
    const { query, archived } = parse(z.object({ query: z.string().optional(), archived: z.string().optional() }), request.query);
    return q.listContactsQ(ctx, { query, includeArchived: archived === 'true' });
  });
  app.post('/api/contacts', async (request, reply) => reply.status(201).send(await q.createContact(ctx, parse(contactInput, request.body))));
  app.get('/api/contacts/:id', async (request) => q.getContact(ctx, parse(idParam, request.params).id));
  app.patch('/api/contacts/:id', async (request) => q.updateContact(ctx, parse(idParam, request.params).id, parse(contactInput, request.body)));
  app.delete('/api/contacts/:id', async (request) => q.archiveContact(ctx, parse(idParam, request.params).id));
  app.get('/api/contacts/:id/nodes', async (request) => q.nodesForContact(ctx, parse(idParam, request.params).id));

  // ---- nodes ----
  app.get('/api/nodes/:id', async (request) => q.getNodeDetail(ctx, parse(idParam, request.params).id));
  app.post('/api/nodes/:id/nudge', async (request) => {
    const body = parse(z.object({ template: z.string().optional() }).default({}), request.body ?? {});
    return q.nudge(ctx, parse(idParam, request.params).id, { template: body.template, actor: 'user' });
  });
  app.get('/api/search', async (request) => {
    const f = parse(
      z.object({
        query: z.string().optional(), projectId: uuid.optional(), ownerId: z.string().optional(), status: z.string().optional(),
        dueBefore: z.string().optional(), dueAfter: z.string().optional(), overdue: z.string().optional(), limit: z.coerce.number().int().optional(),
      }),
      request.query,
    );
    return q.searchNodes(ctx, { ...f, ownerId: f.ownerId === 'me' ? null : f.ownerId, overdue: f.overdue === 'true' });
  });
  app.post('/api/nodes/:id/notes', async (request, reply) => {
    const { body } = parse(z.object({ body: z.string().min(1) }), request.body);
    return reply.status(201).send(await q.addNote(ctx, parse(idParam, request.params).id, body, 'user'));
  });
  app.post('/api/dependencies', async (request, reply) => {
    const { fromNodeId, toNodeId } = parse(z.object({ fromNodeId: uuid, toNodeId: uuid }), request.body);
    await q.addDependency(ctx, fromNodeId, toNodeId, 'user');
    return reply.status(201).send({ fromNode: fromNodeId, toNode: toNodeId });
  });
  app.delete('/api/dependencies', async (request) => {
    const { fromNodeId, toNodeId } = parse(z.object({ fromNodeId: uuid, toNodeId: uuid }), request.body);
    return { removed: await q.removeDependency(ctx, fromNodeId, toNodeId, 'user') };
  });

  // ---- changes ----
  app.get('/api/changes', async (request) => {
    const { status, projectId } = parse(z.object({ status: z.string().default('pending'), projectId: uuid.optional() }), request.query);
    return listChanges(ctx, { status, projectId });
  });
  app.post('/api/changes/:id/approve', { config: { scope: 'decide' } }, async (request) => approveChange(ctx, parse(idParam, request.params).id));
  app.post('/api/changes/:id/reject', { config: { scope: 'decide' } }, async (request) => rejectChange(ctx, parse(idParam, request.params).id));
  app.post('/api/changes/batch', { config: { scope: 'decide' } }, async (request) => {
    const { decisions } = parse(z.object({ decisions: z.array(z.object({ id: uuid, decision: z.enum(['approve', 'reject']) })).min(1) }), request.body);
    const results = [];
    for (const d of decisions) {
      try {
        const r = d.decision === 'approve' ? await approveChange(ctx, d.id) : await rejectChange(ctx, d.id);
        results.push({ id: d.id, ok: true, change: r.change });
      } catch (err) {
        results.push({ id: d.id, ok: false, error: err instanceof HttpError ? err.code : 'error', message: (err as Error).message });
      }
    }
    return { results };
  });

  // ---- undo ----
  app.post('/api/ops/:serverSeq/undo', async (request) => {
    const { serverSeq } = parse(z.object({ serverSeq: z.coerce.number().int().positive() }), request.params);
    try {
      const out = await undoOp(ctx, serverSeq, 'user');
      return { results: out.results, serverSeq: out.serverSeq };
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === 'not_found') throw new HttpError(404, 'not_found', e.message);
      if (e.code) throw new HttpError(409, e.code, e.message);
      throw err;
    }
  });

  // ---- plan batches ----
  app.get('/api/plan-batches/:id', async (request) => getPlanBatch(ctx, parse(idParam, request.params).id));
  app.post('/api/plan-batches/:id/apply', { config: { scope: 'decide' } }, async (request) => applyPlanBatch(ctx, parse(idParam, request.params).id));
  app.post('/api/plan-batches/:id/discard', async (request) => discardPlanBatch(ctx, parse(idParam, request.params).id));

  // ---- realtime ----
  app.get('/api/realtime', { websocket: true }, (socket, request: FastifyRequest) => {
    ctx.hub.add(socket);
    socket.send(JSON.stringify({ type: 'hello', tokenLabel: request.auth.label }));
    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string };
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* ignore malformed frames */
      }
    });
  });

  // ---- MCP ----
  await registerMcp(app, ctx);

  return app;
}

export type { FastifyReply };
