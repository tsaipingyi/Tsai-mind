import { NavLink, useLocation } from 'react-router-dom';
import { ClaudeIcon, ProjectsIcon, TodayIcon } from './icons';

/**
 * Phone bottom tab bar (design/mobile-v2): 今天 / 项目 / Claude, 49px + the home-indicator inset,
 * 1px top line, 26px stroke icons, 11px labels, the current tab orange.
 */
export function TabBar() {
  const { pathname } = useLocation();
  const items = [
    { to: '/', label: '今天', Icon: TodayIcon, active: pathname === '/' || pathname.startsWith('/pending') },
    { to: '/projects', label: '项目', Icon: ProjectsIcon, active: pathname.startsWith('/projects') },
    { to: '/claude', label: 'Claude', Icon: ClaudeIcon, active: pathname.startsWith('/claude') },
  ];
  return (
    <nav className="tabbar" data-testid="tabbar" aria-label="主导航">
      {items.map(({ to, label, Icon, active }) => (
        <NavLink key={to} to={to} className={`tab${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} data-testid={`tab-${label}`}>
          <Icon />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
