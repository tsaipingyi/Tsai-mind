import { useEffect, type ReactNode } from 'react';
import type { Change, Contact, NodeStatus } from '@tsai-mind/core';
import type { TodayEntry } from '../api/types';
import { FIELD_LABEL, STATUS_LABEL, contactName, fmtDate, valueLabel, weekdayLabel } from '../lib/util';

/**
 * Phone-only building blocks (design/mobile-v2). Desktop pages never render these; the desktop
 * `Dialog`/`StatusPill`/`Avatar` in ./ui stay untouched.
 */

/** Large title (34/700, -0.3 tracking) with a baseline-aligned right slot. */
export function LargeTitle({ title, right, onClick, testId }: { title: string; right?: ReactNode; onClick?: () => void; testId?: string }) {
  return (
    <div className="ph-head">
      {onClick ? (
        <button type="button" className="ph-h1 ph-h1-btn" onClick={onClick} data-testid={testId}>
          {title}
        </button>
      ) : (
        <h1 className="ph-h1">{title}</h1>
      )}
      {right}
    </div>
  );
}

/** 15px text link; orange (#D4550C, 500) for actions like 问 Claude / 新对话, ink2 otherwise. */
export function HeaderLink({ title, onClick, tone = 'ink', testId, disabled }: { title: string; onClick: () => void; tone?: 'ink' | 'orange'; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" className={`ph-link ${tone}`} onClick={onClick} data-testid={testId} disabled={disabled}>
      {title}
    </button>
  );
}

/** Orange ‹ back chevron (22px, 24 wide) used by the project and node headers. */
export function BackChevron({ onClick, testId }: { onClick: () => void; testId?: string }) {
  return (
    <button type="button" className="ph-back" onClick={onClick} aria-label="返回" data-testid={testId}>
      ‹
    </button>
  );
}

/** 13px ink2 list label with a 1px bottom line (Main.dc.html「要做的 · 4」). */
export function ListLabel({ text, testId }: { text: string; testId?: string }) {
  return (
    <div className="ph-list-label" data-testid={testId}>
      {text}
    </div>
  );
}

/** 15px ink2 row with a trailing › (「本周还有 3 项」「还有 n 项待确认」「更多：…」). */
export function MoreRow({ text, onClick, expanded, tall, top, testId }: { text: string; onClick: () => void; expanded?: boolean; tall?: boolean; top?: boolean; testId?: string }) {
  return (
    <button type="button" className={`ph-more${tall ? ' tall' : ''}${top ? ' top' : ''}`} onClick={onClick} aria-expanded={expanded} data-testid={testId}>
      <span className="ph-more-text">{text}</span>
      <span className={`ph-chev${expanded ? ' open' : ''}`}>›</span>
    </button>
  );
}

export function Chevron() {
  return <span className="ph-chev">›</span>;
}

export function Empty({ text }: { text: string }) {
  return <div className="ph-empty">{text}</div>;
}

export function StatusDot({ status, size = 8 }: { status: NodeStatus; size?: number }) {
  return <span className="ph-dot" style={{ width: size, height: size, background: `var(--st-${status})` }} aria-hidden />;
}

/** The orange 8px「待确认」marker. */
export function PendingDot() {
  return <span className="ph-dot pend" title="有待确认的变更" />;
}

/** Status pill (Node.dc.html): 40 high, radius 20, 15px; selected = 1.5px border in the status colour + same colour 500. */
export function PhoneStatusPill({ status, active, onClick, disabled, grow = true }: { status: NodeStatus; active: boolean; onClick?: () => void; disabled?: boolean; grow?: boolean }) {
  return (
    <button
      type="button"
      className={`ph-pill${active ? ' active' : ''}${grow ? ' grow' : ''}`}
      style={active ? { borderColor: `var(--st-${status})`, color: `var(--st-${status})` } : undefined}
      onClick={onClick}
      disabled={disabled || !onClick}
      aria-pressed={active}
      data-testid={`status-${status}`}
    >
      {STATUS_LABEL[status]}
    </button>
  );
}

/** Primary (orange) / secondary (white, 1px line) button: 44 high, radius 10, 16px. */
export function PhoneBtn({
  title,
  onClick,
  kind = 'secondary',
  grow,
  width,
  height = 44,
  disabled,
  testId,
}: {
  title: string;
  onClick?: () => void;
  kind?: 'primary' | 'secondary';
  grow?: boolean;
  width?: number;
  height?: number;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button type="button" className={`ph-btn ${kind}${grow ? ' grow' : ''}`} style={{ height, ...(width !== undefined ? { width } : {}) }} onClick={onClick} disabled={disabled} data-testid={testId}>
      {title}
    </button>
  );
}

/**
 * The one pending card (Main.dc.html / Node.dc.html): light-orange, radius 12, padding 14/16;
 * 「Claude 提议 · 节点」13 ink2, the diff 17/500 (dates in mono), the reason 14 ink2,
 * 确认 (orange, grows) and 拒绝 (white, 96 wide).
 */
export function PendingCard({
  change,
  title,
  contacts,
  onApprove,
  onReject,
  onOpen,
  busy,
}: {
  change: Change;
  title: string;
  contacts: Contact[];
  onApprove: () => void;
  onReject: () => void;
  onOpen?: () => void;
  busy?: boolean;
}) {
  const c = change;
  const dateish = c.field === 'dueDate' || c.field === 'startDate';
  const who = c.source === 'claude' ? 'Claude 提议' : '批量操作';
  const body = (
    <>
      <div className="ph-card-meta">
        {who} · {title}
      </div>
      <div className="ph-card-diff">
        {c.field === 'delete' ? (
          '删除这个节点'
        ) : (
          <>
            {FIELD_LABEL[c.field] ?? c.field}{' '}
            <span className={dateish ? 'mono' : undefined}>
              {valueLabel(c.field, c.oldValue, contacts)} → {valueLabel(c.field, c.newValue, contacts)}
            </span>
          </>
        )}
      </div>
      {c.reason ? <div className="ph-card-reason">{c.reason}</div> : null}
    </>
  );
  return (
    <div className="ph-pending" data-testid={`change-${c.id}`}>
      {onOpen ? (
        <button type="button" className="ph-card-open" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className="ph-card-open">{body}</div>
      )}
      <div className="ph-card-actions">
        <PhoneBtn title="确认" kind="primary" grow onClick={onApprove} disabled={busy} testId={`approve-${c.id}`} />
        <PhoneBtn title="拒绝" width={96} onClick={onReject} disabled={busy} testId={`reject-${c.id}`} />
      </div>
    </div>
  );
}

export type TaskWhen = 'overdue' | 'today' | 'tomorrow' | 'week';

/**
 * A row of 要做的 (Main.dc.html): min-height 64, title 17/500, sub 13 (owner · 逾期 n 天 in red / 今天 / 明天),
 * right-aligned mono 15 date (red when overdue) and, for overdue rows with a contact owner, a trailing「催」.
 */
export function TaskRow({ entry, contacts, when, onClick, onNudge }: { entry: TodayEntry; contacts: Contact[]; when: TaskWhen; onClick: () => void; onNudge?: () => void }) {
  const n = entry.node;
  const owner = contactName(contacts, n.ownerId);
  const due = entry.derived.dueDate;
  const overdue = when === 'overdue';
  const sub = overdue ? `${owner} · 逾期 ${Math.max(entry.daysOverdue, 1)} 天` : when === 'today' ? `${owner} · 今天` : when === 'tomorrow' ? `${owner} · 明天` : `${owner} · ${due ? weekdayLabel(due) : ''}`;
  return (
    <div className="ph-task" data-testid={`task-${n.id}`}>
      <button type="button" className="ph-task-main" onClick={onClick}>
        <span className="ph-task-title">{n.title || '（无标题）'}</span>
        <span className={`ph-task-sub${overdue ? ' red' : ''}`}>{sub}</span>
      </button>
      <span className={`ph-task-date mono${overdue ? ' red' : ''}`}>{fmtDate(due)}</span>
      {overdue && n.ownerId && onNudge ? (
        <button type="button" className="ph-nudge" onClick={onNudge} aria-label="催办" data-testid={`nudge-${n.id}`}>
          催
        </button>
      ) : null}
    </div>
  );
}

/**
 * Bottom sheet (owner picker, chat history) or, with `full`, a full-screen sheet (新建项目).
 * Escape and the backdrop close it.
 */
export function Sheet({ title, onClose, children, full, right, testId }: { title?: string; onClose: () => void; children: ReactNode; full?: boolean; right?: ReactNode; testId?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className={`ph-backdrop${full ? ' full' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`ph-sheet${full ? ' full' : ''}`} role="dialog" aria-label={title} data-testid={testId}>
        {(title || full) && (
          <div className="ph-sheet-head">
            {full ? <HeaderLink title="取消" onClick={onClose} /> : <span className="ph-sheet-title">{title}</span>}
            {full && <span className="ph-sheet-title strong">{title}</span>}
            {right ?? (full ? <span style={{ width: 32 }} /> : null)}
          </div>
        )}
        <div className="ph-sheet-body">{children}</div>
      </div>
    </div>
  );
}
