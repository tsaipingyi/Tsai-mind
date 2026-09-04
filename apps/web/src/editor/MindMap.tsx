import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isOverdue } from '@tsai-mind/core';
import { nodeMatches, useProject } from '../state/project';
import { computeLayout, connectorPath, type LayoutNode } from './layout';
import { Avatar, ProgressRing } from '../components/ui';
import { fmtRange, today } from '../lib/util';
import { TitleInput } from './TitleInput';

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.25;
const MAX_K = 2.5;

export function MindMap() {
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
  const criticalPath = useProject((s) => s.criticalPath);
  const select = useProject((s) => s.select);
  const setEditing = useProject((s) => s.setEditing);
  const toggleCollapse = useProject((s) => s.toggleCollapse);
  const updateNode = useProject((s) => s.updateNode);
  const moveNode = useProject((s) => s.moveNode);
  const createChild = useProject((s) => s.createChild);
  const deleteNode = useProject((s) => s.deleteNode);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => computeLayout(store, collapsed), [store, rev, collapsed]);
  const pendingNodeIds = useMemo(() => new Set(pending.map((c) => c.nodeId)), [pending]);
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const critical = useMemo(() => new Set(criticalPath), [criticalPath]);
  const t = today();

  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [panning, setPanning] = useState(false);
  const fitted = useRef<string | null>(null);

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el || !layout.width) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const k = Math.max(MIN_K, Math.min(1, cw / layout.width, ch / layout.height));
    setView({ x: (cw - layout.width * k) / 2, y: (ch - layout.height * k) / 2, k });
  }, [layout.width, layout.height]);

  const projectId = useProject((s) => s.projectId);
  useEffect(() => {
    if (projectId && fitted.current !== projectId && layout.width) {
      fitted.current = projectId;
      fit();
    }
  }, [projectId, layout.width, fit]);

  // ancestors chain of the selection for the orange connectors / branch borders
  const chain = useMemo(() => {
    const s = new Set<string>();
    if (!selectedId) return s;
    s.add(selectedId);
    for (const a of store.ancestors(selectedId)) s.add(a.id);
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, store, rev]);

  // keep the selected node in view when it changes (keyboard navigation)
  useEffect(() => {
    if (!selectedId) return;
    const ln = layout.nodes.get(selectedId);
    const el = containerRef.current;
    if (!ln || !el) return;
    const v = viewRef.current;
    const left = ln.x * v.k + v.x;
    const top = ln.y * v.k + v.y;
    const right = left + ln.w * v.k;
    const bottom = top + ln.h * v.k;
    let dx = 0;
    let dy = 0;
    const m = 24;
    if (left < m) dx = m - left;
    else if (right > el.clientWidth - m) dx = el.clientWidth - m - right;
    if (top < m) dy = m - top;
    else if (bottom > el.clientHeight - m) dy = el.clientHeight - m - bottom;
    if (dx || dy) setView({ ...v, x: v.x + dx, y: v.y + dy });
  }, [selectedId, layout]);

  // ---- pan / zoom ----
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const v = viewRef.current;
    if (e.ctrlKey || e.metaKey) {
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.002);
      const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
      const wx = (px - v.x) / v.k;
      const wy = (py - v.y) / v.k;
      setView({ k, x: px - wx * k, y: py - wy * k });
    } else {
      setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
    }
  }, []);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const zoomBy = (factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const v = viewRef.current;
    const px = el.clientWidth / 2;
    const py = el.clientHeight / 2;
    const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
    const wx = (px - v.x) / v.k;
    const wy = (py - v.y) / v.k;
    setView({ k, x: px - wx * k, y: py - wy * k });
  };

  const onBackgroundMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.mm-node, .mm-controls')) return;
    const start = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    let moved = false;
    setPanning(true);
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      setView({ ...viewRef.current, x: start.vx + dx, y: start.vy + dy });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setPanning(false);
      if (!moved) select(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // ---- node drag (re-parent) ----
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; target: string | null } | null>(null);
  const onNodeMouseDown = (e: React.MouseEvent, ln: LayoutNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (editingId === ln.id) return;
    select(ln.id);
    if (ln.parentId === null) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const descendants = new Set(store.descendants(ln.id).map((n) => n.id));
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!dragging && Math.abs(dx) + Math.abs(dy) > 4) dragging = true;
      if (!dragging) return;
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.mm-node') as HTMLElement | null;
      const tid = under?.dataset.nodeId ?? null;
      const target = tid && tid !== ln.id && !descendants.has(tid) ? tid : null;
      setDrag({ id: ln.id, x: ev.clientX, y: ev.clientY, target });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!dragging) return;
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.mm-node') as HTMLElement | null;
      const tid = under?.dataset.nodeId ?? null;
      setDrag(null);
      if (tid && tid !== ln.id && !descendants.has(tid)) {
        const kids = store.children(tid).filter((k) => k.id !== ln.id);
        moveNode(ln.id, tid, kids.length ? kids[kids.length - 1]!.id : null);
        if (collapsed.has(tid)) toggleCollapse(tid);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const root = store.root();
  const filtering = ownerFilter !== undefined || search.trim() !== '';

  return (
    <div
      ref={containerRef}
      className={`mindmap${panning ? ' panning' : ''}`}
      onMouseDown={onBackgroundMouseDown}
      data-testid="mindmap"
    >
      <div className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: layout.width, height: layout.height }}>
        <svg className="links" width={layout.width} height={layout.height}>
          {layout.order.map((id) => {
            const ln = layout.nodes.get(id)!;
            if (!ln.parentId) return null;
            const p = layout.nodes.get(ln.parentId)!;
            const active = chain.has(id) && chain.has(ln.parentId);
            const crit = critical.has(id) && critical.has(ln.parentId);
            return <path key={id} d={connectorPath(p, ln)} className={[active ? 'active' : '', crit ? 'critical' : ''].filter(Boolean).join(' ') || undefined} data-critical={crit ? '1' : undefined} />;
          })}
        </svg>
        {layout.order.map((id) => {
          const ln = layout.nodes.get(id)!;
          const n = ln.node;
          const d = derived.get(id);
          const status = d?.status ?? n.status;
          const progress = d?.progress ?? n.progress;
          const overdue = d ? isOverdue(d, t) : false;
          const isSel = selectedId === id;
          const cls = [
            'mm-node',
            ln.depth === 0 ? 'root' : '',
            !isSel && chain.has(id) ? 'branch' : '',
            isSel ? 'selected' : '',
            status === 'blocked' ? 'blocked' : '',
            status === 'done' ? 'done' : '',
            n.kind === 'milestone' ? 'milestone' : '',
            filtering && !nodeMatches(n, ownerFilter, search) ? 'dimmed' : '',
            drag?.target === id ? 'drop-target' : '',
            drag?.id === id ? 'dragging' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const owner = n.ownerId ? contactById.get(n.ownerId) : undefined;
          const range = fmtRange(d?.startDate ?? n.startDate, d?.dueDate ?? n.dueDate);
          return (
            <div
              key={id}
              className={cls}
              data-node-id={id}
              data-status={status}
              style={{ left: ln.x, top: ln.y }}
              onMouseDown={(e) => onNodeMouseDown(e, ln)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditing(id);
              }}
              title={n.title}
            >
              <div className="t">
                {editingId === id ? (
                  <TitleInput
                    value={n.title}
                    onCommit={(v) => {
                      updateNode(id, { title: v.trim() });
                      setEditing(null);
                    }}
                    onCancel={() => {
                      setEditing(null);
                      if (!n.title) deleteNode(id);
                    }}
                    onTab={() => createChild(id)}
                  />
                ) : (
                  <>
                    {n.kind === 'milestone' ? '◆ ' : ''}
                    {n.title || <span className="faint">（无标题）</span>}
                  </>
                )}
              </div>
              <div className="s">
                {n.ownerId !== null && <Avatar contact={owner} ownerId={n.ownerId} />}
                <span className={`d${overdue ? ' overdue' : ''}`}>{range}</span>
                <span className="p">
                  <ProgressRing progress={progress} status={status} />
                  {progress}%
                </span>
              </div>
              {pendingNodeIds.has(id) && <span className="dot-pending pend" title="有待确认的变更" />}
              {ln.childCount > 0 && (
                <button
                  className={`toggle${ln.collapsed ? ' collapsed' : ''}`}
                  title={ln.collapsed ? '展开' : '收起'}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(id);
                  }}
                >
                  {ln.collapsed ? ln.childCount : '−'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {!root && <div className="mm-hint">这个项目还没有节点。</div>}
      {root && <div className="mm-hint">拖动背景平移 · Ctrl/⌘ + 滚轮缩放 · 拖动节点到另一个节点上可移动</div>}
      <div className="mm-controls">
        <button onClick={() => zoomBy(1 / 1.2)} title="缩小">
          −
        </button>
        <button onClick={fit} title="适应窗口" style={{ width: 'auto', padding: '0 8px', fontFamily: 'var(--font-ui)' }}>
          适应
        </button>
        <button onClick={() => zoomBy(1.2)} title="放大">
          +
        </button>
      </div>
    </div>
  );
}
