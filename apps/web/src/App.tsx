import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Toasts } from './components/ui';
import { LoginPage } from './pages/Login';
import { TodayPage } from './pages/Today';
import { ProjectsPage } from './pages/Projects';
import { ProjectEditorPage } from './pages/ProjectEditor';
import { ContactsPage } from './pages/Contacts';
import { SettingsPage } from './pages/Settings';
import { PrintPage } from './pages/Print';
import { PhoneNodePage } from './pages/phone/Node';
import { PhoneClaudePage } from './pages/phone/Claude';
import { PhonePendingPage } from './pages/phone/Pending';
import { useSession } from './state/session';
import { useProject } from './state/project';
import { onUnauthorized } from './api/client';
import { startRealtime, stopRealtime } from './api/realtime';
import { DEMO_BANNER, DEMO_TOKEN, isDemo } from './demo/flag';
import { isCloud } from './cloud/mode';
import { useIsPhone } from './lib/useIsPhone';
import { PROJECT_CHANGED_EVENT } from './lib/cloud';

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

/** Phone node page; on a desktop-sized window the same URL opens the editor with that node selected. */
function NodeRoute() {
  const phone = useIsPhone();
  const { id, nodeId } = useParams();
  if (!phone) return <Navigate to={`/projects/${id}?node=${nodeId}`} replace />;
  return <PhoneNodePage />;
}

/** Phone Claude tab; the desktop has the chat as a panel inside the editor instead. */
function ClaudeRoute() {
  const phone = useIsPhone();
  if (!phone) return <Navigate to="/projects" replace />;
  return <PhoneClaudePage />;
}

function PendingRoute() {
  const phone = useIsPhone();
  if (!phone) return <Navigate to="/" replace />;
  return <PhonePendingPage />;
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

  // cloud mode pulled a newer copy of a project: reload it when it is the one on screen
  useEffect(() => {
    const onChanged = (e: Event) => {
      const projectId = (e as CustomEvent<{ projectId?: string }>).detail?.projectId;
      const st = useProject.getState();
      if (projectId && st.projectId === projectId) void st.reload();
    };
    window.addEventListener(PROJECT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PROJECT_CHANGED_EVENT, onChanged);
  }, []);

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
          <Route path="/pending" element={<PendingRoute />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectEditorPage />} />
          <Route path="/projects/:id/node/:nodeId" element={<NodeRoute />} />
          <Route path="/claude" element={<ClaudeRoute />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/contacts/:id" element={<ContactsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toasts />
    </>
  );
  if (!isDemo || isCloud) return body;
  return (
    <div className="demo-shell">
      <div className="demo-banner" role="status" data-testid="demo-banner">
        {DEMO_BANNER}
      </div>
      <div className="demo-main">{body}</div>
    </div>
  );
}
