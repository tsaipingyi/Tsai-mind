import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addDays } from '@tsai-mind/core';
import { nodeMatches, useProject, type GanttZoom } from '../state/project';
import { Avatar } from '../components/ui';
import { today } from '../lib/util';
import { confirmToast } from '../state/toast';
import { HEADER_H, LEFT_W, ROW_H, buildRows, buildScale, withAncestors, type GanttRow } from './ganttLayout';
import { GanttBody, GanttHeader, type BarPreview } from './GanttChart';

const ZOOMS: { id: GanttZoom; label: string }[] = [
  { id: 'day', label: '日' },
  { id: 'week', label: '周' },
  { id: 'month', label: '月' },
];

export function GanttView() {
  const store = useProject((s) => s.store);
  const rev = useProject((s) => s.rev);
  const derived = useProject((s) => s.derived);
  const collapsed = useProject((s) => s.collapsed);
  const selectedId = useProject((s) => s.selectedId);
  const contacts = useProject((s) => s.contacts);
  const dependencies = useProject((s) => s.dependencies);
  const slips = useProject((s) => s.slips);
  const criticalPath = useProject((s) => s.criticalPath);
  const ownerFilter = useProject((s) => s.ownerFilter);
  const search = useProject((s) => s.search);
  const zoom = useProject((s) => s.ganttZoom);
  const setZoom = useProject((s) => s.setGanttZoom);
  const select = useProject((s) => s.select);
  const toggleCollapse = useProject((s) => s.toggleCollapse);
  const updateNode = useProject((s) => s.updateNode);

  const t = today();
  const filtering = ownerFilter !== undefined || search.trim() !== '';
  const rows = useMemo(() => {
    const visible = filtering ? withAncestors(store, (n) => nodeMatches(n, ownerFilter, search)) : undefined;
    return buildRows(store, derived, collapsed, criticalPath, visible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, rev, derived, collapsed, criticalPath, filtering, ownerFilter, search]);
  const scale = useMemo(() => buildScale(rows, zoom, t), [rows, zoom, t]);
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<BarPreview | null>(null);

  // first paint: scroll so today sits a bit right of the left column
  const scrolledFor = useRef<string | null>(null);
  const projectId = useProject((s) => s.projectId);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !projectId) return;
    const key = `${projectId}:${zoom}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    const left = scale.todayX - 160;
    el.scrollLeft = left < 40 ? 0 : left;
  }, [projectId, zoom, scale.todayX]);

  // selection follows the global selection (keyboard navigation): keep its row in view
  useEffect(() => {
    if (!selectedId) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`.gantt-row[data-node-id="${selectedId}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const commitDates = useCallback(
    async (row: GanttRow, start: string | null, due: string | null) => {
      const n = row.node;
      const patch: { startDate?: string | null; dueDate?: string | null; dateMode?: 'manual' } = {};
      if (row.milestone) patch.dueDate = due;
      else {
        patch.startDate = start;
        patch.dueDate = due;
      }
      if (row.isParent && n.dateMode === 'auto') {
        const ok = await confirmToast('会把父节点日期改成手动，不再跟随子节点。', '改成手动');
        if (!ok) return;
        patch.dateMode = 'manual';
      }
      updateNode(n.id, patch);
    },
    [updateNode],
  );

  const dayFromClient = (clientX: number) => {
    const el = scrollRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft - LEFT_W;
    return scale.dateAt(x);
  };

  const onBarMouseDown = (e: React.MouseEvent, row: GanttRow, part: 'start' | 'move' | 'end') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    select(row.node.id);
    if (!row.start || !row.due) return;
    const start0 = row.start;
    const due0 = row.due;
    const x0 = e.clientX;
    let latest: BarPreview | null = null;
    const shifted = (days: number): BarPreview => {
      let s = start0;
      let d = due0;
      if (part === 'move') {
        s = addDays(start0, days);
        d = addDays(due0, days);
      } else if (part === 'start') {
        s = addDays(start0, days);
        if (s > d) s = d;
      } else {
        d = addDays(due0, days);
        if (d < s) d = s;
      }
      return { id: row.node.id, start: s, due: d };
    };
    const move = (ev: MouseEvent) => {
      const days = Math.round((ev.clientX - x0) / scale.dayW);
      latest = days === 0 ? null : shifted(days);
      setPreview(latest ?? { id: row.node.id, start: start0, due: due0 });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setPreview(null);
      if (latest) void commitDates(row, latest.start, latest.due);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onRowMouseDown = (e: React.MouseEvent, row: GanttRow) => {
    if (e.button !== 0) return;
    select(row.node.id);
    if (row.start && row.due) return; // has a bar; only empty rows create by dragging
    e.preventDefault();
    const d0 = dayFromClient(e.clientX);
    if (!d0) return;
    let moved = false;
    let latest: BarPreview = { id: row.node.id, start: d0, due: d0 };
    const move = (ev: MouseEvent) => {
      const d1 = dayFromClient(ev.clientX);
      if (!d1) return;
      moved = true;
      latest = { id: row.node.id, start: d0 < d1 ? d0 : d1, due: d0 < d1 ? d1 : d0 };
      setPreview(latest);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setPreview(null);
      if (!moved) return;
      void commitDates(row, latest.start, latest.due);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const bodyH = rows.length * ROW_H;

  return (
    <div className="gantt" data-testid="gantt">
      <div className="gantt-toolbar">
        <div className="segmented" role="tablist" aria-label="缩放">
          {ZOOMS.map((z) => (
            <button key={z.id} role="tab" className={zoom === z.id ? 'active' : ''} onClick={() => setZoom(z.id)}>
              {z.label}
            </button>
          ))}
        </div>
        <button
          className="btn sm"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTo({ left: Math.max(0, scale.todayX - 160), behavior: 'smooth' });
          }}
        >
          今天
        </button>
        <span className="faint" style={{ fontSize: 12 }}>
          拖动条改日期 · 拖两端改长度 · 在空行上拖出一段创建日期
          {slips.length > 0 && (
            <span className="red" style={{ marginLeft: 8 }}>
              {slips.length} 处延误
            </span>
          )}
        </span>
      </div>
      <div className="gantt-scroll" ref={scrollRef}>
        <div className="gantt-inner" style={{ width: LEFT_W + scale.width, height: HEADER_H + bodyH }}>
          <div className="gantt-head-row" style={{ height: HEADER_H }}>
            <div className="gantt-corner" style={{ width: LEFT_W, height: HEADER_H }}>
              <span className="faint">任务</span>
              <span className="faint" style={{ marginLeft: 'auto' }}>
                负责人
              </span>
            </div>
            <svg className="gantt-head-svg" width={scale.width} height={HEADER_H} aria-hidden>
              <GanttHeader scale={scale} />
            </svg>
          </div>
          <div className="gantt-body-row" style={{ height: bodyH }}>
            <div className="gantt-left" style={{ width: LEFT_W }}>
              {rows.map((r) => {
                const n = r.node;
                const status = r.derived?.status ?? n.status;
                return (
                  <div
                    key={n.id}
                    className={`gantt-row${selectedId === n.id ? ' selected' : ''}${status === 'done' ? ' done' : ''}${r.critical ? ' critical' : ''}`}
                    data-node-id={n.id}
                    style={{ height: ROW_H, paddingLeft: 8 + r.depth * 16 }}
                    onMouseDown={() => select(n.id)}
                  >
                    <button
                      className={`caret${r.childCount ? '' : ' empty'}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => toggleCollapse(n.id)}
                      title={collapsed.has(n.id) ? '展开' : '收起'}
                    >
                      {collapsed.has(n.id) ? '▶' : '▼'}
                    </button>
                    <span className="gantt-title" style={{ fontWeight: r.depth === 0 ? 700 : r.childCount ? 500 : 400 }} title={n.title}>
                      {r.milestone ? '◆ ' : ''}
                      {n.title || <span className="faint">（无标题）</span>}
                    </span>
                    {r.critical && <span className="gantt-crit-dot" title="关键路径" />}
                    <Avatar contact={n.ownerId ? contactById.get(n.ownerId) : undefined} ownerId={n.ownerId} />
                  </div>
                );
              })}
              {!rows.length && <div className="empty" style={{ padding: 12 }}>这个项目还没有节点。</div>}
            </div>
            <svg className="gantt-body-svg" width={scale.width} height={bodyH} data-testid="gantt-svg">
              <GanttBody
                rows={rows}
                scale={scale}
                deps={dependencies}
                slips={slips}
                selectedId={selectedId}
                preview={preview}
                interactive
                onBarMouseDown={onBarMouseDown}
                onRowMouseDown={onRowMouseDown}
              />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
