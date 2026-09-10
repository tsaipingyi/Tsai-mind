import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isOverdue } from '@tsai-mind/core';
import { nodeMatches, useProject } from '../state/project';
import { computeLayout, connectorPath, H_GAP, NODE_W, V_GAP, type LayoutNode, type Side } from './layout';
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

/**
 * `readOnly` (the phone 导图): touch pan / pinch-zoom, no re-parent drag or inline editing;
 * tapping a node selects it and calls `onOpen` (the node page). Without these props the desktop behaviour is unchanged.
 */
export function MindMap({ onOpen, readOnly = false }: { onOpen?: (id: string) => void; readOnly?: boolean } = {}) {
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

  // the map grows both ways, so a change on the left shifts every world coordinate: keep the root
  // where it is on screen across layout changes (the initial fit of a project still wins)
  const rootPos = useRef<{ projectId: string | null; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const r = layout.order.length ? layout.nodes.get(layout.order[0]!) : undefined;
    if (!r) {
      rootPos.current = null;
      return;
    }
    const prev = rootPos.current;
    rootPos.current = { projectId, x: r.x, y: r.y };
    if (!prev || prev.projectId !== projectId) return;
    const dx = r.x - prev.x;
    const dy = r.y - prev.y;
    if (dx || dy) setView((v) => ({ ...v, x: v.x - dx * v.k, y: v.y - dy * v.k }));
  }, [layout, projectId]);

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

  // ---- touch: one finger pans, two pinch-zoom, a tap selects (and opens the node page when `onOpen` is set) ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let mode: 'pan' | 'pinch' | null = null;
    let moved = false;
    let start = { x: 0, y: 0, vx: 0, vy: 0 };
    let pinch = { d: 1, k: 1, wx: 0, wy: 0 };
    let target: HTMLElement | null = null;
    const mid = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    const onStart = (e: TouchEvent) => {
      const v = viewRef.current;
      if (e.touches.length === 1) {
        const t = e.touches[0]!;
        mode = 'pan';
        moved = false;
        start = { x: t.clientX, y: t.clientY, vx: v.x, vy: v.y };
        target = (e.target as HTMLElement).closest('.mm-node, .mm-controls, .toggle') as HTMLElement | null;
      } else if (e.touches.length === 2) {
        const rect = el.getBoundingClientRect();
        const m = mid(e.touches[0]!, e.touches[1]!);
        mode = 'pinch';
        moved = true;
        pinch = { d: dist(e.touches[0]!, e.touches[1]!), k: v.k, wx: (m.x - rect.left - v.x) / v.k, wy: (m.y - rect.top - v.y) / v.k };
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!mode) return;
      if (target?.classList.contains('mm-controls')) return;
      e.preventDefault();
      if (mode === 'pan' && e.touches.length === 1) {
        const t = e.touches[0]!;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        if (moved) setView({ ...viewRef.current, x: start.vx + dx, y: start.vy + dy });
      } else if (mode === 'pinch' && e.touches.length === 2) {
        const rect = el.getBoundingClientRect();
        const m = mid(e.touches[0]!, e.touches[1]!);
        const k = Math.max(MIN_K, Math.min(MAX_K, (pinch.k * dist(e.touches[0]!, e.touches[1]!)) / pinch.d));
        setView({ k, x: m.x - rect.left - pinch.wx * k, y: m.y - rect.top - pinch.wy * k });
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (mode === 'pan' && !moved) {
        // a tap: buttons (toggle / controls) keep their synthesized click, nodes and the background handle it here
        if (!target || target.classList.contains('mm-node')) {
          e.preventDefault();
          const id = target?.dataset.nodeId;
          if (id) {
            select(id);
            onOpen?.(id);
          } else select(null);
        }
      } else if (moved) e.preventDefault();
      if (e.touches.length === 0) mode = null;
      else if (e.touches.length === 1) {
        const t = e.touches[0]!;
        const v = viewRef.current;
        mode = 'pan';
        moved = true;
        start = { x: t.clientX, y: t.clientY, vx: v.x, vy: v.y };
      }
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
    };
  }, [select, onOpen]);

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

  // ---- node drag: onto a node = become its child; its top / bottom edge = before / after it;
  //      a top-level branch dropped on the blank left / right of the root = change side ----
  type DropTarget = { kind: 'into'; id: string; side?: Side } | { kind: 'before' | 'after'; id: string } | { kind: 'side'; side: Side };
  const [drag, setDrag] = useState<{ id: string; target: DropTarget | null } | null>(null);
  const onNodeMouseDown = (e: React.MouseEvent, ln: LayoutNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (editingId === ln.id) return;
    select(ln.id);
    if (ln.parentId === null || readOnly) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const rootId = store.root()?.id ?? null;
    const descendants = new Set(store.descendants(ln.id).map((n) => n.id));
    const hitTest = (ev: MouseEvent): DropTarget | null => {
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.mm-node') as HTMLElement | null;
      const tid = under?.dataset.nodeId ?? null;
      if (tid && tid !== ln.id && !descendants.has(tid)) {
        const rect = under!.getBoundingClientRect();
        if (tid === rootId) return { kind: 'into', id: tid, side: ev.clientX < rect.left + rect.width / 2 ? 'left' : 'right' };
        const f = (ev.clientY - rect.top) / rect.height;
        if (f < 0.25) return { kind: 'before', id: tid };
        if (f > 0.75) return { kind: 'after', id: tid };
        return { kind: 'into', id: tid };
      }
      if (tid || ln.parentId !== rootId) return null;
      const rootEl = containerRef.current?.querySelector('.mm-node.root');
      if (!rootEl) return null;
      const rr = rootEl.getBoundingClientRect();
      const side: Side = ev.clientX < rr.left + rr.width / 2 ? 'left' : 'right';
      return side === ln.side ? null : { kind: 'side', side };
    };
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!dragging && Math.abs(dx) + Math.abs(dy) > 4) dragging = true;
      if (!dragging) return;
      setDrag({ id: ln.id, target: hitTest(ev) });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!dragging) return;
      const target = hitTest(ev);
      setDrag(null);
      if (!target || !rootId) return;
      const sideOf = (id: string): Side => layout.nodes.get(id)?.side ?? 'right';
      // pinning one branch must not make the automatic balance move another: freeze the others where they are
      const pinOthers = () => {
        for (const k of store.children(rootId)) if (k.id !== ln.id && !k.side) updateNode(k.id, { side: sideOf(k.id) });
      };
      if (target.kind === 'side') {
        pinOthers();
        updateNode(ln.id, { side: target.side });
        return;
      }
      if (target.kind === 'into') {
        const kids = store.children(target.id).filter((k) => k.id !== ln.id);
        if (target.id === rootId) {
          // last branch on that side (in rank order), else the end of the list
          const onSide = kids.filter((k) => sideOf(k.id) === target.side);
          const after = onSide.length ? onSide[onSide.length - 1]! : kids[kids.length - 1];
          pinOthers();
          moveNode(ln.id, rootId, after?.id ?? null);
          updateNode(ln.id, { side: target.side ?? null });
        } else {
          moveNode(ln.id, target.id, kids.length ? kids[kids.length - 1]!.id : null);
          if (ln.node.side) updateNode(ln.id, { side: null });
        }
        if (collapsed.has(target.id)) toggleCollapse(target.id);
        return;
      }
      const t = store.live(target.id);
      if (!t || t.parentId === null) return;
      const sibs = store.children(t.parentId).filter((s) => s.id !== ln.id);
      const i = sibs.findIndex((s) => s.id === target.id);
      const afterId = target.kind === 'after' ? target.id : i > 0 ? sibs[i - 1]!.id : null;
      moveNode(ln.id, t.parentId, afterId);
      if (t.parentId === rootId) {
        const s = sideOf(target.id);
        if (ln.node.side !== s) {
          pinOthers();
          updateNode(ln.id, { side: s });
        }
      } else if (ln.node.side) updateNode(ln.id, { side: null });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // dashed slot showing where a branch lands when it is dropped on the other side of the root
  const dropSlot = useMemo(() => {
    if (!drag?.target || drag.target.kind !== 'side') return null;
    const side = drag.target.side;
    const r = layout.order.length ? layout.nodes.get(layout.order[0]!) : undefined;
    if (!r) return null;
    const stack = r.childIds.map((id) => layout.nodes.get(id)!).filter((c) => c.side === side && c.id !== drag.id);
    const last = stack[stack.length - 1];
    const x = side === 'right' ? r.x + r.w + H_GAP : r.x - H_GAP - NODE_W;
    const y = last ? last.y + last.subtreeH - (last.subtreeH - last.h) / 2 + V_GAP : r.y;
    return { x, y, side };
  }, [drag, layout]);

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
            ln.depth > 0 && ln.side === 'left' ? 'left' : '',
            !isSel && chain.has(id) ? 'branch' : '',
            isSel ? 'selected' : '',
            status === 'blocked' ? 'blocked' : '',
            status === 'done' ? 'done' : '',
            n.kind === 'milestone' ? 'milestone' : '',
            filtering && !nodeMatches(n, ownerFilter, search) ? 'dimmed' : '',
            drag?.target && 'id' in drag.target && drag.target.id === id ? (drag.target.kind === 'into' ? 'drop-target' : `drop-${drag.target.kind}`) : '',
            drag?.target?.kind === 'side' && ln.depth === 0 ? 'drop-target' : '',
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
              onClick={readOnly && onOpen ? () => onOpen(id) : undefined}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!readOnly) setEditing(id);
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
        {dropSlot && <div className={`mm-drop-slot ${dropSlot.side}`} style={{ left: dropSlot.x, top: dropSlot.y }} />}
      </div>
      {!root && <div className="mm-hint">这个项目还没有节点。</div>}
      {root && !readOnly && <div className="mm-hint">拖动背景平移 · Ctrl/⌘ + 滚轮缩放 · 拖动节点：放到节点上成为子节点，放到上下沿调整顺序，一级分支拖到根节点另一侧换边</div>}
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
