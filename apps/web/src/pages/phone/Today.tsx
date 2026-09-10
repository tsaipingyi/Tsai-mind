import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TreeStore, addDays, computeRollup, daysBetween } from '@tsai-mind/core';
import type { Contact } from '@tsai-mind/core';
import { api, errorMessage } from '../../api/client';
import { todaySections, type PendingChange, type TodayEntry, type TodayResponse } from '../../api/types';
import { toast } from '../../state/toast';
import { longDate, today } from '../../lib/util';
import { shareOrCopy } from '../../lib/share';
import { PROJECT_CHANGED_EVENT } from '../../lib/cloud';
import { CloudStatusPill } from '../../components/Layout';
import { Empty, LargeTitle, ListLabel, MoreRow, PendingCard, TaskRow, type TaskWhen } from '../../components/phone';

/**
 * 今天 on the phone (design/mobile-v2/Main.dc.html): title + date, at most one pending card
 * (+「还有 n 项待确认 ›」), one list「要做的」= overdue + today + tomorrow, and「本周还有 n 项 ›」that expands inline.
 */
export function PhoneTodayPage() {
  const [data, setData] = useState<TodayResponse | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [week, setWeek] = useState<TodayEntry[]>([]);
  const [weekOpen, setWeekOpen] = useState(false);
  const nav = useNavigate();

  const todayIso = data && typeof data.today === 'string' ? data.today : today();

  const loadWeek = useCallback(async (t: string) => {
    // the server's /api/today stops at tomorrow; walk the project trees for the rest of the week
    const from = addDays(t, 2);
    const to = addDays(t, 8);
    let rows: { id: string; name: string }[] = [];
    try {
      rows = (await api.listProjects()).filter((p) => !p.archivedAt);
    } catch {
      return;
    }
    const out: TodayEntry[] = [];
    await Promise.all(
      rows.map(async (p) => {
        try {
          const d = await api.getProject(p.id);
          const store = new TreeStore(d.nodes);
          const derived = computeRollup(store);
          for (const n of store.all()) {
            const dd = derived.get(n.id);
            if (!dd || dd.hasChildren || n.kind === 'note' || dd.status === 'done' || !dd.dueDate) continue;
            if (dd.dueDate < from || dd.dueDate > to) continue;
            out.push({ node: n, derived: dd, path: store.path(n.id), projectId: p.id, projectName: p.name, daysOverdue: daysBetween(dd.dueDate, t) });
          }
        } catch {
          /* skip this project */
        }
      }),
    );
    out.sort((a, b) => (a.derived.dueDate! < b.derived.dueDate! ? -1 : a.derived.dueDate! > b.derived.dueDate! ? 1 : a.node.priority - b.node.priority));
    setWeek(out);
  }, []);

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([api.today(), api.listContacts().catch(() => [] as Contact[])]);
      setData(t);
      setContacts(c);
      setErr(null);
      void loadWeek(typeof t.today === 'string' ? t.today : today());
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, [loadWeek]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(PROJECT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PROJECT_CHANGED_EVENT, onChanged);
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
      await shareOrCopy(r.text);
      void load();
    } catch (e) {
      toast(`催办失败：${errorMessage(e)}`, 'error');
    }
  };

  const open = (e: TodayEntry) => nav(`/projects/${e.projectId}/node/${e.node.id}`);
  const row = (e: TodayEntry, when: TaskWhen) => <TaskRow key={e.node.id} entry={e} contacts={contacts} when={when} onClick={() => open(e)} onNudge={() => void nudge(e)} />;

  const sec = data ? todaySections(data) : null;
  const todo: { e: TodayEntry; when: TaskWhen }[] = sec
    ? [...sec.overdue.map((e) => ({ e, when: 'overdue' as const })), ...sec.dueToday.map((e) => ({ e, when: 'today' as const })), ...sec.dueTomorrow.map((e) => ({ e, when: 'tomorrow' as const }))]
    : [];
  const pending = data?.pending ?? [];
  const first = pending[0];
  const morePending = Math.max(0, pending.length - 1);

  return (
    <div className="ph-page ph-today" data-testid="phone-today">
      <LargeTitle
        title="今天"
        right={
          <span className="ph-date-slot">
            <CloudStatusPill />
            <span className="ph-date" data-testid="today-date">
              {longDate(todayIso)}
            </span>
          </span>
        }
      />
      {err && (
        <div className="red" style={{ fontSize: 13 }}>
          {err}{' '}
          <button type="button" className="ph-link orange" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      {first || morePending > 0 ? (
        <div className="ph-stack8">
          {first ? (
            <PendingCard change={first} title={first.nodeTitle} contacts={contacts} onApprove={() => void decide(first, 'approve')} onReject={() => void decide(first, 'reject')} onOpen={() => nav(`/projects/${first.projectId}/node/${first.nodeId}`)} />
          ) : null}
          {morePending > 0 ? <MoreRow text={`还有 ${morePending} 项待确认`} onClick={() => nav('/pending')} testId="more-pending" /> : null}
        </div>
      ) : null}

      {!data && !err ? <div className="ph-empty">加载中…</div> : null}
      {sec ? (
        <div>
          <ListLabel text={`要做的 · ${todo.length}`} testId="todo-label" />
          {todo.length ? todo.map(({ e, when }) => row(e, when)) : <Empty text="没有逾期、今天或明天到期的任务。" />}
        </div>
      ) : null}

      {sec && week.length > 0 ? (
        <div>
          <MoreRow text={`本周还有 ${week.length} 项`} onClick={() => setWeekOpen((v) => !v)} expanded={weekOpen} testId="more-week" />
          {weekOpen ? <div data-testid="week-list">{week.map((e) => row(e, 'week'))}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
