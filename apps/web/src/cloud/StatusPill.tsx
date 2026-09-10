/**
 * Minimal cloud-status pill rendered from main.tsx as a fallback. It hides itself as soon as the
 * layout renders its own consumer (an element carrying `data-cloud-status`, or its `.cloud-pill`).
 */
import { useEffect, useState } from 'react';
import { CLOUD_STATE_LABEL, useCloudStatus } from './status';

const COLORS: Record<string, string> = {
  loading: '#999',
  ready: '#2e9e5b',
  saving: '#e8842a',
  offline: '#999',
  error: '#d33',
};

export function CloudStatusFallback() {
  const state = useCloudStatus((s) => s.state);
  const message = useCloudStatus((s) => s.message);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      setHidden(!!document.querySelector('[data-cloud-status], .cloud-pill'));
    };
    check();
    const mo = new MutationObserver(() => {
      if (!raf) raf = requestAnimationFrame(check);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  if (hidden) return null;
  const label = CLOUD_STATE_LABEL[state];
  return (
    <div
      id="cloud-status"
      data-testid="cloud-status"
      data-state={state}
      role="status"
      title={message ?? label}
      style={{
        position: 'fixed',
        left: 12,
        bottom: 12,
        zIndex: 60,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        background: '#fff',
        border: '1px solid #f0a060',
        color: '#333',
        font: '12px/1.4 system-ui, sans-serif',
        boxShadow: '0 1px 3px rgba(0,0,0,.08)',
        pointerEvents: 'auto',
        maxWidth: 'min(70vw, 420px)',
      }}
    >
      <i style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS[state] ?? '#999', flex: 'none' }} />
      <span>{label}</span>
      {(state === 'offline' || state === 'error') && message && <span style={{ color: '#777', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {message}</span>}
    </div>
  );
}
