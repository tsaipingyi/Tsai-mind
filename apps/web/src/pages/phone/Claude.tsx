import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { AssistantMessage, ToolCall } from '../../api/types';
import { useChat } from '../../state/chat';
import { useProject } from '../../state/project';
import { ASSISTANT_ENV, renderMarkdownLight } from '../../editor/ChatPanel';
import { toolLabel, toolOutcome } from '../../editor/toolLabel';
import { ArrowUpIcon, ChevronDownIcon } from '../../components/icons';
import { Empty, HeaderLink, LargeTitle, Sheet } from '../../components/phone';
import { relTime } from '../../lib/util';

/**
 * Claude tab on the phone (design/mobile-v2/Claude.dc.html): opens straight into the latest conversation
 * (or a new one). `?projectId=&prefill=&t=` from 问 Claude starts a new conversation scoped to that project;
 * the session list is the「历史」sheet behind the title. Same `useChat` store as the desktop panel.
 */
export function PhoneClaudePage() {
  const [params] = useSearchParams();
  const status = useChat((s) => s.status);
  const statusError = useChat((s) => s.statusError);
  const sessions = useChat((s) => s.sessions);
  const sessionsLoaded = useChat((s) => s.sessionsLoaded);
  const activeId = useChat((s) => s.activeId);
  const messages = useChat((s) => s.messages);
  const streaming = useChat((s) => s.streaming);
  const loadingMessages = useChat((s) => s.loadingMessages);
  const error = useChat((s) => s.error);
  const loadStatus = useChat((s) => s.loadStatus);
  const loadSessions = useChat((s) => s.loadSessions);
  const openSession = useChat((s) => s.openSession);
  const removeSession = useChat((s) => s.removeSession);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const loadedProject = useProject((s) => s.project);

  const [input, setInput] = useState('');
  const [fresh, setFresh] = useState(false);
  const [scope, setScope] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const seenT = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void loadStatus();
    // the phone tab lists every conversation; the 问 Claude scope only applies to the new one
    useChat.setState({ scope: 'all' });
    void loadSessions(null);
  }, [loadStatus, loadSessions]);

  useEffect(() => {
    api
      .listProjects()
      .then((rows) => setNames(Object.fromEntries(rows.map((r) => [r.id, r.name]))))
      .catch(() => undefined);
  }, []);

  // 问 Claude from a project / node: a new conversation scoped to that project, input prefilled
  useEffect(() => {
    const t = params.get('t');
    if (!t || t === seenT.current) return;
    seenT.current = t;
    setFresh(true);
    setScope(params.get('projectId') || null);
    setInput(params.get('prefill') ?? '');
    setHistoryOpen(false);
    void openSession(null);
  }, [params, openSession]);

  // default: the latest conversation
  useEffect(() => {
    if (sessionsLoaded && !fresh && !activeId && sessions.length) void openSession(sessions[0]!.id);
  }, [sessionsLoaded, fresh, activeId, sessions, openSession]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const active = sessions.find((s) => s.id === activeId);
  const scopeId = active?.projectId ?? scope;
  const scopeName = scopeId ? (names[scopeId] ?? (loadedProject?.id === scopeId ? loadedProject.name : undefined)) : undefined;
  const configured = status?.configured !== false;

  const submit = () => {
    const text = input.trim();
    if (!text || streaming || !configured) return;
    setInput('');
    setFresh(false);
    void send(text, scopeId ?? null);
  };
  const newChat = () => {
    setFresh(true);
    setHistoryOpen(false);
    setInput('');
    void openSession(null);
    inputRef.current?.focus();
  };
  const pick = (sid: string) => {
    setFresh(false);
    setHistoryOpen(false);
    void openSession(sid);
  };

  return (
    <div className="ph-claude" data-testid="phone-claude">
      <div className="ph-claude-top">
        <LargeTitle
          title="Claude"
          onClick={() => setHistoryOpen(true)}
          testId="chat-history"
          right={<HeaderLink title="新对话" tone="orange" onClick={newChat} testId="new-chat" disabled={!configured} />}
        />
        {scopeId ? (
          <span className="ph-chip" data-testid="chat-scope">
            {scopeName ?? '…'}
          </span>
        ) : null}
        {statusError && !status ? <div className="red ph-small">{statusError}</div> : null}
        {error ? <div className="red ph-small">{error}</div> : null}
      </div>

      <div className="ph-claude-body" ref={bodyRef} data-testid="chat-scroll">
        {!configured ? (
          <div>
            <Empty text="还没接上 Claude。" />
            <div className="ph-hint-text">
              {status?.message ?? <>在服务器的环境变量里设置 <code className="mono">{ASSISTANT_ENV}</code> 后重启，这里就能对话了。</>}
            </div>
          </div>
        ) : (
          <>
            {loadingMessages ? <div className="ph-empty">加载中…</div> : null}
            {!activeId && !loadingMessages ? (
              <div className="ph-hint-text">{scopeName ? `这个对话只看「${scopeName}」。` : '问 Claude 任何关于你项目的事：安排、催办、拆任务。'}改关键字段会先进「待确认」。</div>
            ) : null}
            {messages.map((m) => (
              <Bubble key={m.id} m={m} />
            ))}
            {streaming && !messages.some((m) => m.id === '__streaming__' && (m.text || m.toolCalls?.length)) ? <div className="ph-empty">Claude 正在思考…</div> : null}
          </>
        )}
      </div>

      <div className="ph-claude-input">
        <textarea
          ref={inputRef}
          className="ph-input"
          rows={1}
          value={input}
          disabled={!configured}
          placeholder={configured ? '说点什么' : '服务器未配置'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="消息"
          data-testid="chat-input"
        />
        {streaming ? (
          <button type="button" className="ph-send stop" onClick={stop} aria-label="停止" data-testid="chat-stop">
            ■
          </button>
        ) : (
          <button type="button" className="ph-send" onClick={submit} disabled={!configured || !input.trim()} aria-label="发送" data-testid="chat-send">
            <ArrowUpIcon />
          </button>
        )}
      </div>

      {historyOpen ? (
        <Sheet title="历史" onClose={() => setHistoryOpen(false)} right={<HeaderLink title="新对话" tone="orange" onClick={newChat} testId="history-new-chat" />} testId="history-sheet">
          {sessions.length ? (
            sessions.map((s) => (
              <div key={s.id} className={`ph-session${s.id === activeId ? ' active' : ''}`} data-testid={`session-${s.id}`}>
                <button type="button" className="ph-session-main" onClick={() => pick(s.id)}>
                  <span className="ph-session-title ellipsis">{s.title || '新对话'}</span>
                  <span className="ph-session-sub">
                    {s.projectId && names[s.projectId] ? `${names[s.projectId]} · ` : ''}
                    {relTime(s.updatedAt ?? s.createdAt) || (s.createdAt ?? '').slice(0, 10)}
                  </span>
                </button>
                <button
                  type="button"
                  className="ph-link"
                  onClick={() => {
                    if (confirm('删除这个对话？')) void removeSession(s.id);
                  }}
                  aria-label="删除对话"
                >
                  删除
                </button>
              </div>
            ))
          ) : (
            <div style={{ padding: '0 20px' }}>
              <Empty text="还没有对话。" />
            </div>
          )}
        </Sheet>
      ) : null}
    </div>
  );
}

/** User bubbles right (#F3F3F3, radius 16/16/4/16), assistant replies as plain text left with tool chips underneath. */
function Bubble({ m }: { m: AssistantMessage }) {
  if (m.role === 'user')
    return (
      <div className="ph-msg mine" data-testid={`msg-${m.id}`}>
        {m.text}
      </div>
    );
  return (
    <div className="ph-msg theirs" data-testid={`msg-${m.id}`}>
      {m.text ? <div className="ph-msg-text chat-md">{renderMarkdownLight(m.text)}</div> : null}
      {m.toolCalls?.map((c, i) => (
        <ToolChip key={i} call={c} />
      ))}
    </div>
  );
}

/** 「改了截止日 · 待确认」chip: 13px, 1px #F8B98F border, radius 8, orange dot; grey when done, red text when failed. Tap to expand. */
function ToolChip({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const outcome = toolOutcome(call);
  const tone = outcome === '待确认' ? 'pending' : outcome === '失败' ? 'failed' : 'done';
  return (
    <div className="ph-tool-wrap">
      <button type="button" className={`ph-tool ${tone}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="tool-chip">
        <span className="ph-dot" />
        <span className="ph-tool-label">{toolLabel(call)}</span>
      </button>
      {open ? (
        <div className="ph-tool-detail">
          <div className="ph-tool-name mono">{call.name}</div>
          <pre className="mono">{JSON.stringify(call.input ?? {}, null, 2)}</pre>
          {call.resultText ? <pre className="mono">{call.resultText}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
