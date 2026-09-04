import { useEffect, type ReactNode } from 'react';
import type { Contact, NodeStatus } from '@tsai-mind/core';
import { STATUS_COLOR, STATUS_LABEL, initial } from '../lib/util';
import { useToasts } from '../state/toast';

export function Avatar({ contact, ownerId, size }: { contact?: Contact | undefined; ownerId?: string | null; size?: 'lg' }) {
  const cls = `avatar${size === 'lg' ? ' lg' : ''}`;
  if (ownerId === null || (!contact && ownerId == null)) {
    return (
      <span className={`${cls} me`} title="我">
        我
      </span>
    );
  }
  const name = contact?.name ?? '?';
  return (
    <span className={cls} title={name}>
      {initial(name)}
    </span>
  );
}

export function StatusPill({
  status,
  active = true,
  onClick,
}: {
  status: NodeStatus;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <span
      className={`pill st-${status}${active ? '' : ' off'}${onClick ? ' clickable' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function ProgressRing({ progress, status, size = 16 }: { progress: number; status: NodeStatus; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, progress));
  const color = STATUS_COLOR[status];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: 'none' }} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={2.5} />
      {p > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeDasharray={`${(c * p) / 100} ${c}`}
          strokeLinecap="butt"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
}

export function Dialog({ title, onClose, children, width }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
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
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={title} style={width ? { width } : undefined}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => !t.actions?.length && dismiss(t.id)} role="status">
          {t.text}
          {t.actions && t.actions.length > 0 && (
            <div className="toast-actions">
              {t.actions.map((a) => (
                <button key={a.label} className={`btn sm${a.primary ? ' primary' : ''}`} onClick={a.run}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
