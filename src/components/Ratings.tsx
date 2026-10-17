import { Link } from 'react-router-dom';
import { api, type RecipeRatings } from '../lib/api';
import { useData } from '../lib/useData';
import { todayStr } from '../lib/dates';
import { useUI } from '../store/ui';

// Liked it, or not again: each person's say on a recipe, which steers what's
// suggested next.

/** The two buttons; tapping the chosen one again takes it back. */
export function RateButtons({ recipeId, yours, onRated }: { recipeId: string; yours: number; onRated?: (r: RecipeRatings) => void }) {
  const bump = useUI((s) => s.bump);
  async function rate(value: 1 | -1) {
    const next = await api.rateRecipe(recipeId, yours === value ? 0 : value);
    onRated?.(next);
    bump();
  }
  const style = (on: boolean) =>
    `rounded-full border px-3 py-1.5 text-xs font-semibold ${on ? 'border-accent bg-accent text-white' : 'border-line text-ink-secondary'}`;
  return (
    <span className="flex gap-2">
      <button type="button" aria-pressed={yours === 1} onClick={() => void rate(1)} className={style(yours === 1)}>
        Liked it
      </button>
      <button type="button" aria-pressed={yours === -1} onClick={() => void rate(-1)} className={style(yours === -1)}>
        Not again
      </button>
    </span>
  );
}

/** "ann liked it · ben: not again". */
export function whoRated(ratings: RecipeRatings | undefined) {
  return (ratings?.people ?? [])
    .map((p) => `${p.username} ${p.rating > 0 ? 'liked it' : 'not again'}`)
    .join(' · ');
}

/** On Today: recipes from the plan eaten lately and not yet rated. */
export function RateRecent({ date }: { date: string }) {
  const list = useData(() => (date === todayStr() ? api.toRate(date) : Promise.resolve([])), [date]);
  if (!list?.length) return null;
  return (
    <section className="mx-4 mt-3 rounded-2xl border border-line bg-card px-4 py-3 shadow-sm lg:mx-0 lg:mt-0">
      <h2 className="font-semibold">How was it?</h2>
      <ul className="mt-1 divide-y divide-line">
        {list.map((r) => (
          <li key={r.recipeId} className="flex flex-wrap items-center gap-2 py-2">
            <Link to={`/recipes/${r.recipeId}`} className="min-w-0 flex-1 truncate text-sm">
              {r.name}
            </Link>
            <RateButtons recipeId={r.recipeId} yours={0} />
          </li>
        ))}
      </ul>
    </section>
  );
}
