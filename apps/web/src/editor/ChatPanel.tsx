import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useProject } from '../state/project';
import { useChat } from '../state/chat';
import type { AssistantMessage, ToolCall } from '../api/types';
import { relTime } from '../lib/util';

export const ASSISTANT_ENV = 'ANTHROPIC_API_KEY';

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const projectId = useProject((s) => s.projectId);
  const project = useProject((s) => s.project);
  const status = useChat((s) => s.status);
  const statusError = useChat((s) => s.statusError);
  const sessions = useChat((s) => s.sessions);
  const scope = useChat((s) => s.scope);
  const activeId = useChat((s) => s.activeId);
  const messages = useChat((s) => s.messages);
  const streaming = useChat((s) => s.streaming);
  const loadingMessages = useChat((s) => s.loadingMessages);
  const error = useChat((s) => s.error);
  const loadStatus = useChat((s) => s.loadStatus);
  const loadSessions = useChat((s) => s.loadSessions);
  const setScope = useChat((s) => s.setScope);
  const openSession = useChat((s) => s.openSession);
  const newSession = useChat((s) => s.newSession);
  const removeSession = useChat((s) => s.removeSession);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);

  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  useEffect(() => {
    void loadSessions(projectId);
  }, [loadSessions, projectId, scope]);
  useEffect(() => {
    inputRef.current?.focus();
  }, [activeId]);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = () => {
    if (!text.trim() || streaming) return;
    const t = text;
    setText('');
    void send(t, projectId);
  };

  const configured = status?.configured !== false;
  const active = sessions.find((s) => s.id === activeId);

  return (
    <div className="slide-over chat" role="dialog" aria-label="Claude" data-testid="chat-panel">
      <div className="head">
        <span>
          Claude
          {status?.model && <span className="faint mono" style={{ fontSize: 11, marginLeft: 8, fontWeight: 400 }}>{status.model}</span>}
        </span>
        <div className="row">
          <button className="btn sm ghost" onClick={() => void newSession(projectId)} disabled={!configured} title="新会话">
            新会话
          </button>
          <button className="btn sm ghost" onClick={onClose} title="关闭 (Esc / ⌘J)">
            关闭
          </button>
        </div>
      </div>
      <div className="chat-sessions">
        <select className="select" value={activeId ?? ''} onChange={(e) => void openSession(e.target.value || null)} aria-label="会话" disabled={!configured}>
          <option value="">{sessions.length ? '选择会话…' : '还没有会话'}</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || '新会话'} · {relTime(s.updatedAt ?? s.createdAt) || (s.createdAt ?? '').slice(0, 10)}
            </option>
          ))}
        </select>
        <label className="row faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={scope === 'project'} onChange={(e) => setScope(e.target.checked ? 'project' : 'all', projectId)} disabled={!projectId} />
          只看本项目
        </label>
        {active && (
          <button
            className="btn sm ghost danger"
            title="删除会话"
            onClick={() => {
              if (confirm('删除这个会话？')) void removeSession(active.id);
            }}
          >
            删除
          </button>
        )}
      </div>
      <div className="body chat-body" ref={bodyRef}>
        {!configured ? (
          <div className="chat-empty">
            <div style={{ fontWeight: 700, marginBottom: 6 }}>还没接上 Claude</div>
            <div>
              服务器没有配置 API 密钥。在服务器环境里设置 <code className="mono">{ASSISTANT_ENV}</code> 后重启，就能在这里和 Claude 一起改项目。
            </div>
            <div className="faint" style={{ marginTop: 8 }}>
              Claude 在这里用的是和 MCP 一样的工具；改关键字段仍然要你确认。
            </div>
          </div>
        ) : statusError ? (
          <div className="chat-empty red">{statusError}</div>
        ) : !activeId ? (
          <div className="chat-empty">
            <div>{project ? `和 Claude 聊「${project.name}」。` : '和 Claude 聊你的项目。'}</div>
            <div className="faint" style={{ marginTop: 4 }}>直接输入开始一个新会话，或在上面选一个旧会话。</div>
            <ul className="faint chat-hints">
              <li>「把开发的截止日都推后一周」</li>
              <li>「帮我把上线拆成三步」</li>
              <li>「谁的任务逾期了？」</li>
            </ul>
          </div>
        ) : (
          <>
            {loadingMessages && <div className="faint">加载中…</div>}
            {messages.map((m) => (
              <Message key={m.id} m={m} />
            ))}
            {streaming && <div className="chat-typing faint">Claude 正在思考…</div>}
          </>
        )}
        {error && <div className="red" style={{ fontSize: 12 }}>{error}</div>}
      </div>
      <div className="foot chat-foot">
        <textarea
          ref={inputRef}
          className="textarea"
          rows={2}
          placeholder={configured ? '输入消息，Enter 发送，Shift+Enter 换行' : '未配置'}
          value={text}
          disabled={!configured}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          aria-label="消息"
        />
        {streaming ? (
          <button className="btn" onClick={stop}>
            停止
          </button>
        ) : (
          <button className="btn primary" onClick={submit} disabled={!configured || !text.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}

function Message({ m }: { m: AssistantMessage }) {
  if (m.role === 'user')
    return (
      <div className="chat-msg user">
        <div className="chat-bubble">{m.text}</div>
      </div>
    );
  return (
    <div className="chat-msg assistant">
      {m.toolCalls?.map((c, i) => (
        <ToolChip key={i} call={c} />
      ))}
      {m.text && <div className="chat-md">{renderMarkdownLight(m.text)}</div>}
    </div>
  );
}

function ToolChip({ call }: { call: ToolCall }) {
  const store = useProject((s) => s.store);
  const [open, setOpen] = useState(false);
  const input = (call.input ?? {}) as Record<string, unknown>;
  const nodeId = [input.nodeId, input.node_id, input.id, input.parentId, input.parent_id].find((v): v is string => typeof v === 'string');
  const subject = (nodeId && store.get(nodeId)?.title) || (typeof input.title === 'string' ? input.title : '') || (typeof input.name === 'string' ? input.name : '');
  const rt = call.resultText ?? '';
  let state = '已完成';
  if (/"error"|Error|失败/.test(rt)) state = '失败';
  else if (/changeId|"pending"|待确认/.test(rt)) state = '待确认';
  else if (/batchId|"draft"/.test(rt)) state = '草案';
  const label = ['调用 ' + call.name, subject, state].filter(Boolean).join(' · ');
  return (
    <div className={`tool-chip${open ? ' open' : ''}`} data-testid="tool-chip">
      <button className="tool-chip-head" onClick={() => setOpen(!open)} title="点开看参数和结果">
        <span className="tool-chip-label">{label}</span>
        <span className="faint">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="tool-chip-body">
          <div className="faint">参数</div>
          <pre className="mono">{JSON.stringify(call.input ?? {}, null, 2)}</pre>
          {rt && (
            <>
              <div className="faint">结果</div>
              <pre className="mono">{rt}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** paragraphs, "- " bullets, **bold**, `code` — nothing else. */
export function renderMarkdownLight(src: string): ReactNode[] {
  const blocks = src.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const out: ReactNode[] = [];
  blocks.forEach((block, bi) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return;
    const isList = lines.every((l) => /^\s*([-*•]|\d+[.、)])\s+/.test(l));
    if (isList) {
      out.push(
        <ul key={bi}>
          {lines.map((l, i) => (
            <li key={i}>{inline(l.replace(/^\s*([-*•]|\d+[.、)])\s+/, ''))}</li>
          ))}
        </ul>,
      );
      return;
    }
    // a paragraph may still contain a trailing list
    const paras: string[] = [];
    const items: string[] = [];
    for (const l of lines) {
      if (/^\s*([-*•]|\d+[.、)])\s+/.test(l)) items.push(l.replace(/^\s*([-*•]|\d+[.、)])\s+/, ''));
      else paras.push(l);
    }
    if (paras.length) out.push(<p key={`p${bi}`}>{inline(paras.join('\n'))}</p>);
    if (items.length)
      out.push(
        <ul key={`l${bi}`}>
          {items.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
  });
  return out;
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else parts.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
