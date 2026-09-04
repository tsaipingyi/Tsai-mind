import { create } from 'zustand';
import { api, errorMessage, streamAssistantMessage, ApiError } from '../api/client';
import type { AssistantEvent, AssistantMessage, AssistantSession, AssistantStatus, ToolCall } from '../api/types';
import { useProject } from './project';
import { toast } from './toast';

export type SessionScope = 'project' | 'all';

interface ChatState {
  status: AssistantStatus | null;
  statusError: string | null;
  sessions: AssistantSession[];
  sessionsLoaded: boolean;
  scope: SessionScope;
  activeId: string | null;
  messages: AssistantMessage[];
  loadingMessages: boolean;
  streaming: boolean;
  error: string | null;

  loadStatus: () => Promise<void>;
  loadSessions: (projectId: string | null) => Promise<void>;
  setScope: (scope: SessionScope, projectId: string | null) => void;
  openSession: (id: string | null) => Promise<void>;
  newSession: (projectId: string | null) => Promise<AssistantSession | null>;
  removeSession: (id: string) => Promise<void>;
  send: (text: string, projectId: string | null) => Promise<void>;
  stop: () => void;
}

const STREAMING_ID = '__streaming__';
let abort: AbortController | null = null;

/** Tool names whose side effects change nodes (the map must catch up afterwards). */
const MUTATING = /^(update_node|create_node|create_nodes|move_node|delete_node|restore_node|set_dates|set_owner|set_status|set_progress|add_dependency|remove_dependency|apply_outline|plan|propose_change|create_project|nudge|add_note)$/;

function unwrapSession(r: AssistantSession | { session: AssistantSession }): AssistantSession {
  return 'session' in r && r.session ? r.session : (r as AssistantSession);
}

function resultToText(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export const useChat = create<ChatState>((set, get) => ({
  status: null,
  statusError: null,
  sessions: [],
  sessionsLoaded: false,
  scope: 'project',
  activeId: null,
  messages: [],
  loadingMessages: false,
  streaming: false,
  error: null,

  loadStatus: async () => {
    try {
      const s = await api.assistantStatus();
      set({ status: s, statusError: null });
    } catch (e) {
      const err = e as ApiError;
      if (err instanceof ApiError && err.status === 404) set({ status: { configured: false }, statusError: null });
      else set({ status: null, statusError: errorMessage(e) });
    }
  },

  loadSessions: async (projectId) => {
    try {
      const list = await api.listSessions(get().scope === 'project' && projectId ? projectId : undefined);
      const sessions = Array.isArray(list) ? list : ((list as { sessions?: AssistantSession[] }).sessions ?? []);
      set({ sessions, sessionsLoaded: true });
      if (get().activeId && !sessions.some((s) => s.id === get().activeId)) set({ activeId: null, messages: [] });
    } catch {
      set({ sessions: [], sessionsLoaded: true });
    }
  },

  setScope: (scope, projectId) => {
    set({ scope });
    void get().loadSessions(projectId);
  },

  openSession: async (id) => {
    if (get().streaming) get().stop();
    if (!id) {
      set({ activeId: null, messages: [], error: null });
      return;
    }
    set({ activeId: id, loadingMessages: true, messages: [], error: null });
    try {
      const r = await api.getSession(id);
      if (get().activeId !== id) return;
      set({ messages: r.messages ?? [], loadingMessages: false, sessions: get().sessions.some((s) => s.id === r.session.id) ? get().sessions.map((s) => (s.id === r.session.id ? r.session : s)) : [r.session, ...get().sessions] });
    } catch (e) {
      set({ loadingMessages: false, error: errorMessage(e) });
    }
  },

  newSession: async (projectId) => {
    try {
      const s = unwrapSession(await api.createSession(projectId ? { projectId } : {}));
      set({ sessions: [s, ...get().sessions.filter((x) => x.id !== s.id)], activeId: s.id, messages: [], error: null });
      return s;
    } catch (e) {
      toast(`无法新建会话：${errorMessage(e)}`, 'error');
      return null;
    }
  },

  removeSession: async (id) => {
    try {
      await api.deleteSession(id);
      set({ sessions: get().sessions.filter((s) => s.id !== id) });
      if (get().activeId === id) set({ activeId: null, messages: [] });
    } catch (e) {
      toast(`删除失败：${errorMessage(e)}`, 'error');
    }
  },

  send: async (text, projectId) => {
    const body = text.trim();
    if (!body || get().streaming) return;
    let sid = get().activeId;
    if (!sid) {
      const s = await get().newSession(projectId);
      if (!s) return;
      sid = s.id;
    }
    const userMsg: AssistantMessage = { id: `local-${Date.now()}`, role: 'user', text: body, createdAt: new Date().toISOString() };
    const draft: AssistantMessage = { id: STREAMING_ID, role: 'assistant', text: '', toolCalls: [] };
    set({ messages: [...get().messages, userMsg, draft], streaming: true, error: null });
    abort = new AbortController();
    const patchDraft = (fn: (m: AssistantMessage) => AssistantMessage) =>
      set({ messages: get().messages.map((m) => (m.id === STREAMING_ID ? fn(m) : m)) });
    let touchedNodes = false;
    let needsReload = false;
    let finalId: string | null = null;
    const onEvent = (ev: AssistantEvent) => {
      switch (ev.event) {
        case 'text':
          patchDraft((m) => ({ ...m, text: m.text + (ev.delta ?? '') }));
          break;
        case 'tool': {
          const call: ToolCall = { name: ev.name, input: ev.input, resultText: resultToText(ev.result) };
          if (MUTATING.test(ev.name)) touchedNodes = true;
          const rt = call.resultText ?? '';
          if (/changeId|"pending"|batchId|"draft"/.test(rt) || /propose|plan|delete|batch/.test(ev.name)) needsReload = true;
          patchDraft((m) => ({ ...m, toolCalls: [...(m.toolCalls ?? []), call] }));
          break;
        }
        case 'done':
          finalId = ev.messageId ?? null;
          patchDraft((m) => ({ ...m, text: ev.text || m.text }));
          break;
        case 'error':
          set({ error: ev.message || '出错了' });
          break;
        default:
          break;
      }
    };
    try {
      await streamAssistantMessage(sid, projectId ? { text: body, projectId } : { text: body }, onEvent, abort.signal);
    } catch (e) {
      const err = e as ApiError;
      if (err instanceof ApiError && err.code === 'assistant_unconfigured') set({ status: { configured: false } });
      set({ error: errorMessage(e) });
    } finally {
      abort = null;
      const id = finalId ?? `assistant-${Date.now()}`;
      set({ streaming: false, messages: get().messages.map((m) => (m.id === STREAMING_ID ? { ...m, id } : m)).filter((m) => m.id !== STREAMING_ID || m.text || m.toolCalls?.length) });
      // session titles come from the server; refresh the list so the new title shows
      void get().loadSessions(projectId);
      const proj = useProject.getState();
      if (proj.projectId) {
        if (needsReload) await proj.reload();
        else if (touchedNodes) await proj.syncOps();
      }
    }
  },

  stop: () => {
    abort?.abort();
    abort = null;
  },
}));
