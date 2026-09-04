/**
 * REST + SSE surface of the in-app assistant.
 *   GET    /api/assistant/status
 *   GET    /api/assistant/sessions            POST /api/assistant/sessions {projectId?}
 *   GET    /api/assistant/sessions/:id        DELETE /api/assistant/sessions/:id
 *   POST   /api/assistant/sessions/:id/messages {text, projectId?} → text/event-stream (text / tool / done / error)
 * Every route needs the read scope; tools called during a turn check their own scope against the token.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, badRequest } from '../errors.js';
import type { Ctx } from '../service/context.js';
import { uuid } from '../schemas.js';
import { createSession, deleteSession, getSession, listSessions, loadSession, runTurn, type Emit } from './service.js';

const idParam = z.object({ id: uuid });

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '), { issues: r.error.issues });
  return r.data;
}

export function registerAssistant(app: FastifyInstance, ctx: Ctx): void {
  const read = { config: { scope: 'read' as const } };
  const requireConfigured = () => {
    if (!ctx.anthropic) throw new HttpError(503, 'assistant_unconfigured', '未配置 ANTHROPIC_API_KEY');
  };

  app.get('/api/assistant/status', read, async () => ({ configured: !!ctx.anthropic, model: ctx.config.assistantModel }));

  app.get('/api/assistant/sessions', read, async () => listSessions(ctx));
  app.post('/api/assistant/sessions', read, async (request, reply) => {
    const body = parse(z.object({ projectId: uuid.nullable().optional() }).default({}), request.body ?? {});
    return reply.status(201).send(await createSession(ctx, { projectId: body.projectId ?? null }));
  });
  app.get('/api/assistant/sessions/:id', read, async (request) => getSession(ctx, parse(idParam, request.params).id));
  app.delete('/api/assistant/sessions/:id', read, async (request) => {
    await deleteSession(ctx, parse(idParam, request.params).id);
    return { ok: true };
  });

  app.post('/api/assistant/sessions/:id/messages', read, async (request, reply) => {
    requireConfigured();
    const { id } = parse(idParam, request.params);
    const body = parse(z.object({ text: z.string().min(1), projectId: uuid.nullable().optional() }), request.body);
    await loadSession(ctx, id); // 404 before the stream opens

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.flushHeaders?.();
    const emit: Emit = (event, data) => {
      if (!raw.writableEnded) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const out = await runTurn(ctx, { sessionId: id, text: body.text, projectId: body.projectId, scopes: request.auth.scopes, emit });
      emit('done', { messageId: out.messageId, text: out.text });
    } catch (err) {
      ctx.log.error(err, 'assistant: turn failed');
      const e = err as Error & { code?: string };
      emit('error', { message: e.message ?? String(err), ...(e.code ? { error: e.code } : {}) });
    } finally {
      raw.end();
    }
  });
}
