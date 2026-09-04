import type { Contact, Dependency } from '@tsai-mind/core';
import type { Slip } from '../api/types';
import { STATUS_COLOR, fmtDate } from '../lib/util';
import { HEADER_H, LEFT_W, ROW_H, dependencyPath, type GanttRow, type GanttScale } from './ganttLayout';

export interface BarPreview {
  id: string;
  start: string;
  due: string;
}

const BAR_H = 16;
const THIN_H = 6;

export function barBox(row: GanttRow, scale: GanttScale, preview?: BarPreview | null): { x: number; w: number } | null {
  const start = preview?.id === row.node.id ? preview.start : row.start;
  const due = preview?.id === row.node.id ? preview.due : row.due;
  if (!start || !due) return null;
  const x = scale.x(start);
  const w = Math.max(scale.dayW, scale.x(due) + scale.dayW - x);
  return { x, w };
}

/** Header: month bands, week / day ticks, today marker. Rendered inside an <svg> or <g>. */
export function GanttHeader({ scale }: { scale: GanttScale }) {
  return (
    <g className="gantt-header-g">
      <rect x={0} y={0} width={scale.width} height={HEADER_H} fill="var(--paper)" />
      {scale.months.map((m) => (
        <g key={m.x}>
          <line x1={m.x} y1={0} x2={m.x} y2={HEADER_H} stroke="var(--line)" />
          {m.w > 30 && (
            <text x={m.x + 6} y={14} fontSize={11} fill="var(--ink-2)" fontFamily="var(--font-ui)">
              {m.label}
            </text>
          )}
        </g>
      ))}
      {scale.ticks.map((t) => (
        <g key={t.x}>
          <line x1={t.x} y1={t.major ? 22 : 34} x2={t.x} y2={HEADER_H} stroke={t.major ? 'var(--ink-3)' : 'var(--line)'} />
          {(t.major || scale.zoom === 'day') && (
            <text x={t.x + 3} y={HEADER_H - 8} fontSize={10} fill={t.major ? 'var(--ink-2)' : 'var(--ink-3)'} fontFamily="var(--font-mono)">
              {t.label}
            </text>
          )}
        </g>
      ))}
      <line x1={0} y1={HEADER_H - 0.5} x2={scale.width} y2={HEADER_H - 0.5} stroke="var(--line)" />
      <g transform={`translate(${scale.todayX}, 0)`}>
        <rect x={-14} y={20} width={28} height={16} rx={8} fill="var(--orange)" />
        <text x={0} y={32} fontSize={10} fill="#fff" textAnchor="middle" fontFamily="var(--font-ui)" fontWeight={500}>
          今天
        </text>
      </g>
    </g>
  );
}

export interface GanttBodyProps {
  rows: readonly GanttRow[];
  scale: GanttScale;
  deps: readonly Dependency[];
  slips: readonly Slip[];
  selectedId?: string | null;
  preview?: BarPreview | null;
  interactive?: boolean;
  onBarMouseDown?: (e: React.MouseEvent, row: GanttRow, part: 'start' | 'move' | 'end') => void;
  onRowMouseDown?: (e: React.MouseEvent, row: GanttRow) => void;
}

/** Grid, today line, bars, dependency arrows. Height = rows × ROW_H. */
export function GanttBody({ rows, scale, deps, slips, selectedId, preview, interactive, onBarMouseDown, onRowMouseDown }: GanttBodyProps) {
  const height = rows.length * ROW_H;
  const rowIndex = new Map(rows.map((r, i) => [r.node.id, i]));
  const slipKey = (d: { fromNode: string; toNode: string }) => `${d.fromNode}→${d.toNode}`;
  const slipMap = new Map(slips.map((s) => [slipKey(s), s]));
  const titleOf = (id: string) => rows[rowIndex.get(id) ?? -1]?.node.title ?? '';

  return (
    <g className="gantt-body-g">
      <rect x={0} y={0} width={scale.width} height={height} fill="var(--paper)" />
      {scale.ticks
        .filter((t) => t.major)
        .map((t) => (
          <line key={t.x} x1={t.x} y1={0} x2={t.x} y2={height} stroke="var(--line)" />
        ))}
      {scale.zoom === 'day' && scale.ticks.filter((t) => !t.major).map((t) => <line key={`d${t.x}`} x1={t.x} y1={0} x2={t.x} y2={height} stroke="var(--paper-2)" />)}
      {/* weekends */}
      {scale.zoom !== 'month' &&
        scale.ticks
          .filter((t) => t.major)
          .map((t) => <rect key={`we${t.x}`} x={t.x + 5 * scale.dayW} y={0} width={2 * scale.dayW} height={height} fill="var(--paper-2)" />)}
      {rows.map((r, i) => (
        <rect
          key={r.node.id}
          className="gantt-rowbg"
          data-row-id={r.node.id}
          x={0}
          y={i * ROW_H}
          width={scale.width}
          height={ROW_H}
          fill={selectedId === r.node.id ? 'var(--orange-soft)' : 'transparent'}
          opacity={selectedId === r.node.id ? 0.6 : 1}
          onMouseDown={interactive && onRowMouseDown ? (e) => onRowMouseDown(e, r) : undefined}
          style={interactive ? { cursor: 'crosshair' } : undefined}
        />
      ))}
      {rows.map((r, i) => (
        <line key={`l${r.node.id}`} x1={0} y1={(i + 1) * ROW_H - 0.5} x2={scale.width} y2={(i + 1) * ROW_H - 0.5} stroke="var(--line)" opacity={0.6} />
      ))}
      <line x1={scale.todayX} y1={0} x2={scale.todayX} y2={height} stroke="var(--orange)" strokeWidth={1.5} strokeDasharray="4 4" className="gantt-today" />

      {/* dependency arrows (behind bars) */}
      <defs>
        <marker id="dep-arrow" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--ink-3)" />
        </marker>
        <marker id="dep-arrow-red" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--red)" />
        </marker>
      </defs>
      {deps.map((d) => {
        const fi = rowIndex.get(d.fromNode);
        const ti = rowIndex.get(d.toNode);
        if (fi === undefined || ti === undefined) return null;
        const fb = barBox(rows[fi]!, scale, preview);
        const tb = barBox(rows[ti]!, scale, preview);
        if (!fb || !tb) return null;
        const slip = slipMap.get(slipKey(d));
        const y1 = fi * ROW_H + ROW_H / 2;
        const y2 = ti * ROW_H + ROW_H / 2;
        const path = dependencyPath(fb.x + fb.w, y1, tb.x, y2);
        return (
          <g key={slipKey(d)} className={`gantt-dep${slip ? ' slipped' : ''}`} data-from={d.fromNode} data-to={d.toNode}>
            {slip && (
              <title>
                前置「{titleOf(d.fromNode)}」{fmtDate(slip.fromDue)} 截止，晚于「{titleOf(d.toNode)}」{fmtDate(slip.toStart)} 开始，延误 {slip.days} 天
              </title>
            )}
            <path d={path} fill="none" stroke={slip ? 'var(--red)' : 'var(--ink-3)'} strokeWidth={slip ? 1.75 : 1.25} markerEnd={slip ? 'url(#dep-arrow-red)' : 'url(#dep-arrow)'} />
          </g>
        );
      })}

      {/* bars */}
      {rows.map((r, i) => {
        const status = r.derived?.status ?? r.node.status;
        const progress = r.derived?.progress ?? r.node.progress;
        const color = STATUS_COLOR[status];
        const box = barBox(r, scale, preview);
        const cy = i * ROW_H + ROW_H / 2;
        const critStroke = r.critical ? { stroke: 'var(--orange)', strokeWidth: 2 } : {};
        const common = { 'data-node-id': r.node.id, className: `gantt-bar${r.critical ? ' critical' : ''}${preview?.id === r.node.id ? ' dragging' : ''}` };
        if (!box) {
          return (
            <text key={r.node.id} x={scale.todayX + 10} y={cy + 4} fontSize={11} fill="var(--ink-3)" fontFamily="var(--font-ui)" className="gantt-nodate" data-node-id={r.node.id} style={{ pointerEvents: 'none' }}>
              无日期
            </text>
          );
        }
        if (r.milestone) {
          const mx = box.x + scale.dayW / 2;
          const s = 7;
          return (
            <g key={r.node.id} {...common} onMouseDown={interactive && onBarMouseDown ? (e) => onBarMouseDown(e, r, 'move') : undefined} style={interactive ? { cursor: 'grab' } : undefined}>
              <path d={`M ${mx} ${cy - s} L ${mx + s} ${cy} L ${mx} ${cy + s} L ${mx - s} ${cy} Z`} fill="var(--orange)" {...(r.critical ? { stroke: 'var(--orange-deep)', strokeWidth: 2 } : {})} />
              <title>
                {r.node.title} · {fmtDate(r.due)}
              </title>
            </g>
          );
        }
        if (r.isParent) {
          const y = cy - THIN_H / 2;
          return (
            <g key={r.node.id} {...common} onMouseDown={interactive && onBarMouseDown ? (e) => onBarMouseDown(e, r, 'move') : undefined} style={interactive ? { cursor: 'grab' } : undefined}>
              <rect x={box.x} y={y} width={box.w} height={THIN_H} rx={2} fill={color} opacity={0.25} />
              {r.critical && <rect x={box.x} y={y - 2} width={box.w} height={THIN_H + 4} rx={3} fill="none" {...critStroke} />}
              <path d={`M ${box.x} ${y - 3} v ${THIN_H + 6} M ${box.x + box.w} ${y - 3} v ${THIN_H + 6}`} stroke={color} strokeWidth={1.5} opacity={0.6} />
              <title>
                {r.node.title} · {fmtDate(r.start)}–{fmtDate(r.due)}
              </title>
            </g>
          );
        }
        const y = cy - BAR_H / 2;
        const doneW = Math.round((box.w * Math.max(0, Math.min(100, progress))) / 100);
        return (
          <g key={r.node.id} {...common}>
            <rect x={box.x} y={y} width={box.w} height={BAR_H} rx={3} fill={color} opacity={0.25} onMouseDown={interactive && onBarMouseDown ? (e) => onBarMouseDown(e, r, 'move') : undefined} style={interactive ? { cursor: 'grab' } : undefined} />
            {doneW > 0 && (
              <rect x={box.x} y={y} width={doneW} height={BAR_H} rx={3} fill={color} onMouseDown={interactive && onBarMouseDown ? (e) => onBarMouseDown(e, r, 'move') : undefined} style={interactive ? { cursor: 'grab', pointerEvents: 'none' } : undefined} />
            )}
            {r.critical && <rect x={box.x} y={y} width={box.w} height={BAR_H} rx={3} fill="none" {...critStroke} style={{ pointerEvents: 'none' }} />}
            {interactive && (
              <>
                <rect x={box.x} y={y} width={8} height={BAR_H} fill="transparent" className="gantt-handle start" onMouseDown={onBarMouseDown ? (e) => onBarMouseDown(e, r, 'start') : undefined} style={{ cursor: 'ew-resize' }} />
                <rect x={box.x + box.w - 8} y={y} width={8} height={BAR_H} fill="transparent" className="gantt-handle end" onMouseDown={onBarMouseDown ? (e) => onBarMouseDown(e, r, 'end') : undefined} style={{ cursor: 'ew-resize' }} />
              </>
            )}
            {box.w > 46 && (
              <text x={box.x + 6} y={cy + 4} fontSize={10} fill="#fff" fontFamily="var(--font-mono)" style={{ pointerEvents: 'none' }}>
                {progress > 0 && doneW > 30 ? `${progress}%` : ''}
              </text>
            )}
            <title>
              {r.node.title} · {fmtDate(r.start)}–{fmtDate(r.due)} · {progress}%
            </title>
          </g>
        );
      })}
    </g>
  );
}

/** A complete, self-contained SVG (labels + header + body) for printing / export. */
export function GanttPrintSvg({
  rows,
  scale,
  deps,
  slips,
  contacts,
}: {
  rows: readonly GanttRow[];
  scale: GanttScale;
  deps: readonly Dependency[];
  slips: readonly Slip[];
  contacts: readonly Contact[];
}) {
  const totalW = LEFT_W + scale.width;
  const totalH = HEADER_H + rows.length * ROW_H;
  const byId = new Map(contacts.map((c) => [c.id, c]));
  return (
    <svg viewBox={`0 0 ${totalW} ${totalH}`} width="100%" style={{ display: 'block' }} fontFamily="var(--font-ui)" className="gantt-print-svg" data-testid="gantt-print">
      <g transform={`translate(${LEFT_W}, 0)`}>
        <GanttHeader scale={scale} />
      </g>
      <g transform={`translate(${LEFT_W}, ${HEADER_H})`}>
        <GanttBody rows={rows} scale={scale} deps={deps} slips={slips} />
      </g>
      <g transform={`translate(0, ${HEADER_H})`}>
        {rows.map((r, i) => {
          const owner = r.node.ownerId === null ? '我' : (byId.get(r.node.ownerId)?.name ?? '');
          const label = `${r.milestone ? '◆ ' : ''}${r.node.title}`;
          const maxChars = Math.max(4, Math.floor((LEFT_W - 70 - r.depth * 14) / 12));
          return (
            <g key={r.node.id}>
              <line x1={0} y1={(i + 1) * ROW_H - 0.5} x2={LEFT_W} y2={(i + 1) * ROW_H - 0.5} stroke="var(--line)" opacity={0.6} />
              <text x={8 + r.depth * 14} y={i * ROW_H + ROW_H / 2 + 4} fontSize={12} fontWeight={r.depth === 0 ? 700 : r.isParent ? 500 : 400} fill="var(--ink)">
                {label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label}
              </text>
              {owner && (
                <text x={LEFT_W - 8} y={i * ROW_H + ROW_H / 2 + 4} fontSize={11} fill="var(--ink-2)" textAnchor="end">
                  {owner}
                </text>
              )}
            </g>
          );
        })}
      </g>
      <line x1={LEFT_W - 0.5} y1={0} x2={LEFT_W - 0.5} y2={totalH} stroke="var(--line)" />
    </svg>
  );
}
