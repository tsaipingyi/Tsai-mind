import { useState, type FormEvent } from 'react';
import type { PageLock } from '../lib/lock';
import { rememberUnlocked, verifyLock } from '../lib/lock';

/** Full-page password prompt shown before any content when the account has a page lock. */
export function LockScreen({ lock, onUnlock }: { lock: PageLock; onUnlock: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value || busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (await verifyLock(lock, value)) {
        rememberUnlocked(lock);
        setValue('');
        onUnlock();
      } else {
        setErr('密码不对');
        setValue('');
      }
    } catch {
      setErr('这个浏览器不支持密码校验（需要 HTTPS）');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login lock" data-testid="lock-screen">
      <form className="card" onSubmit={submit}>
        <div className="brand">Tsai Mind</div>
        <div className="sub">这个页面已加锁，输入密码继续。</div>
        <label className="field">
          <span>密码</span>
          <input
            className="input"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="页面密码"
          />
        </label>
        {err && (
          <div className="red" style={{ fontSize: 13, marginBottom: 12 }}>
            {err}
          </div>
        )}
        <button className="btn primary" type="submit" disabled={busy || !value} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? '校验中…' : '解锁'}
        </button>
      </form>
    </div>
  );
}
