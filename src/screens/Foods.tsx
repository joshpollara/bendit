import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type BrowsedFood } from '../lib/api';
import { useData } from '../lib/useData';
import { formatCalories } from '../lib/units';
import { useUI } from '../store/ui';
import type { Food } from '../types';
import { ChevronLeftIcon, SearchIcon, TrashIcon } from '../components/Icons';

type Filter = 'all' | Food['source'];

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'custom', label: 'Mine' },
  { key: 'openfoodfacts', label: 'Scanned' },
  { key: 'seed', label: 'Built-in' },
];

const SOURCE_LABELS: Record<Food['source'], string> = {
  custom: 'Mine',
  openfoodfacts: 'Open Food Facts',
  seed: 'Built-in',
};

function FoodRow({ food, onDelete }: { food: BrowsedFood; onDelete: (f: BrowsedFood) => void }) {
  return (
    <li className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{food.name}</p>
        <p className="truncate text-xs text-ink-muted">
          {food.brand ? `${food.brand} · ` : ''}
          {food.servingLabel} · {SOURCE_LABELS[food.source]}
          {food.usageCount > 0 ? ` · logged ${food.usageCount}×` : ''}
        </p>
      </div>
      <span className="text-sm font-medium tabular-nums text-ink-secondary">
        {formatCalories(food.caloriesPerServing)}
      </span>
      {food.source === 'seed' ? (
        <span className="w-7" aria-hidden="true" />
      ) : (
        <button
          type="button"
          aria-label={`Delete ${food.name}`}
          onClick={() => onDelete(food)}
          className="rounded-full p-1.5 text-ink-muted hover:bg-surface hover:text-over"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      )}
    </li>
  );
}

export default function Foods() {
  const navigate = useNavigate();
  const bump = useUI((s) => s.bump);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const q = query.trim();
  const foods = useData(
    () => api.browseFoods(q, filter === 'all' ? undefined : filter),
    [q, filter],
  );
  const counts = useData(() => api.foodCounts(), []);

  async function remove(food: BrowsedFood) {
    const warning =
      food.usageCount > 0
        ? `\n\n${food.usageCount} logged ${food.usageCount === 1 ? 'entry keeps' : 'entries keep'} its calories, listed by name.`
        : '';
    if (!window.confirm(`Delete "${food.name}" from your food database?${warning}`)) return;
    await api.deleteFood(food.id);
    bump();
  }

  const total = counts ? counts.custom + counts.openfoodfacts + counts.seed : undefined;

  return (
    <div className="pt-[env(safe-area-inset-top)] pb-4">
      <header className="flex items-center gap-1 px-2 py-3">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-ink-secondary hover:bg-card md:hidden"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold md:px-2">Food database</h1>
      </header>

      <div className="mx-4 flex items-center gap-2 rounded-xl border border-line bg-card px-3">
        <SearchIcon className="h-4 w-4 shrink-0 text-ink-muted" />
        <input
          type="search"
          placeholder="Filter foods"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full bg-transparent py-2.5 text-sm outline-none"
        />
      </div>

      <div className="mx-4 mt-3 grid grid-cols-4 rounded-xl bg-card p-1 text-center text-xs font-semibold">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-lg py-2 ${filter === f.key ? 'bg-accent text-white' : 'text-ink-secondary'}`}
          >
            {f.label}
            {counts && f.key !== 'all' ? ` ${counts[f.key]}` : ''}
            {counts && f.key === 'all' ? ` ${total}` : ''}
          </button>
        ))}
      </div>

      <p className="mx-4 mt-3 text-xs text-ink-muted">
        Built-in foods can't be deleted. Deleting a food leaves your logged entries untouched.
      </p>

      <div className="mx-4 mt-2 overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
        {foods === undefined ? (
          <p className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</p>
        ) : foods.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-muted">No foods match that filter.</p>
        ) : (
          <ul>
            {foods.map((f) => (
              <FoodRow key={f.id} food={f} onDelete={remove} />
            ))}
          </ul>
        )}
      </div>

      {foods && foods.length === 500 && (
        <p className="mx-4 mt-2 text-xs text-ink-muted">
          Showing the first 500 — narrow it down with the filter above.
        </p>
      )}
    </div>
  );
}
