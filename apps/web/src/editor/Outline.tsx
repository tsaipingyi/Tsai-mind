import { useEffect, useMemo, useRef } from 'react';
import { isOverdue } from '@tsai-mind/core';
import type { TNode } from '@tsai-mind/core';
import { nodeMatches, useProject } from '../state/project';
import { Avatar, ProgressRing, StatusPill } from '../components/ui';
import { fmtRange, today } from '../lib/util';
import { TitleInput } from './TitleInput';

interface Row {
  node: TNode;
  depth: number;
  childCount: number;
}

export function OutlineView() {
  const store = useProject((s) => s.store);
  const rev = useProject((s) => s.rev);
  const derived = useProject((s) => s.derived);
  const collapsed = useProject((s) => s.collapsed);
  const selectedId = useProject((s) => s.selectedId);
  const editingId = useProject((s) => s.editingId);
  const pending = useProject((s) => s.pending);
  const contacts = useProject((s) => s.contacts);
  const ownerFilter = useProject((s) => s.ownerFilter);
  const search = useProject((s) => s.search);
  const select = useProject((s) => s.select);
  const setEditing = useProject((s) => s.setEditing);
  const toggleCollapse = useProject((s) => s.toggleCollapse);
  const updateNode = useProject((s) => s.updateNode);
  const createChild = useProject((s) => s.createChild);
  const deleteNode = useProject((s) => s.deleteNode);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (n: TNode, depth: number) => {
      const kids = store.children(n.id);
      out.push({ node: n, depth, childCount: kids.length });
      if (!collapsed.has(n.id)) for (const k of kids) walk(k, depth + 1);
    };
    const root = store.root();
    if (root) walk(root, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, rev, collapsed]);

  const pendingIds = useMemo(() => new Set(pending.map((c) => c.nodeId)), [pending]);
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const t = today();
  const filtering = ownerFilter !== undefined || search.trim() !== '';

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-node-id="${selectedId}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  return (
    <div className="outline" ref={listRef} data-testid="outline">
      {rows.map(({ node: n, depth, childCount }) => {
        const d = derived.get(n.id);
        const status = d?.status ?? n.status;
        const progress = d?.progress ?? n.progress;
        const overdue = d ? isOverdue(d, t) : false;
        const cls = [
          'ol-row',
          selectedId === n.id ? 'selected' : '',
          status === 'done' ? 'done' : '',
          filtering && !nodeMatches(n, ownerFilter, search) ? 'dimmed' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div
            key={n.id}
            className={cls}
            data-node-id={n.id}
            style={{ paddingLeft: 8 + depth * 24 }}
            onMouseDown={() => select(n.id)}
          >
            <button
              className={`caret${childCount ? '' : ' empty'}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => toggleCollapse(n.id)}
              title={collapsed.has(n.id) ? '展开' : '收起'}
            >
              {collapsed.has(n.id) ? '▶' : '▼'}
            </button>
            <div
              className="ol-title"
              style={{ fontWeight: depth === 0 ? 700 : childCount ? 500 : 400 }}
              onClick={() => {
                if (selectedId === n.id) setEditing(n.id);
              }}
              onDoubleClick={() => setEditing(n.id)}
            >
              {editingId === n.id ? (
                <TitleInput
                  value={n.title}
                  onCommit={(v) => {
                    updateNode(n.id, { title: v.trim() });
                    setEditing(null);
                  }}
                  onCancel={() => {
                    setEditing(null);
                    if (!n.title) deleteNode(n.id);
                  }}
                  onTab={() => createChild(n.id)}
                />
              ) : (
                <>
                  {n.kind === 'milestone' ? '◆ ' : ''}
                  {n.title || <span className="faint">（无标题）</span>}
                </>
              )}
            </div>
            {pendingIds.has(n.id) && <span className="dot-pending" title="有待确认的变更" />}
            {n.ownerId !== null && (
              <span className="chip">
                <Avatar contact={contactById.get(n.ownerId)} ownerId={n.ownerId} />
                {contactById.get(n.ownerId)?.name ?? '?'}
              </span>
            )}
            <span className={`date${overdue ? ' overdue' : ''}`}>{fmtRange(d?.startDate ?? n.startDate, d?.dueDate ?? n.dueDate)}</span>
            <StatusPill status={status} />
            <span className="prog">
              <ProgressRing progress={progress} status={status} />
              {progress}%
            </span>
          </div>
        );
      })}
      {!rows.length && <div className="empty">这个项目还没有节点。</div>}
    </div>
  );
}
