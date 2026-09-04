import { create } from 'zustand';
import { ApiError, api, authHeaders, errorMessage } from '../api/client';
import { streamSSE, type StreamHandle } from '../api/sse';
import type { AssistantMessage, AssistantSession, AssistantStatus, ToolCall } from '../api/types';
import { noteOnline, snapshots } from '../sync/runtime';
import { toast } from './toast';

export const UNCONFIGURED_TEXT = '服务器还没配置 ANTHROPIC_API_KEY';

export interface ChatMessage extends AssistantMessage {
  toolCalls: ToolCall[];
  /** assistant reply still arriving */
  streaming?: boolean;
  /** stream failed; text holds what arrived before */
  error?: string;
}

export interface Chat {
  session: AssistantSession | null;
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  sending: boolean;
}

interface AssistantState {
  status: AssistantStatus | null;
  statusError: string | null;
  sessions: AssistantSession[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  chats: Record<string, Chat>;
  loadStatus: () => Promise<AssistantStatus | null>;
  loadSessions: () => Promise<void>;
  openSession: (id: string) => Promise<void>;
  createSession: (opts?: { projectId?: string; title?: string }) => Promise<string>;
  deleteSession: (id: string) => Promise<boolean>;
  /** Post one user message and stream the reply into the chat. Resolves when the stream ends. */
  send: (sessionId: string, text: string, projectId?: string) => Promise<void>;
  abort: (sessionId: string) => void;
}

const SESSIONS_CACHE = 'assistant.sessions';
const handles = new Map<string, StreamHandle>();
let localSeq = 0;
const localId = () => `local-${++localSeq}`;

export function resultToText(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** Chip label state for a tool call: 待确认 when the tool produced a pending change, 失败 on error, else 完成. */
export function toolOutcome(t: ToolCall): '待确认' | '失败' | '完成' {
  const r = t.resultText;
  if (/"status"\s*:\s*"pending"|change_id|changeId|待确认/.test(r)) return '待确认';
  if (/^\s*\{[^}]*"error"/.test(r) || /"ok"\s*:\s*false/.test(r)) return '失败';
  return '完成';
}

const TOOL_FIELD: Record<string, string> = {
  title: '标题',
  description: '说明',
  ownerId: '负责人',
  owner_id: '负责人',
  status: '状态',
  progress: '进度',
  startDate: '开始日',
  start_date: '开始日',
  dueDate: '截止日',
  due_date: '截止日',
  estimateHours: '工时',
  estimate_hours: '工时',
  priority: '优先级',
  tags: '标签',
  kind: '类型',
};

function inputOf(t: ToolCall): Record<string, unknown> {
  return t.input && typeof t.input === 'object' ? (t.input as Record<string, unknown>) : {};
}

/**
 * Plain-Chinese verb for a tool chip (Claude.dc.html「改了截止日 · 待确认」):
 * update_node → 改了{字段}, create_node → 加了「{title}」, set_owner → 换了负责人, delete_node → 删了「{title}」,
 * nudge → 拟了催办, draft_plan → 拟了 n 个节点的草案; anything else falls back to the tool name.
 */
export function toolVerb(t: ToolCall): string {
  const input = inputOf(t);
  const title = typeof input.title === 'string' ? input.title : typeof input.node_title === 'string' ? input.node_title : '';
  const quoted = title ? `「${title}」` : '';
  switch (t.name) {
    case 'update_node': {
      const patch = input.patch && typeof input.patch === 'object' ? (input.patch as Record<string, unknown>) : input;
      const fields = Object.keys(patch)
        .filter((k) => k in TOOL_FIELD)
        .map((k) => TOOL_FIELD[k]);
      return fields.length ? `改了${[...new Set(fields)].join('、')}` : '改了节点';
    }
    case 'create_node':
    case 'add_node':
      return `加了${quoted || '节点'}`;
    case 'set_owner':
    case 'assign_owner':
      return '换了负责人';
    case 'delete_node':
      return `删了${quoted || '节点'}`;
    case 'nudge':
    case 'nudge_node':
    case 'draft_nudge':
      return '拟了催办';
    case 'draft_plan':
    case 'plan_outline':
    case 'propose_plan': {
      const n = countPlanNodes(t);
      return n ? `拟了 ${n} 个节点的草案` : '拟了草案';
    }
    case 'move_node':
      return `移了${quoted || '节点'}`;
    default:
      return t.name;
  }
}

function countPlanNodes(t: ToolCall): number {
  const input = inputOf(t);
  if (typeof input.outline === 'string') return input.outline.split('\n').filter((l) => l.trim()).length;
  const m = /"create"\s*:\s*(\d+)/.exec(t.resultText);
  return m ? Number(m[1]) : 0;
}

/** Chip text: the verb plus「· 待确认」/「· 失败」. */
export function toolLabel(t: ToolCall): string {
  const o = toolOutcome(t);
  return o === '完成' ? toolVerb(t) : `${toolVerb(t)} · ${o}`;
}

function normalize(m: AssistantMessage): ChatMessage {
  return { ...m, toolCalls: (m.toolCalls ?? []).map((t) => ({ name: t.name, input: t.input, resultText: typeof t.resultText === 'string' ? t.resultText : resultToText((t as { result?: unknown }).result) })) };
}

function blank(): Chat {
  return { session: null, messages: [], loading: false, error: null, sending: false };
}

export const useAssistant = create<AssistantState>((set, get) => {
  const patchChat = (id: string, partial: Partial<Chat>) => {
    const cur = get().chats[id] ?? blank();
    set({ chats: { ...get().chats, [id]: { ...cur, ...partial } } });
  };
  const patchMessage = (sessionId: string, messageId: string, fn: (m: ChatMessage) => ChatMessage) => {
    const cur = get().chats[sessionId];
    if (!cur) return;
    patchChat(sessionId, { messages: cur.messages.map((m) => (m.id === messageId ? fn(m) : m)) });
  };
  const touchSession = (sessionId: string, lastText: string) => {
    const now = new Date().toISOString();
    const list = get().sessions;
    const found = list.find((s) => s.id === sessionId);
    const next = found ? { ...found, lastText, updatedAt: now } : { id: sessionId, title: null, lastText, createdAt: now, updatedAt: now };
    set({ sessions: [next, ...list.filter((s) => s.id !== sessionId)] });
  };

  return {
    status: null,
    statusError: null,
    sessions: [],
    sessionsLoading: false,
    sessionsError: null,
    chats: {},

    loadStatus: async () => {
      try {
        const status = await api.assistantStatus();
        noteOnline();
        set({ status, statusError: null });
        return status;
      } catch (e) {
        // an older server has no assistant at all: treat as unconfigured
        if (e instanceof ApiError && (e.status === 404 || e.status === 503)) set({ status: { configured: false }, statusError: null });
        else set({ statusError: errorMessage(e) });
        return get().status;
      }
    },

    loadSessions: async () => {
      set({ sessionsLoading: true });
      try {
        const sessions = await api.listSessions();
        noteOnline();
        sessions.sort((a, b) => ((b.updatedAt ?? b.createdAt) < (a.updatedAt ?? a.createdAt) ? -1 : 1));
        set({ sessions, sessionsLoading: false, sessionsError: null });
        void snapshots.saveGeneric(SESSIONS_CACHE, sessions);
      } catch (e) {
        const cached = await snapshots.loadGeneric<AssistantSession[]>(SESSIONS_CACHE);
        set({ sessions: cached ?? get().sessions, sessionsLoading: false, sessionsError: errorMessage(e) });
      }
    },

    openSession: async (id) => {
      const cur = get().chats[id];
      if (cur?.sending) return; // keep the live stream
      patchChat(id, { loading: !cur, error: null });
      try {
        const r = await api.getSession(id);
        noteOnline();
        patchChat(id, { session: r.session, messages: (r.messages ?? []).map(normalize), loading: false, error: null });
      } catch (e) {
        patchChat(id, { loading: false, error: cur?.messages.length ? null : errorMessage(e) });
      }
    },

    createSession: async (opts = {}) => {
      const s = await api.createSession(opts);
      set({ sessions: [s, ...get().sessions.filter((x) => x.id !== s.id)], chats: { ...get().chats, [s.id]: { ...blank(), session: s } } });
      return s.id;
    },

    deleteSession: async (id) => {
      const before = get().sessions;
      set({ sessions: before.filter((s) => s.id !== id) });
      try {
        await api.deleteSession(id);
        const chats = { ...get().chats };
        delete chats[id];
        set({ chats });
        void snapshots.saveGeneric(SESSIONS_CACHE, get().sessions);
        return true;
      } catch (e) {
        set({ sessions: before });
        toast(`删除失败：${errorMessage(e)}`, 'error');
        return false;
      }
    },

    send: async (sessionId, text, projectId) => {
      const body = text.trim();
      if (!body) return;
      const chat = get().chats[sessionId] ?? blank();
      if (chat.sending) return;
      const user: ChatMessage = { id: localId(), role: 'user', text: body, toolCalls: [], createdAt: new Date().toISOString() };
      const replyId = localId();
      const reply: ChatMessage = { id: replyId, role: 'assistant', text: '', toolCalls: [], streaming: true };
      patchChat(sessionId, { messages: [...chat.messages, user, reply], sending: true, error: null });
      touchSession(sessionId, body);

      const handle = streamSSE({
        url: api.assistantMessagesUrl(sessionId),
        headers: { ...authHeaders(), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: projectId ? { text: body, projectId } : { text: body },
        onEvent: (ev) => {
          let data: Record<string, unknown> = {};
          try {
            data = ev.data ? (JSON.parse(ev.data) as Record<string, unknown>) : {};
          } catch {
            data = { delta: ev.data };
          }
          switch (ev.event) {
            case 'text':
              patchMessage(sessionId, replyId, (m) => ({ ...m, text: m.text + String(data.delta ?? '') }));
              break;
            case 'tool':
              patchMessage(sessionId, replyId, (m) => ({
                ...m,
                toolCalls: [...m.toolCalls, { name: String(data.name ?? 'tool'), input: data.input, resultText: resultToText(data.result) }],
              }));
              break;
            case 'done':
              patchMessage(sessionId, replyId, (m) => ({
                ...m,
                id: typeof data.messageId === 'string' && data.messageId ? data.messageId : m.id,
                text: typeof data.text === 'string' && data.text ? data.text : m.text,
                streaming: false,
              }));
              break;
            case 'error':
              patchMessage(sessionId, replyId, (m) => ({ ...m, streaming: false, error: String(data.message ?? '出错了') }));
              break;
            default:
              break;
          }
        },
      });
      handles.set(sessionId, handle);
      try {
        await handle.done;
        noteOnline();
      } catch (e) {
        const msg = e instanceof ApiError && e.code === 'assistant_unconfigured' ? UNCONFIGURED_TEXT : errorMessage(e);
        if (e instanceof ApiError && e.code === 'assistant_unconfigured') set({ status: { configured: false } });
        patchMessage(sessionId, replyId, (m) => ({ ...m, streaming: false, error: msg }));
      } finally {
        handles.delete(sessionId);
        // whatever arrived, the reply is no longer streaming
        patchMessage(sessionId, replyId, (m) => (m.streaming ? { ...m, streaming: false } : m));
        const last = get().chats[sessionId]?.messages.at(-1);
        if (last?.role === 'assistant' && last.text) touchSession(sessionId, last.text);
        patchChat(sessionId, { sending: false });
      }
    },

    abort: (sessionId) => {
      handles.get(sessionId)?.abort();
    },
  };
});
