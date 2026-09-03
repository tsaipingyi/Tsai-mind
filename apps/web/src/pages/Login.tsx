import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../state/session';
import { errorMessage } from '../api/client';

export function LoginPage() {
  const token = useSession((s) => s.token);
  const login = useSession((s) => s.login);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? '/';

  if (token && !busy && !err) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await login(value);
      nav(from, { replace: true });
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand">Tsai Mind</div>
        <div className="sub">粘贴访问令牌登录。令牌由服务器命令行生成：pnpm --filter @tsai-mind/server token:create</div>
        <label className="field">
          <span>访问令牌</span>
          <input
            className="input mono"
            type="password"
            autoFocus
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="tm_…"
            aria-label="访问令牌"
          />
        </label>
        {err && (
          <div className="red" style={{ fontSize: 13, marginBottom: 12 }}>
            {err}
          </div>
        )}
        <button className="btn primary" type="submit" disabled={busy || !value.trim()} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? '验证中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
