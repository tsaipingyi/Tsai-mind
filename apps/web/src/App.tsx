import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Toasts } from './components/ui';
import { LoginPage } from './pages/Login';
import { TodayPage } from './pages/Today';
import { ProjectsPage } from './pages/Projects';
import { ProjectEditorPage } from './pages/ProjectEditor';
import { ContactsPage } from './pages/Contacts';
import { SettingsPage } from './pages/Settings';
import { PrintPage } from './pages/Print';
import { useSession } from './state/session';
import { onUnauthorized } from './api/client';
import { startRealtime, stopRealtime } from './api/realtime';
import { DEMO_BANNER, DEMO_TOKEN, isDemo } from './demo/flag';

function RequireAuth({ children }: { children: React.ReactElement }) {
  const token = useSession((s) => s.token);
  const loc = useLocation();
  if (!token) {
    // demo mode logs itself back in (App effect); never show the token form there
    if (isDemo) return <div className="page faint">演示模式登录中…</div>;
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  return children;
}

export function App() {
  const token = useSession((s) => s.token);
  const bootstrap = useSession((s) => s.bootstrap);
  const logout = useSession((s) => s.logout);
  const login = useSession((s) => s.login);
  const nav = useNavigate();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => onUnauthorized(() => {
    logout();
    nav('/login', { replace: true });
  }), [logout, nav]);

  useEffect(() => {
    if (token) startRealtime(token);
    else stopRealtime();
  }, [token]);

  // demo mode: no login page — (re)login with the fixed demo token whenever there is none (e.g. after 退出)
  useEffect(() => {
    if (isDemo && !token) void login(DEMO_TOKEN).catch(() => undefined);
  }, [token, login]);

  const body = (
    <>
      <Routes>
        <Route path="/login" element={isDemo ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route
          path="/projects/:id/print"
          element={
            <RequireAuth>
              <PrintPage />
            </RequireAuth>
          }
        />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<TodayPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectEditorPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/contacts/:id" element={<ContactsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toasts />
    </>
  );
  if (!isDemo) return body;
  return (
    <div className="demo-shell">
      <div className="demo-banner" role="status" data-testid="demo-banner">
        {DEMO_BANNER}
      </div>
      <div className="demo-main">{body}</div>
    </div>
  );
}
