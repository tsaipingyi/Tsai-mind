import { useMemo, type ReactNode } from 'react';
import type { TNode } from '@tsai-mind/core';
import { useProject } from '../state/project';
import { PendingDot, StatusDot } from '../components/phone';
import { fmtDate, today } from '../lib/util';

interface Row {
  node: TNode;
  depth: number;
  hasKids: boolean;
}

/**
 * Project outline for the phone (Project.dc.html): 52px rows, ▾ caret for parents (11px ink3, 14 wide),
 * 8px status dot, title 16 (600 for parents, ink3 when done), orange pending dot, mono 13 date
 * (red when overdue and not done). Indent 18px per level from 20px. The root is the project itself
 * (its name is in the header), so its children are the top level. Tap → node page.
 */
export function PhoneOutline({ onOpen, footer }: { onOpen: (id: string) => void; footer?: ReactNode }) {
  const store = useProject((s) => s.store);
  const rev = useProject((s) => s.rev);
  const derived = useProject((s) => s.derived);
  const collapsed = useProject((s) => s.collapsed);
  const pending = useProject((s) => s.pending);
  const toggleCollapse = useProject((s) => s.toggleCollapse);
  const select = useProject((s) => s.select);
  const t = today();

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (n: TNode, depth: number) => {
      const kids = store.children(n.id);
      out.push({ node: n, depth, hasKids: kids.length > 0 });
      if (!collapsed.has(n.id)) for (const k of kids) walk(k, depth + 1);
    };
    const root = store.root();
    if (root) for (const k of store.children(root.id)) walk(k, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, rev, collapsed]);
  const pendingIds = useMemo(() => new Set(pending.map((c) => c.nodeId)), [pending]);

  return (
    <div className="ph-outline" data-testid="phone-outline">
      {rows.map(({ node: n, depth, hasKids }) => {
        const d = derived.get(n.id);
        const status = d?.status ?? n.status;
        const due = d?.dueDate ?? n.dueDate;
        const done = status === 'done';
        const overdue = !!due && due < t && !done;
        return (
          <div key={n.id} className="ph-row" style={{ paddingLeft: 20 + depth * 18 }} data-node-id={n.id} data-testid={`outline-${n.id}`}>
            <button
              type="button"
              className="ph-caret"
              disabled={!hasKids}
              aria-label={hasKids ? (collapsed.has(n.id) ? '展开' : '收起') : undefined}
              onClick={() => toggleCollapse(n.id)}
            >
              {hasKids ? (collapsed.has(n.id) ? '▸' : '▾') : ''}
            </button>
            <button
              type="button"
              className="ph-row-main"
              onClick={() => {
                select(n.id);
                onOpen(n.id);
              }}
            >
              <StatusDot status={status} />
              <span className={`ph-row-title${hasKids ? ' parent' : ''}${done ? ' done' : ''}`}>
                {n.kind === 'milestone' ? '◆ ' : ''}
                {n.title || '（无标题）'}
              </span>
              {pendingIds.has(n.id) && <PendingDot />}
              {due ? <span className={`ph-row-date mono${overdue ? ' red' : ''}`}>{fmtDate(due)}</span> : null}
            </button>
          </div>
        );
      })}
      {!rows.length && <div className="ph-empty" style={{ padding: '14px 20px' }}>这个项目还没有节点。点右下角「+」添加。</div>}
      {footer}
    </div>
  );
}
