import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../state/session';
import { useRealtime } from '../api/realtime';
import { useIsPhone } from '../lib/useIsPhone';
import { cloudStatusLabel, useCloudStatus } from '../lib/cloud';
import { TabBar } from './TabBar';

/** Small text pill for the cloud-persistence state; renders nothing when cloud mode is not in the build. */
export function CloudStatusPill({ className }: { className?: string }) {
  const status = useCloudStatus();
  if (!status) return null;
  const label = cloudStatusLabel(status);
  if (!label) return null;
  return (
    <span className={`cloud-pill ${status.state}${className ? ` ${className}` : ''}`} data-cloud-status={status.state} data-testid="cloud-status" title={status.message}>
      {label}
    </span>
  );
}

export function Layout() {
  const phone = useIsPhone();
  const account = useSession((s) => s.account);
  const logout = useSession((s) => s.logout);
  const connected = useRealtime((s) => s.connected);
  const attempted = useRealtime((s) => s.attempted);
  const nav = useNavigate();

  if (phone) {
    return (
      <div className="phone-app" data-testid="phone-app">
        <div className="phone-main">
          <Outlet />
        </div>
        <TabBar />
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">Tsai Mind</div>
        <nav>
          <NavLink to="/" end>
            今天
          </NavLink>
          <NavLink to="/projects">项目</NavLink>
          <NavLink to="/contacts">联系人</NavLink>
          <NavLink to="/settings">设置</NavLink>
        </nav>
        <div className="spacer" />
        <div className="account">
          <CloudStatusPill />
          <span className={`conn${!connected && attempted ? ' down' : ''}`} title={connected ? '实时连接正常' : '实时连接已断开，正在重连'}>
            <i /> {connected ? '已连接' : attempted ? '未连接' : '连接中'}
          </span>
          <span className="name">{account?.name || account?.email || ''}</span>
          <button
            className="btn sm"
            onClick={() => {
              logout();
              nav('/login');
            }}
          >
            退出
          </button>
        </div>
      </aside>
      <div className="main">
        <Outlet />
      </div>
    </div>
  );
}
