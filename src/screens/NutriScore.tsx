import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type GradedFood, type NutriGrade } from '../lib/api';
import { useData } from '../lib/useData';
import { ChevronLeftIcon, SearchIcon } from '../components/Icons';
import Sheet from '../components/Sheet';
import { GRADE_STYLE } from '../components/MealGrade';

const GRADES: NutriGrade[] = ['A', 'B', 'C', 'D', 'E'];

/** The score each grade covers, for foods. Drinks are banded separately. */
const BANDS: Record<NutriGrade, string> = {
  A: 'Score −1 or less',
  B: 'Score 0 to 2',
  C: 'Score 3 to 10',
  D: 'Score 11 to 18',
  E: 'Score 19 or more',
};

const amount = (value: number | null, unit: string) =>
  value == null ? '—' : `${Math.round(value * 10) / 10} ${unit}`;

function Badge({ grade, large = false }: { grade: NutriGrade; large?: boolean }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded font-bold ${GRADE_STYLE[grade]} ${
        large ? 'h-9 w-9 text-base' : 'h-5 w-5 text-[11px]'
      }`}
    >
      {grade}
    </span>
  );
}

function PointsRow({
  label,
  value,
  points,
  max,
  muted = false,
}: {
  label: string;
  value: string;
  points: number;
  max: number;
  muted?: boolean;
}) {
  return (
    <tr className={`border-b border-line last:border-b-0 ${muted ? 'text-ink-muted' : ''}`}>
      <td className="py-1.5">{label}</td>
      <td className="py-1.5 text-right tabular-nums text-ink-secondary">{value}</td>
      <td className={`w-16 py-1.5 text-right tabular-nums ${muted ? 'line-through' : 'font-medium'}`}>
        {points}/{max}
      </td>
    </tr>
  );
}

function Breakdown({ food }: { food: GradedFood }) {
  const b = food.breakdown;
  const unit = food.basis === 'ml' ? '100 ml' : '100 g';
  if (!b || food.score == null) {
    return <p className="text-sm text-ink-muted">Grade as published by the source.</p>;
  }
  const against = b.energy + b.sugars + b.satFat + b.sodium;
  const forIt = b.fibre + b.fruitVeg + (b.proteinCounted ? b.protein : 0);

  return (
    <div className="space-y-4 text-sm">
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Against · per {unit}
        </h3>
        <table className="w-full">
          <tbody>
            <PointsRow label="Energy" value={amount(food.kcal100, 'kcal')} points={b.energy} max={10} />
            <PointsRow label="Sugars" value={amount(food.sugar100, 'g')} points={b.sugars} max={10} />
            <PointsRow label="Saturated fat" value={amount(food.satFat100, 'g')} points={b.satFat} max={10} />
            <PointsRow label="Sodium" value={amount(food.sodiumMg100, 'mg')} points={b.sodium} max={10} />
          </tbody>
        </table>
      </div>
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          For · per {unit}
        </h3>
        <table className="w-full">
          <tbody>
            <PointsRow label="Fibre" value={amount(food.fiber100, 'g')} points={b.fibre} max={5} />
            <PointsRow
              label="Protein"
              value={amount(food.protein100, 'g')}
              points={b.protein}
              max={5}
              muted={!b.proteinCounted}
            />
            <PointsRow label="Fruit, veg and nuts" value={amount(food.fruitVeg, '%')} points={b.fruitVeg} max={5} />
          </tbody>
        </table>
        {!b.proteinCounted && (
          <p className="mt-1 text-xs text-ink-muted">
            Protein doesn't count with 11 or more points against.
          </p>
        )}
      </div>
      <div className="flex items-center justify-between rounded-xl bg-surface px-3 py-2.5">
        <span className="tabular-nums">
          {against} − {forIt} = <span className="font-semibold">{food.score}</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-ink-muted">
          {b.beverage ? 'Drink' : BANDS[food.grade]}
          <Badge grade={food.grade} />
        </span>
      </div>
      {food.published && (
        <p className="text-xs text-ink-muted">The grade is the one the source publishes.</p>
      )}
    </div>
  );
}

export default function NutriScore() {
  const navigate = useNavigate();
  const [grade, setGrade] = useState<NutriGrade>('A');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<GradedFood | null>(null);

  const q = query.trim();
  const guide = useData(() => api.nutriScoreGuide(grade, q), [grade, q]);
  // The previous answer stays on screen while the next loads, so the counts
  // don't flicker away on every keystroke.
  const shown = guide?.grade === grade ? guide : undefined;

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
        <h1 className="text-lg font-semibold md:px-2 lg:text-2xl lg:font-bold lg:tracking-tight">
          Nutri-Score
        </h1>
      </header>

      <div className="mx-4 flex items-center gap-2 rounded-xl border border-line bg-card px-3 lg:mx-0">
        <SearchIcon className="h-4 w-4 shrink-0 text-ink-muted" />
        <input
          type="search"
          placeholder="Filter foods"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full bg-transparent py-2.5 text-sm outline-none"
        />
      </div>

      <div className="mx-4 mt-3 grid grid-cols-5 gap-1 rounded-xl bg-card p-1 lg:mx-0">
        {GRADES.map((g) => (
          <button
            key={g}
            type="button"
            aria-pressed={grade === g}
            onClick={() => setGrade(g)}
            className={`flex flex-col items-center rounded-lg py-1.5 ${
              grade === g ? GRADE_STYLE[g] : 'text-ink-secondary'
            }`}
          >
            <span className="text-sm font-bold">{g}</span>
            <span className="text-[11px] tabular-nums opacity-80">{guide?.counts[g] ?? ''}</span>
          </button>
        ))}
      </div>
      <p className="mx-4 mt-2 text-xs text-ink-muted lg:mx-0">{BANDS[grade]}</p>

      <div className="mx-4 mt-2 overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:mx-0">
        {shown === undefined ? (
          <p className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</p>
        ) : shown.foods.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-muted">No foods in this grade.</p>
        ) : (
          <ul>
            {shown.foods.map((food) => (
              <li key={food.id} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  onClick={() => setOpen(food)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{food.name}</span>
                    <span className="block truncate text-xs text-ink-muted">
                      {food.kcal100 != null ? `${Math.round(food.kcal100)} kcal per 100 ${food.basis}` : ''}
                    </span>
                  </span>
                  {food.score != null && (
                    <span className="text-sm tabular-nums text-ink-secondary">{food.score}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {shown && shown.total > shown.foods.length && (
        <p className="mx-4 mt-2 text-xs text-ink-muted lg:mx-0">
          Showing {shown.foods.length} of {shown.total} — narrow it down with the filter above.
        </p>
      )}

      {open && (
        <Sheet onClose={() => setOpen(null)}>
          <div className="mb-4 flex items-start gap-3">
            <Badge grade={open.grade} large />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold leading-tight">{open.name}</h2>
              <p className="text-xs text-ink-muted">{open.servingLabel}</p>
            </div>
          </div>
          <Breakdown food={open} />
        </Sheet>
      )}
    </div>
  );
}
