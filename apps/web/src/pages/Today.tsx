import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Contact } from '@tsai-mind/core';
import { api, errorMessage } from '../api/client';
import { todaySections, type PendingChange, type TodayEntry, type TodayResponse } from '../api/types';
import { toast } from '../state/toast';
import { FIELD_LABEL, contactName, copyText, fmtDate, valueLabel } from '../lib/util';
import { Avatar } from '../components/ui';

export function TodayPage() {
  const [data, setData] = useState<TodayResponse | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([api.today(), api.listContacts().catch(() => [] as Contact[])]);
      setData(t);
      setContacts(c);
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (c: PendingChange, decision: 'approve' | 'reject') => {
    try {
      if (decision === 'approve') await api.approveChange(c.id);
      else await api.rejectChange(c.id);
      toast(decision === 'approve' ? '已确认' : '已拒绝', 'ok');
      await load();
    } catch (e) {
      toast(`操作失败：${errorMessage(e)}`, 'error');
    }
  };

  const nudge = async (entry: TodayEntry) => {
    try {
      const r = await api.nudge(entry.node.id);
      const copied = await copyText(r.text);
      toast(`${copied ? '已复制到剪贴板：\n' : ''}${r.text}`, 'ok', 8000);
      await load();
    } catch (e) {
      toast(`催办失败：${errorMessage(e)}`, 'error');
    }
  };

  const open = (e: TodayEntry) => nav(`/projects/${e.projectId}?node=${e.node.id}`);

  const Item = ({ e, overdue }: { e: TodayEntry; overdue?: boolean }) => (
    <div className="today-item">
      <Avatar ownerId={e.node.ownerId} contact={contacts.find((c) => c.id === e.node.ownerId)} />
      <div className="t">
        <div className="name">
          <a
            href={`/projects/${e.projectId}?node=${e.node.id}`}
            style={{ color: 'inherit' }}
            onClick={(ev) => {
              ev.preventDefault();
              open(e);
            }}
          >
            {e.node.title || '（无标题）'}
          </a>
        </div>
        <div className="path">
          {e.projectName}
          {e.path.length > 1 ? ' / ' + e.path.slice(1).join(' / ') : ''}
          {e.node.ownerId ? ` · ${contactName(contacts, e.node.ownerId)}` : ''}
        </div>
      </div>
      <span className={`due${overdue ? ' overdue' : ''}`}>
        {fmtDate(e.derived.dueDate)}
        {overdue && e.daysOverdue > 0 ? ` 逾期 ${e.daysOverdue} 天` : ''}
      </span>
      {overdue && e.node.ownerId && (
        <button className="btn sm" onClick={() => void nudge(e)}>
          催办
        </button>
      )}
    </div>
  );

  if (err)
    return (
      <div className="page">
        <h1>今天</h1>
        <div className="red">{err}</div>
        <button className="btn" onClick={() => void load()} style={{ marginTop: 12 }}>
          重试
        </button>
      </div>
    );
  if (!data)
    return (
      <div className="page">
        <h1>今天</h1>
        <div className="faint">加载中…</div>
      </div>
    );

  const { overdue, dueToday, dueTomorrow, nudgeDue } = todaySections(data);
  return (
    <div className="page narrow">
      <h1>今天</h1>

      <h2>
        逾期 <span className="count">{overdue.length}</span>
      </h2>
      {overdue.length ? overdue.map((e) => <Item key={e.node.id} e={e} overdue />) : <div className="empty">没有逾期的任务。</div>}

      <h2>
        今天到期 <span className="count">{dueToday.length}</span>
      </h2>
      {dueToday.length ? dueToday.map((e) => <Item key={e.node.id} e={e} />) : <div className="empty">今天没有到期的任务。</div>}
      {dueTomorrow.length > 0 && (
        <>
          <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
            明天到期
          </div>
          {dueTomorrow.map((e) => (
            <Item key={e.node.id} e={e} />
          ))}
        </>
      )}

      <h2>
        待确认 <span className="count">{data.pending.length}</span>
      </h2>
      {data.pending.length ? (
        <div className="stack">
          {data.pending.map((c) => (
            <div className="pending-card" key={c.id}>
              <div className="body">
                <div>
                  <a
                    href={`/projects/${c.projectId}?node=${c.nodeId}`}
                    style={{ color: 'inherit', fontWeight: 500 }}
                    onClick={(ev) => {
                      ev.preventDefault();
                      nav(`/projects/${c.projectId}?node=${c.nodeId}`);
                    }}
                  >
                    {c.nodeTitle}
                  </a>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {' '}
                    · {c.projectName} · {c.source === 'claude' ? '经 Claude' : '批量操作'}
                  </span>
                </div>
                <div className="diff">
                  {FIELD_LABEL[c.field] ?? c.field}{' '}
                  {c.field === 'delete' ? '' : `${valueLabel(c.field, c.oldValue, contacts)} → ${valueLabel(c.field, c.newValue, contacts)}`}
                </div>
                {c.reason && <div className="reason">{c.reason}</div>}
              </div>
              <div className="actions">
                <button className="btn sm primary" onClick={() => void decide(c, 'approve')}>
                  确认
                </button>
                <button className="btn sm" onClick={() => void decide(c, 'reject')}>
                  拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">没有等你确认的变更。</div>
      )}

      <h2>
        该催的 <span className="count">{nudgeDue.length}</span>
      </h2>
      {nudgeDue.length ? (
        nudgeDue.map((e) => (
          <div className="today-item" key={e.node.id}>
            <Avatar ownerId={e.node.ownerId} contact={contacts.find((c) => c.id === e.node.ownerId)} />
            <div className="t">
              <div className="name">{e.node.title}</div>
              <div className="path">
                {contactName(contacts, e.node.ownerId)} · {e.projectName} · 逾期 {e.daysOverdue} 天
                {e.node.lastNudgedAt ? '' : ' · 还没催过'}
              </div>
            </div>
            <span className="due overdue">{fmtDate(e.derived.dueDate)}</span>
            <button className="btn sm primary" onClick={() => void nudge(e)}>
              催办
            </button>
          </div>
        ))
      ) : (
        <div className="empty">暂时没有需要催的人。</div>
      )}
    </div>
  );
}
