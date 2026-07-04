import { NavLink, useNavigate } from 'react-router-dom';
import { Icon } from './Icons.jsx';
import logo from '../assets/logo.svg';

const nav = [
  { to: '/', label: 'Projects', icon: Icon.grid, end: true },
  { to: '/statistics', label: 'Statistics', icon: Icon.chart },
  { to: '/processes', label: 'Processes', icon: Icon.cpu },
];

export default function Shell({ children, onLogout }) {
  const navigate = useNavigate();
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
          {nav.map(({ to, label, icon: I, end }) => (
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
