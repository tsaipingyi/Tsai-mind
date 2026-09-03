import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../state/session';
import { useRealtime } from '../api/realtime';

export function Layout() {
  const account = useSession((s) => s.account);
  const logout = useSession((s) => s.logout);
  const connected = useRealtime((s) => s.connected);
  const attempted = useRealtime((s) => s.attempted);
  const nav = useNavigate();
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
        </nav>
        <div className="spacer" />
        <div className="account">
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
