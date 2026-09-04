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
