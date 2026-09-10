/**
 * The in-app Claude in cloud mode: the DemoServer's assistant route delegates here, and the answer
 * comes from the artifact's `sample` capability (the viewer's own claude.ai account). Standing
 * instructions + the current project's outline go in a leading user turn, then the stored history,
 * then the new message. Tools (only where `limits().tools` is reported) run in the page against the
 * DemoServer with actor 'claude'.
 */
import { serializeOutline, computeRollup } from '@tsai-mind/core';
import type { AssistantDriver, AssistantFailure, AssistantReply, AssistantRequest, DemoServer } from '../demo/mockApi';
import type { AssistantMessage } from '../api/types';
import { useCapability } from './capabilities';
import { buildTools } from './tools';
import type { Sample, SampleError, SampleMessage, SampleTool } from './types';

export const CLOUD_MODEL = 'claude.ai 内置';
export const UNAVAILABLE = '这个页面里的 Claude 不可用';

const MAX_OUTLINE_CHARS = 20_000;
const MAX_HISTORY_TURNS = 30;
const MAX_INPUT_BYTES = 56 * 1024;

function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function messageForCode(code: string, e?: SampleError): string {
  switch (code) {
    case 'not_granted':
      return '你没有允许这个页面使用 Claude';
    case 'rate_limited':
      return '用得太快了，稍后再试';
    case 'refused':
      return 'Claude 拒绝了这个请求';
    case 'prompt_too_large':
      return '这个项目太大，Claude 一次读不完；试试把问题说得更具体';
    case 'session_expired':
      return 'claude.ai 的登录已过期，请重新登录后再试';
    case 'empty_completion':
      return 'Claude 没有给出回答，换个说法试试';
    case 'tools_unavailable':
      return '这个页面里的 Claude 不能调用工具，只能给建议';
    case 'sampling_disabled':
    case 'not_declared':
    case 'capability_disabled':
    case 'capability_removed':
      return UNAVAILABLE;
    case 'invalid_request':
    case 'transform_error':
      return `这次请求 Claude 没法处理：${e?.message ?? code}`;
    default:
      return 'Claude 暂时没有回应，请稍后再试';
  }
}

export function buildInstructions(server: DemoServer, projectId: string | null, withTools: boolean): string {
  const account = server.accountInfo();
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `你是 Tsai Mind（一个以思维导图为主的项目管理器）里的助手，正在帮 ${account.name || '用户'} 管理项目。今天是 ${today}。`,
    '规则：',
    '- 关键字段（截止日 due_date、开始日 start_date、负责人 owner_id、删除、状态改为 done）需要主人确认：工具会自动把这些改动创建为「待确认」的改动，不会直接生效；告诉用户去「待确认」里确认即可。其它字段直接生效。',
    withTools ? '- 编辑之前先调用 get_tree 拿到最新的大纲；只用大纲里出现的节点 id（方括号里的那串）。' : '- 你现在没有可用的工具，只能根据下面的大纲给建议，不能直接修改项目；需要改动时把具体步骤告诉用户。',
    '- 回答简短，用简体中文；用普通段落和「- 」列表，可以用 **粗体**，不要用标题和表格。',
    '- 日期一律写成 YYYY-MM-DD。',
  ];
  if (projectId) {
    try {
      const ps = server.proj(projectId);
      const deps = new Map<string, string[]>();
      for (const d of ps.deps) deps.set(d.toNode, [...(deps.get(d.toNode) ?? []), d.fromNode]);
      let outline = serializeOutline(ps.store, null, { contacts: server.liveContacts(), year: new Date().getFullYear(), deps, derived: computeRollup(ps.store) });
      if (outline.length > MAX_OUTLINE_CHARS) outline = `${outline.slice(0, MAX_OUTLINE_CHARS)}\n…（大纲太长，已截断）`;
      lines.push('', `当前项目「${ps.project.name}」（id ${ps.project.id}）的大纲，每行是：标题 [节点id] @负责人 开始–截止 状态 进度%：`, outline);
    } catch {
      /* project gone */
    }
  } else lines.push('', '用户现在没有打开具体项目；需要时先调用 list_projects。');
  return lines.join('\n');
}

export function buildTurns(instructions: string, history: AssistantMessage[], userText: string): SampleMessage[] {
  // the stored history already ends with the new user message; drop it and re-add it last
  const past = history.slice(0, -1);
  let turns: SampleMessage[] = [];
  for (const m of past) {
    const text = m.text?.trim() ?? '';
    const tools = m.toolCalls?.length ? `（调用了工具：${m.toolCalls.map((t) => t.name).join('、')}）` : '';
    const content = text || tools;
    if (!content) continue;
    turns.push({ role: m.role, content: m.role === 'assistant' && text && tools ? `${tools}\n${text}` : content });
  }
  if (turns.length > MAX_HISTORY_TURNS) turns = turns.slice(turns.length - MAX_HISTORY_TURNS);
  const total = () => bytes(instructions) + turns.reduce((n, t) => n + bytes(t.content), 0) + bytes(userText);
  while (turns.length && total() > MAX_INPUT_BYTES) turns.shift();
  return [{ role: 'user', content: instructions }, ...turns, { role: 'user', content: userText }];
}

export class SampleAssistant implements AssistantDriver {
  private sampleP: Promise<Sample | null>;
  private toolsAvailable: boolean | null = null;
  private granted = true;

  constructor(private server: DemoServer) {
    this.sampleP = useCapability('sample');
  }

  async status() {
    const sample = await this.sampleP;
    if (!sample || !this.granted) return { configured: false, model: CLOUD_MODEL, message: this.granted ? UNAVAILABLE : messageForCode('not_granted') };
    if (this.toolsAvailable === null) {
      try {
        const lim = await sample.limits();
        this.toolsAvailable = !!lim?.tools;
      } catch {
        return { configured: false, model: CLOUD_MODEL, message: UNAVAILABLE };
      }
    }
    return { configured: true, model: CLOUD_MODEL };
  }

  async reply(req: AssistantRequest): Promise<AssistantReply> {
    const st = await this.status();
    const sample = await this.sampleP;
    if (!st.configured || !sample) throw { message: st.message ?? UNAVAILABLE, toolCalls: [] } satisfies AssistantFailure;
    const toolCalls: AssistantReply['toolCalls'] = [];
    const tools: SampleTool[] | undefined = this.toolsAvailable
      ? buildTools(this.server, (name, input, result) => {
          toolCalls.push({ name, input, resultText: JSON.stringify(result, null, 2) });
          req.emit('tool', { name, input, result });
        })
      : undefined;
    const turns = buildTurns(buildInstructions(this.server, req.projectId, !!tools), req.history, req.userText);
    const ctl = new AbortController();
    if (req.signal) {
      if (req.signal.aborted) ctl.abort();
      else req.signal.addEventListener('abort', () => ctl.abort(), { once: true });
    }
    try {
      const r = await sample(turns, {
        onText: ({ delta }) => req.emit('text', { delta }),
        signal: ctl.signal,
        cache: false,
        modelTier: 'default',
        ...(tools ? { tools } : {}),
      });
      return { text: r.truncated ? `${r.text}\n\n（回答被截断了，可以让我继续）` : r.text, toolCalls };
    } catch (e) {
      const err = (e ?? {}) as Partial<SampleError>;
      const code = typeof err.code === 'string' ? err.code : 'upstream_error';
      if (code === 'not_granted' || code === 'sampling_disabled' || code === 'not_declared') this.granted = false;
      if (code === 'tools_unavailable') this.toolsAvailable = false;
      const failure: AssistantFailure = {
        message: messageForCode(code, err as SampleError),
        toolCalls,
        silent: code === 'cancelled',
        ...(typeof err.text === 'string' && err.text && code !== 'refused' ? { text: err.text } : {}),
      };
      throw failure;
    }
  }
}
