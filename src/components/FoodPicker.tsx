import { useState } from 'react';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { formatCalories } from '../lib/units';
import type { Food } from '../types';
import { SearchIcon } from './Icons';

// Picking a food by name, for when a photo got it wrong or missed something.
//
// Deliberately small: a box and a list. It appears inside the correction sheet,
// where the surrounding context is already the meal being fixed, so it doesn't
// repeat any of it.

export default function FoodPicker({
  initialQuery = '',
  onPick,
  onCancel,
}: {
  initialQuery?: string;
  onPick: (food: Food) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const q = query.trim();
  const results = useData(async () => (q.length >= 2 ? api.searchFoods(q) : []), [q]);

  return (
    <div className="rounded-xl border border-accent bg-surface p-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            autoFocus
            className="w-full rounded-lg border border-line bg-card py-2 pl-8 pr-2 text-sm"
            placeholder="Search for the right food"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button type="button" onClick={onCancel} className="px-2 py-1 text-xs font-medium text-accent">
          Cancel
        </button>
      </div>

      {q.length >= 2 && (
        <ul className="mt-2 max-h-56 overflow-y-auto rounded-lg bg-card">
          {results === undefined && <li className="px-3 py-3 text-xs text-ink-muted">Searching…</li>}
          {results?.length === 0 && (
            <li className="px-3 py-3 text-xs text-ink-muted">Nothing found for “{q}”.</li>
          )}
          {results?.map((food) => (
            <li key={food.id}>
              <button
                type="button"
                onClick={() => onPick(food)}
                className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-surface"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{food.name}</span>
                  <span className="block truncate text-[11px] text-ink-muted">
                    {food.brand ? `${food.brand} · ` : ''}
                    {food.servingLabel}
                  </span>
                </span>
                <span className="text-xs tabular-nums text-ink-secondary">
                  {formatCalories(food.caloriesPerServing)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
