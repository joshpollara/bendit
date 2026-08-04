import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import Sheet from './Sheet';
import { FlameIcon, GaugeIcon, MoreIcon, PlusIcon, ScaleIcon, SearchIcon, TrendIcon } from './Icons';

function Tab({ to, label, icon }: { to: string; label: string; icon: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium ${
          isActive ? 'text-accent' : 'text-ink-muted'
        }`
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}

export default function TabBar() {
  const [quickAdd, setQuickAdd] = useState(false);
  const navigate = useNavigate();

  const go = (path: string) => {
    setQuickAdd(false);
    navigate(path);
  };

  return (
    <>
      <nav className="fixed bottom-0 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="grid grid-cols-5 items-center">
          <Tab to="/" label="Today" icon={<GaugeIcon className="h-6 w-6" />} />
          <Tab to="/weight" label="Body" icon={<ScaleIcon className="h-6 w-6" />} />
          <div className="flex justify-center">
            <button
              type="button"
              aria-label="Quick add"
              onClick={() => setQuickAdd(true)}
              className="-mt-6 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg active:bg-accent-deep"
            >
              <PlusIcon className="h-7 w-7" />
            </button>
          </div>
          <Tab to="/reports" label="Reports" icon={<TrendIcon className="h-6 w-6" />} />
          <Tab to="/more" label="More" icon={<MoreIcon className="h-6 w-6" />} />
        </div>
      </nav>

      {quickAdd && (
        <Sheet onClose={() => setQuickAdd(false)}>
          <p className="mb-2 text-sm font-semibold text-ink-secondary">Quick add</p>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => go('/add-food')}
              className="flex items-center gap-3 rounded-xl px-3 py-3 text-left font-medium hover:bg-surface"
            >
              <SearchIcon className="h-5 w-5 text-accent" /> Log Food
            </button>
            <button
              type="button"
              onClick={() => go('/add-food?tab=quick')}
              className="flex items-center gap-3 rounded-xl px-3 py-3 text-left font-medium hover:bg-surface"
            >
              <PlusIcon className="h-5 w-5 text-accent" /> Quick Add Calories
            </button>
            <button
              type="button"
              onClick={() => go('/add-exercise')}
              className="flex items-center gap-3 rounded-xl px-3 py-3 text-left font-medium hover:bg-surface"
            >
              <FlameIcon className="h-5 w-5 text-accent" /> Log Exercise
            </button>
            <button
              type="button"
              onClick={() => go('/weight?log=1')}
              className="flex items-center gap-3 rounded-xl px-3 py-3 text-left font-medium hover:bg-surface"
            >
              <ScaleIcon className="h-5 w-5 text-accent" /> Log Weight
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
