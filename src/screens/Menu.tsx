import { Link } from 'react-router-dom';
import { BookIcon, ChevronRightIcon, ChipIcon, ClockIcon, ListIcon, MoreIcon } from '../components/Icons';

// The rest of the app, for phones. On a wide screen these sit in the sidebar;
// on a narrow one there is no room for them in a five-tab bar, so they live
// one tap away here rather than being buried inside a settings page.

const ITEMS = [
  { to: '/fasting', label: 'Fasting', hint: 'The clock, your goal, and past fasts', icon: ClockIcon },
  { to: '/foods', label: 'Foods', hint: 'The food database, and the ones you added', icon: ListIcon },
  { to: '/recipes', label: 'Recipes', hint: 'Recipes, and what a serving of each comes to', icon: BookIcon },
  { to: '/settings', label: 'Settings', hint: 'Profile, goals, reminders, your data', icon: MoreIcon },
  { to: '/ai-usage', label: 'AI usage', hint: 'Photo reads, what they cost, what failed', icon: ChipIcon },
];

export default function Menu() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-4">
      <h1 className="mb-1 text-xl font-semibold">More</h1>
      {ITEMS.map(({ to, label, hint, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          className="flex items-center gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm"
        >
          <Icon className="h-5 w-5 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{label}</span>
            <span className="block truncate text-xs text-ink-muted">{hint}</span>
          </span>
          <ChevronRightIcon className="h-5 w-5 text-ink-muted" />
        </Link>
      ))}
    </div>
  );
}
