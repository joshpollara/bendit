import { NavLink } from 'react-router-dom';
import {
  FlameIcon,
  GaugeIcon,
  ListIcon,
  MoreIcon,
  PlusIcon,
  ScaleIcon,
  SearchIcon,
  TrendIcon,
} from './Icons';

// Desktop navigation. Replaces the bottom tab bar from `md` up, where a
// thumb-reach bar pinned to the bottom of a large window reads as a phone
// mock-up rather than a website.
const LINKS = [
  { to: '/', label: 'Budget', icon: <GaugeIcon className="h-5 w-5" /> },
  { to: '/weight', label: 'Weight', icon: <ScaleIcon className="h-5 w-5" /> },
  { to: '/reports', label: 'Reports', icon: <TrendIcon className="h-5 w-5" /> },
  { to: '/foods', label: 'Foods', icon: <ListIcon className="h-5 w-5" /> },
  { to: '/more', label: 'More', icon: <MoreIcon className="h-5 w-5" /> },
];

const ACTIONS = [
  { to: '/add-food', label: 'Log food', icon: <SearchIcon className="h-5 w-5" /> },
  { to: '/add-food?tab=quick', label: 'Quick add calories', icon: <PlusIcon className="h-5 w-5" /> },
  { to: '/add-exercise', label: 'Log exercise', icon: <FlameIcon className="h-5 w-5" /> },
  { to: '/weight?log=1', label: 'Log weight', icon: <ScaleIcon className="h-5 w-5" /> },
];

export default function SideNav() {
  return (
    <aside className="hidden shrink-0 md:block md:w-56">
      <div className="sticky top-8">
        <h1 className="px-3 pb-4 text-xl font-bold tracking-tight">
          Bend It<span className="text-amber">!</span>
        </h1>

        <nav className="flex flex-col gap-1">
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium ${
                  isActive ? 'bg-accent-soft text-accent-deep' : 'text-ink-secondary hover:bg-card'
                }`
              }
            >
              {l.icon}
              {l.label}
            </NavLink>
          ))}
        </nav>

        <p className="mt-6 px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          Log
        </p>
        <nav className="flex flex-col gap-1">
          {ACTIONS.map((a) => (
            <NavLink
              key={a.label}
              to={a.to}
              className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-ink-secondary hover:bg-card"
            >
              {a.icon}
              {a.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </aside>
  );
}
