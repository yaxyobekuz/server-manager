import { NavLink, useNavigate } from 'react-router-dom';
import { Icon } from './Icons.jsx';
import { useMe, can, isOwner } from '../lib/useMe.js';
import logo from '../assets/logo.svg';

// perm: hidden unless the logged-in identity holds it (owner sees all);
// ownerOnly: never shown to created admins.
const nav = [
  { to: '/', label: 'Projects', icon: Icon.grid, end: true },
  { to: '/domains', label: 'Domains', icon: Icon.globe, perm: 'domainsGlobal' },
  { to: '/statistics', label: 'Statistics', icon: Icon.chart, perm: 'statistics' },
  { to: '/processes', label: 'Processes', icon: Icon.cpu, perm: 'processes' },
  { to: '/terminal', label: 'Terminal', icon: Icon.terminal, perm: 'terminal' },
  { to: '/admins', label: 'Admins', icon: Icon.shield, ownerOnly: true },
  { to: '/info', label: 'Information', icon: Icon.info, perm: 'serverInfo' },
];

export default function Shell({ children, onLogout }) {
  const navigate = useNavigate();
  const me = useMe();
  const items = nav.filter((i) => (i.ownerOnly ? isOwner(me) : !i.perm || can(me, i.perm)));

  return (
    <div className="min-h-full flex">
      <aside className="w-[230px] shrink-0 border-r border-line flex flex-col bg-bg-raised/40">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2.5 px-5 h-14 border-b border-line text-left"
        >
          <img src={logo} alt="Deploy logo" className="w-7 h-7 rounded-lg" />

          <span className="font-semibold text-white tracking-tight">Deploy</span>
        </button>

        <nav className="flex-1 p-3 space-y-0.5">
          {items.map(({ to, label, icon: I, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
                  isActive ? 'bg-bg-hover text-white' : 'text-muted hover:text-gray-200 hover:bg-bg-hover/50'
                }`
              }
            >
              <I className="text-current" /> {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-line">
          {me && me.role === 'admin' && (
            <p className="px-3 pb-2 text-[11px] text-muted truncate" title="Logged in as">
              admin · {me.name}
            </p>
          )}
          <button
            onClick={onLogout}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted hover:text-danger hover:bg-bg-hover w-full transition"
          >
            <Icon.logout /> Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-auto">{children}</main>
    </div>
  );
}
