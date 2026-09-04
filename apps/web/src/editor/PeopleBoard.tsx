import { useMemo, useState } from 'react';
import { addDays, isOverdue } from '@tsai-mind/core';
import type { Contact, TNode } from '@tsai-mind/core';
import { nodeMatches, useProject } from '../state/project';
import { Avatar, ProgressRing } from '../components/ui';
import { fmtDate, today } from '../lib/util';

interface Column {
  /** contact id, null = 我, 'unassigned' = owner no longer exists */
  key: string | null;
  label: string;
  contact?: Contact;
  droppable: boolean;
}

interface Card {
  node: TNode;
  path: string;
  due: string | null;
  progress: number;
  status: TNode['status'];
  overdue: boolean;
  recentlyDone: boolean;
  pending: boolean;
}

const WEEK_LIMIT_H = 40;
const UNASSIGNED = 'unassigned';

export function PeopleBoard() {
  const store = useProject((s) => s.store);
  const rev = useProject((s) => s.rev);
  const derived = useProject((s) => s.derived);
  const contacts = useProject((s) => s.contacts);
  const pending = useProject((s) => s.pending);
  const selectedId = useProject((s) => s.selectedId);
  const ownerFilter = useProject((s) => s.ownerFilter);
  const search = useProject((s) => s.search);
  const select = useProject((s) => s.select);
  const updateNode = useProject((s) => s.updateNode);

  const t = today();
  const weekStart = useMemo(() => {
    const [y, m, d] = t.split('-').map(Number) as [number, number, number];
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return addDays(t, -((dow + 6) % 7));
  }, [t]);
  const weekEnd = addDays(weekStart, 6);

  const active = contacts.filter((c) => !c.archivedAt);
  const knownIds = new Set(active.map((c) => c.id));
  const pendingIds = useMemo(() => new Set(pending.map((c) => c.nodeId)), [pending]);

  const columns: Column[] = [
    { key: null, label: '我', droppable: true },
    ...active.map((c) => ({ key: c.id, label: c.name, contact: c, droppable: true })),
    { key: UNASSIGNED, label: '未分配', droppable: false },
  ];

  const cardsByCol = useMemo(() => {
    const map = new Map<string | null, Card[]>();
    for (const col of columns) map.set(col.key, []);
    const cutoff = addDays(t, -7);
    for (const n of store.all()) {
      if (n.parentId === null || n.kind === 'note') continue;
      const d = derived.get(n.id);
      if (!d || d.hasChildren) continue;
      if (search.trim() && !nodeMatches(n, undefined, search)) continue;
      const doneAt = n.status === 'done' ? n.updatedAt.slice(0, 10) : null;
      const recentlyDone = doneAt !== null && doneAt >= cutoff;
      if (n.status === 'done' && !recentlyDone) continue;
      const key = n.ownerId === null ? null : knownIds.has(n.ownerId) ? n.ownerId : UNASSIGNED;
      const path = store
        .path(n.id)
        .slice(1)
        .join(' / ');
      map.get(key)!.push({ node: n, path, due: d.dueDate, progress: d.progress, status: d.status, overdue: isOverdue(d, t), recentlyDone, pending: pendingIds.has(n.id) });
    }
    for (const list of map.values())
      list.sort((a, b) => {
        if (a.recentlyDone !== b.recentlyDone) return a.recentlyDone ? 1 : -1;
        if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
        if (!!a.due !== !!b.due) return a.due ? -1 : 1;
        return a.node.title.localeCompare(b.node.title, 'zh');
      });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, rev, derived, contacts, pendingIds, search, t]);

  // ---- drag a card to another column ----
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; target: string | null | undefined } | null>(null);
  const onCardMouseDown = (e: React.MouseEvent, card: Card) => {
    if (e.button !== 0) return;
    e.preventDefault();
    select(card.node.id);
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const colUnder = (ev: MouseEvent): string | null | undefined => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.board-col') as HTMLElement | null;
      if (!el || el.dataset.droppable !== '1') return undefined;
      return el.dataset.colKey === '' ? null : el.dataset.colKey!;
    };
    const move = (ev: MouseEvent) => {
      if (!dragging && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) dragging = true;
      if (!dragging) return;
      setDrag({ id: card.node.id, x: ev.clientX, y: ev.clientY, target: colUnder(ev) });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!dragging) return;
      const target = colUnder(ev);
      setDrag(null);
      if (target !== undefined && target !== card.node.ownerId) updateNode(card.node.id, { ownerId: target });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const visibleCols = ownerFilter === undefined ? columns : columns.filter((c) => c.key === ownerFilter);
  const dragCard = drag ? [...cardsByCol.values()].flat().find((c) => c.node.id === drag.id) : null;

  return (
    <div className="board" data-testid="board">
      {visibleCols.map((col) => {
        const cards = cardsByCol.get(col.key) ?? [];
        const open = cards.filter((c) => !c.recentlyDone);
        const totalH = open.reduce((s, c) => s + (c.node.estimateHours ?? 0), 0);
        const weekH = open.filter((c) => c.due && c.due >= weekStart && c.due <= weekEnd).reduce((s, c) => s + (c.node.estimateHours ?? 0), 0);
        const over = weekH > WEEK_LIMIT_H;
        return (
          <div
            key={String(col.key)}
            className={`board-col${drag && drag.target === col.key && col.droppable ? ' drop-target' : ''}${!col.droppable ? ' readonly' : ''}`}
            data-col-key={col.key ?? ''}
            data-droppable={col.droppable ? '1' : '0'}
          >
            <div className="board-head">
              <Avatar contact={col.contact} ownerId={col.key === UNASSIGNED ? undefined : col.key} size="lg" />
              <span className="board-name">{col.label}</span>
              <span className="board-count mono">{open.length}</span>
              <span className="board-hours mono" title="未完成任务的预估工时合计">
                {totalH ? `${totalH} h` : ''}
              </span>
              {over && (
                <span className="board-warn" title={`本周到期 ${weekH} 小时，超过 ${WEEK_LIMIT_H} 小时`}>
                  本周 {weekH} h
                </span>
              )}
            </div>
            {!col.droppable && cards.length === 0 && <div className="board-empty faint">负责人已归档或不存在的任务会在这里</div>}
            {col.droppable && cards.length === 0 && <div className="board-empty faint">没有任务</div>}
            <div className="board-cards">
              {cards.map((c) => (
                <div
                  key={c.node.id}
                  className={`board-card${c.recentlyDone ? ' done' : ''}${selectedId === c.node.id ? ' selected' : ''}${drag?.id === c.node.id ? ' dragging' : ''}`}
                  data-node-id={c.node.id}
                  onMouseDown={(e) => onCardMouseDown(e, c)}
                >
                  <div className="board-card-title">
                    {c.node.kind === 'milestone' ? '◆ ' : ''}
                    {c.node.title || <span className="faint">（无标题）</span>}
                    {c.pending && <span className="dot-pending" title="有待确认的变更" />}
                  </div>
                  {c.path && <div className="board-card-path">{c.path}</div>}
                  <div className="board-card-meta">
                    <span className={`mono${c.overdue ? ' red' : ''}`}>{c.due ? fmtDate(c.due) : <span className="faint">无日期</span>}</span>
                    {c.node.estimateHours != null && <span className="mono faint">{c.node.estimateHours} h</span>}
                    <span className="board-card-prog mono">
                      <ProgressRing progress={c.progress} status={c.status} />
                      {c.progress}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {drag && dragCard && (
        <div className="board-card ghost" style={{ left: drag.x + 8, top: drag.y + 8 }}>
          <div className="board-card-title">{dragCard.node.title}</div>
        </div>
      )}
    </div>
  );
}
