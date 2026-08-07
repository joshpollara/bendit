import { NavLink } from 'react-router-dom';
import {
  BookIcon,
  ChipIcon,
  FlameIcon,
  GaugeIcon,
  ListIcon,
  PersonIcon,
  PlusIcon,
  ScaleIcon,
  SearchIcon,
  TrendIcon,
} from './Icons';

// Desktop navigation. Replaces the bottom tab bar from `md` up, where a
// thumb-reach bar pinned to the bottom of a large window reads as a phone
// mock-up rather than a website.
//
// Grouped by what each screen is for. A flat list put "the food database" beside
// "today's calories" as though they were the same kind of thing, and left
// settings sitting in the same row as places you visit daily.

const GROUPS = [
  {
    label: 'Your day',
    links: [
      { to: '/', label: 'Today', icon: <GaugeIcon className="h-5 w-5" /> },
      { to: '/weight', label: 'Progress', icon: <ScaleIcon className="h-5 w-5" /> },
      { to: '/reports', label: 'Reports', icon: <TrendIcon className="h-5 w-5" /> },
    ],
  },
  {
    label: 'Food',
    links: [
      { to: '/foods', label: 'Foods', icon: <ListIcon className="h-5 w-5" /> },
      { to: '/recipes', label: 'Recipes', icon: <BookIcon className="h-5 w-5" /> },
    ],
  },
  {
    label: null,
    links: [
      { to: '/settings', label: 'Settings', icon: <PersonIcon className="h-5 w-5" /> },
      { to: '/ai-usage', label: 'AI usage', icon: <ChipIcon className="h-5 w-5" /> },
    ],
  },
];

// Things you do, rather than places you go.
const ACTIONS = [
  { to: '/add-food', label: 'Log food', icon: <SearchIcon className="h-5 w-5" /> },
  { to: '/add-food?tab=quick', label: 'Quick add calories', icon: <PlusIcon className="h-5 w-5" /> },
  { to: '/add-exercise', label: 'Log exercise', icon: <FlameIcon className="h-5 w-5" /> },
  { to: '/weight?log=1', label: 'Log weight', icon: <ScaleIcon className="h-5 w-5" /> },
];

const heading = 'px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted';

export default function SideNav() {
  return (
    <aside className="hidden shrink-0 md:block md:w-56">
      <div className="sticky top-8">
        <h1 className="px-3 pb-4 text-xl font-bold tracking-tight">
          Bend It<span className="text-amber">!</span>
        </h1>

        {GROUPS.map((group, index) => (
          <div key={group.label ?? 'settings'} className={index === 0 ? '' : 'mt-5'}>
            {group.label && <p className={heading}>{group.label}</p>}
            <nav className="flex flex-col gap-1">
              {group.links.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.to === '/'}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium ${
                      isActive ? 'bg-accent-soft text-accent-deep' : 'text-ink-secondary hover:bg-card'
                    }`
                  }
                >
                  {link.icon}
                  {link.label}
                </NavLink>
              ))}
            </nav>
          </div>
        ))}

        <p className={`mt-6 ${heading}`}>Log</p>
        <nav className="flex flex-col gap-1">
          {ACTIONS.map((action) => (
            <NavLink
              key={action.label}
              to={action.to}
              className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-ink-secondary hover:bg-card"
            >
              {action.icon}
              {action.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </aside>
  );
}
