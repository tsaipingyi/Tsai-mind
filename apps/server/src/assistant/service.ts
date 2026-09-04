/**
 * In-app assistant: sessions + messages in Postgres, and the streaming tool loop against Claude.
 * Tools come from `tools/registry.ts` (the same ones MCP exposes) and run with actor 'claude' under the
 * calling token's scopes, so key-field edits become pending changes exactly like MCP.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Scope } from '../auth.js';
import { HttpError, notFound } from '../errors.js';
import type { Ctx } from '../service/context.js';
import { todayIso } from '../service/context.js';
import { getOutline } from '../service/queries.js';
import { loadAccount, loadProject } from '../service/store.js';
import { findTool, runTool, toolsForScopes, type AnyTool } from '../tools/registry.js';
import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaTool, BetaToolResultBlockParam, BetaToolUseBlock, ClaudeRequest } from './client.js';

export const MAX_TOOL_ROUNDS = 12;
const MAX_TOKENS = 16_000;
/** Tool results longer than this are cut before they go back to Claude. */
const TOOL_RESULT_LIMIT = 60_000;
/** The `tool` SSE event carries at most this much of the result. */
const TOOL_EVENT_LIMIT = 2_048;

// ---------- rows ----------

export interface SessionRow {
  id: string;
  title: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary extends SessionRow {
  lastText: string;
}

export interface ToolCallView {
  id: string;
  name: string;
  input: unknown;
  resultText: string;
  isError: boolean;
}

export interface MessageView {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls: ToolCallView[];
  createdAt: string;
}

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

const rowToSession = (r: Row): SessionRow => ({
  id: r.id as string,
  title: (r.title as string | null) ?? null,
  projectId: (r.project_id as string | null) ?? null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: StoredBlock[];
  text: string;
  createdAt: string;
}

/** Stored blocks are the API's content blocks; assistant rows also hold the tool_result blocks Claude received. */
type StoredBlock = BetaContentBlock | BetaToolResultBlockParam;

const rowToMessage = (r: Row): MessageRow => ({ id: r.id as string, role: r.role as MessageRow['role'], content: (r.content as StoredBlock[]) ?? [], text: (r.text as string) ?? '', createdAt: iso(r.created_at) });

// ---------- sessions ----------

export async function listSessions(ctx: Ctx): Promise<SessionSummary[]> {
  const rows = await ctx.sql`
    select s.*, coalesce((select m.text from assistant_message m where m.session_id = s.id and m.text <> '' order by m.created_at desc limit 1), '') as last_text
    from assistant_session s order by s.updated_at desc limit 200`;
  return rows.map((r) => ({ ...rowToSession(r), lastText: r.last_text as string }));
}

export async function createSession(ctx: Ctx, input: { projectId?: string | null } = {}): Promise<SessionRow> {
  if (input.projectId) await loadProject(ctx.sql, input.projectId);
  const rows = await ctx.sql`insert into assistant_session (project_id) values (${input.projectId ?? null}) returning *`;
  return rowToSession(rows[0]!);
}

export async function loadSession(ctx: Ctx, id: string): Promise<SessionRow> {
  const rows = await ctx.sql`select * from assistant_session where id = ${id}`;
  if (!rows[0]) throw notFound('assistant session');
  return rowToSession(rows[0]);
}

export async function deleteSession(ctx: Ctx, id: string): Promise<void> {
  const rows = await ctx.sql`delete from assistant_session where id = ${id} returning id`;
  if (!rows.length) throw notFound('assistant session');
}

async function loadMessages(ctx: Ctx, sessionId: string): Promise<MessageRow[]> {
  return (await ctx.sql`select * from assistant_message where session_id = ${sessionId} order by created_at, id`).map(rowToMessage);
}

const toolResultText = (r: BetaToolResultBlockParam): string => {
  if (typeof r.content === 'string') return r.content;
  return (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
};

export function renderMessage(m: MessageRow): MessageView {
  const results = new Map<string, BetaToolResultBlockParam>();
  for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b);
  const toolCalls: ToolCallView[] = [];
  for (const b of m.content) {
    if (b.type !== 'tool_use') continue;
    const r = results.get(b.id);
    toolCalls.push({ id: b.id, name: b.name, input: b.input, resultText: r ? toolResultText(r) : '', isError: !!r?.is_error });
  }
  return { id: m.id, role: m.role, text: m.text, toolCalls, createdAt: m.createdAt };
}

export async function getSession(ctx: Ctx, id: string): Promise<{ session: SessionRow; messages: MessageView[] }> {
  const session = await loadSession(ctx, id);
  const messages = (await loadMessages(ctx, id)).map(renderMessage);
  return { session, messages };
}

// ---------- history → API messages ----------

/**
 * A stored assistant row keeps every block of one turn (text / thinking / tool_use / tool_result …) in order.
 * The API wants tool results in a user message, so split on tool_result runs.
 */
export function toApiMessages(rows: MessageRow[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of rows) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content as BetaContentBlockParam[] });
      continue;
    }
    let buf: StoredBlock[] = [];
    let bufRole: 'assistant' | 'user' | null = null;
    const flush = () => {
      if (buf.length && bufRole) out.push({ role: bufRole, content: buf as BetaContentBlockParam[] });
      buf = [];
      bufRole = null;
    };
    for (const b of m.content) {
      const role = b.type === 'tool_result' ? 'user' : 'assistant';
      if (bufRole && bufRole !== role) flush();
      bufRole = role;
      buf.push(b);
    }
    flush();
  }
  return out;
}

// ---------- system prompt ----------

const RULES =
  '规则：你通过工具直接读写这个人的项目计划。改截止日、开始日、负责人、删除节点、标记完成属于关键字段，会进入「待确认」等本人在手机上确认，工具会返回 status "pending"，请如实告诉对方需要确认，不要当作已生效；改标题、描述、进度、标签、加子任务直接生效。一次会生成很多节点的大改动（比如拆一个季度的计划）先用 draft_plan 出草案，让对方一次确认，不要逐个 create_node。每个写操作都要带上读取时拿到的 version，版本冲突时重新读取再改。日期一律用 YYYY-MM-DD。回答用简体中文，简短直接，先说结论；提到节点时用标题，不要念 id。';

export async function buildSystem(ctx: Ctx, projectId: string | null): Promise<{ text: string; projectName: string | null }> {
  const account = await loadAccount(ctx.sql);
  const tz = account.timezone || ctx.config.tzName;
  const parts = [`你是 Tsai Mind（一个人用的导图式项目管理工具）里的助手，正在帮 ${account.name} 管理项目计划。今天是 ${todayIso(ctx)}（时区 ${tz}）。`, RULES];
  let projectName: string | null = null;
  if (projectId) {
    const project = await loadProject(ctx.sql, projectId);
    projectName = project.name;
    const outline = await getOutline(ctx, projectId);
    parts.push(`当前项目「${project.name}」（id ${project.id}）的大纲，每行是：标题 [节点id] @负责人 开始日–截止日 状态 进度%（父节点的日期、进度、状态由子节点汇总），「← 标题」表示前置依赖：\n\n${outline}`);
  }
  return { text: parts.join('\n\n'), projectName };
}

// ---------- tools for Claude ----------

export function toClaudeTool(def: AnyTool): BetaTool {
  const schema = zodToJsonSchema(def.schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: def.name, description: def.description, input_schema: { ...schema, type: 'object' } as BetaTool['input_schema'] };
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…(truncated, ${s.length} chars)`);

/** Execute one tool call; never throws. Returns what goes back to Claude and what the SSE event carries. */
async function execTool(ctx: Ctx, scopes: Scope[], call: BetaToolUseBlock): Promise<{ result: BetaToolResultBlockParam; event: unknown }> {
  const def = findTool(call.name);
  const input = call.input && typeof call.input === 'object' ? call.input : {};
  let payload: unknown;
  let isError = false;
  if (!def) {
    payload = { error: 'unknown_tool', message: `no tool named ${call.name}` };
    isError = true;
  } else {
    try {
      payload = await runTool(def, input, ctx, { scopes });
    } catch (err) {
      isError = true;
      if (err instanceof HttpError) payload = { error: err.code, message: err.message, ...err.extra };
      else payload = { error: 'error', message: (err as Error).message ?? String(err) };
    }
  }
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  const event = text.length <= TOOL_EVENT_LIMIT ? payload : { truncated: true, text: text.slice(0, TOOL_EVENT_LIMIT) };
  return {
    result: { type: 'tool_result', tool_use_id: call.id, content: clip(text, TOOL_RESULT_LIMIT), ...(isError ? { is_error: true } : {}) },
    event,
  };
}

// ---------- the turn ----------

export type Emit = (event: 'text' | 'tool' | 'done' | 'error', data: Record<string, unknown>) => void;

export interface TurnInput {
  sessionId: string;
  text: string;
  projectId?: string | null;
  scopes: Scope[];
  emit: Emit;
}

export interface TurnResult {
  messageId: string;
  text: string;
}

const busy = new Set<string>();

/** One user message → streamed assistant reply, with up to MAX_TOOL_ROUNDS tool rounds. */
export async function runTurn(ctx: Ctx, input: TurnInput): Promise<TurnResult> {
  const client = ctx.anthropic;
  if (!client) throw new HttpError(503, 'assistant_unconfigured', '未配置 ANTHROPIC_API_KEY');
  const session = await loadSession(ctx, input.sessionId);
  if (busy.has(session.id)) throw new HttpError(409, 'busy', '这个会话正在回复中');
  busy.add(session.id);
  try {
    return await runTurnLocked(ctx, client, session, input);
  } finally {
    busy.delete(session.id);
  }
}

async function runTurnLocked(ctx: Ctx, client: NonNullable<Ctx['anthropic']>, session: SessionRow, input: TurnInput): Promise<TurnResult> {
  const text = input.text.trim();
  if (!text) throw new HttpError(400, 'invalid', 'text is required');
  let projectId = session.projectId;
  if (input.projectId !== undefined && input.projectId !== session.projectId) {
    if (input.projectId) await loadProject(ctx.sql, input.projectId);
    projectId = input.projectId;
    await ctx.sql`update assistant_session set project_id = ${projectId} where id = ${session.id}`;
  }
  if (!session.title) await ctx.sql`update assistant_session set title = ${text.slice(0, 30)} where id = ${session.id}`;

  const history = toApiMessages(await loadMessages(ctx, session.id));
  const userBlocks: BetaContentBlockParam[] = [{ type: 'text', text }];
  await ctx.sql`insert into assistant_message (session_id, role, content, text) values (${session.id}, 'user', ${ctx.sql.json(userBlocks as never)}, ${text})`;

  const system = await buildSystem(ctx, projectId);
  const tools = toolsForScopes(input.scopes).map(toClaudeTool);
  const messages: BetaMessageParam[] = [...history, { role: 'user', content: userBlocks }];
  const request = (): ClaudeRequest => ({
    model: ctx.config.assistantModel,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: system.text, cache_control: { type: 'ephemeral' } }],
    tools,
    messages,
  });

  const stored: StoredBlock[] = [];
  const textParts: string[] = [];
  let roundText = '';
  const onText = (delta: string) => {
    if (roundText === '' && textParts.length) input.emit('text', { delta: '\n\n' });
    roundText += delta;
    input.emit('text', { delta });
  };
  const note = (s: string) => {
    // Something the server adds to the reply (limits, refusals): streamed like model text and kept in the row.
    onText(s);
    stored.push({ type: 'text', text: s } as BetaContentBlock);
  };

  try {
    for (let round = 0; ; round++) {
      roundText = '';
      const msg = await client.stream(request(), onText);
      if (roundText) textParts.push(roundText);
      stored.push(...msg.content);
      const calls = msg.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
      if (msg.stop_reason === 'refusal') {
        roundText = '';
        note('（这条请求被安全策略拒绝了，换个说法再试试。）');
        textParts.push(roundText);
        break;
      }
      if (msg.stop_reason !== 'tool_use' || calls.length === 0) break;
      messages.push({ role: 'assistant', content: msg.content as BetaContentBlockParam[] });
      const results: BetaToolResultBlockParam[] = [];
      if (round >= MAX_TOOL_ROUNDS) {
        // Keep the transcript valid (every tool_use needs a tool_result) but stop calling tools.
        for (const c of calls) results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify({ error: 'tool_round_limit', message: `stopped after ${MAX_TOOL_ROUNDS} tool rounds` }), is_error: true });
        stored.push(...results);
        roundText = '';
        note(`（这一轮已经调用了 ${MAX_TOOL_ROUNDS} 次工具，先停在这里；继续对话可以接着做。）`);
        textParts.push(roundText);
        break;
      }
      for (const c of calls) {
        const { result, event } = await execTool(ctx, input.scopes, c);
        input.emit('tool', { name: c.name, input: c.input, result: event });
        results.push(result);
      }
      stored.push(...results);
      messages.push({ role: 'user', content: results });
    }
  } catch (err) {
    // Persist whatever was produced so the transcript stays consistent, then surface the error.
    if (stored.length) await persistAssistant(ctx, session.id, stored, textParts.join('\n\n'));
    throw err;
  }

  const fullText = textParts.filter((t) => t.trim()).join('\n\n');
  const messageId = await persistAssistant(ctx, session.id, stored, fullText);
  return { messageId, text: fullText };
}

async function persistAssistant(ctx: Ctx, sessionId: string, blocks: StoredBlock[], text: string): Promise<string> {
  const rows = await ctx.sql`insert into assistant_message (session_id, role, content, text) values (${sessionId}, 'assistant', ${ctx.sql.json(blocks as never)}, ${text}) returning id`;
  await ctx.sql`update assistant_session set updated_at = now() where id = ${sessionId}`;
  return rows[0]!.id as string;
}
