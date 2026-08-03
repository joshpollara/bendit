import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { todayStr } from '../lib/dates';
import { caloriesBurned, EXERCISES, type ExerciseType } from '../lib/mets';
import { formatCalories } from '../lib/units';
import { useUI } from '../store/ui';
import type { Profile } from '../types';
import Sheet from '../components/Sheet';
import { ChevronLeftIcon, FlameIcon, SearchIcon } from '../components/Icons';

export default function AddExercise({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const date = params.get('date') ?? todayStr();
  const setDate = useUI((s) => s.setDate);
  const bump = useUI((s) => s.bump);

  const weights = useData(() => api.getWeights(), []);
  const weightKg = weights?.[weights.length - 1]?.weightKg ?? profile.startWeightKg;

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ExerciseType | null>(null);
  const [customOpen, setCustomOpen] = useState(false);

  const [minutes, setMinutes] = useState(30);
  const [calsOverride, setCalsOverride] = useState<string | null>(null);
  const [customName, setCustomName] = useState('');

  const q = query.trim().toLowerCase();
  const list = EXERCISES.filter((e) => e.name.toLowerCase().includes(q));

  const estimated = selected ? caloriesBurned(selected.met, weightKg, minutes) : 0;
  const calories = calsOverride !== null ? Math.max(0, Math.round(Number(calsOverride) || 0)) : estimated;

  function openExercise(e: ExerciseType) {
    setSelected(e);
    setMinutes(30);
    setCalsOverride(null);
  }

  function openCustom() {
    setCustomOpen(true);
    setCustomName('');
    setMinutes(30);
    setCalsOverride('');
  }

  async function save(name: string, kcal: number) {
    await api.addExercise({ date, name, minutes, caloriesBurned: kcal });
    bump();
    setDate(date);
    navigate('/');
  }

  const minutesField = (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-secondary">Minutes</span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        value={minutes}
        onChange={(e) => {
          const v = Math.max(1, Math.round(Number(e.target.value) || 0));
          setMinutes(v);
        }}
        className="rounded-xl border border-line bg-surface px-3 py-2.5 text-lg font-semibold tabular-nums"
      />
    </label>
  );

  return (
    <div className="pt-[env(safe-area-inset-top)]">
      <header className="flex items-center gap-1 px-2 py-3">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-ink-secondary hover:bg-card"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">Add Exercise</h1>
      </header>

      <div className="mx-4 flex items-center gap-2 rounded-xl border border-line bg-card px-3">
        <SearchIcon className="h-4 w-4 shrink-0 text-ink-muted" />
        <input
          type="search"
          placeholder="Search exercises"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full bg-transparent py-2.5 text-sm outline-none"
        />
      </div>

      <div className="mx-4 mt-3 mb-4 overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
        <button
          type="button"
          onClick={openCustom}
          className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left font-medium text-accent hover:bg-surface"
        >
          <FlameIcon className="h-5 w-5" /> Custom exercise…
        </button>
        {list.map((e) => (
          <button
            key={e.name}
            type="button"
            onClick={() => openExercise(e)}
            className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-surface"
          >
            <span className="flex-1 text-sm font-medium">{e.name}</span>
            <span className="text-xs text-ink-muted">
              ~{formatCalories(caloriesBurned(e.met, weightKg, 30))} cal / 30 min
            </span>
          </button>
        ))}
        {list.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-ink-muted">
            No matches — try the custom option above.
          </p>
        )}
      </div>

      {selected && (
        <Sheet onClose={() => setSelected(null)}>
          <h2 className="text-lg font-semibold">{selected.name}</h2>
          <p className="mb-4 text-sm text-ink-muted">
            Estimated from your weight ({Math.round(weightKg)} kg) · {selected.met} METs
          </p>
          <div className="mb-4 grid grid-cols-2 gap-3">
            {minutesField}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-secondary">Calories burned</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                value={calsOverride !== null ? calsOverride : String(estimated)}
                onChange={(e) => setCalsOverride(e.target.value)}
                className="rounded-xl border border-line bg-surface px-3 py-2.5 text-lg font-semibold tabular-nums"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={() => save(selected.name, calories)}
            className="w-full rounded-xl bg-accent py-3.5 font-semibold text-white active:bg-accent-deep"
          >
            Add · +{formatCalories(calories)} cal
          </button>
        </Sheet>
      )}

      {customOpen && (
        <Sheet onClose={() => setCustomOpen(false)}>
          <h2 className="mb-4 text-lg font-semibold">Custom exercise</h2>
          <div className="mb-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-secondary">Name</span>
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. Kickboxing"
                className="rounded-xl border border-line bg-surface px-3 py-2.5 text-sm"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              {minutesField}
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink-secondary">Calories burned</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={calsOverride ?? ''}
                  onChange={(e) => setCalsOverride(e.target.value)}
                  className="rounded-xl border border-line bg-surface px-3 py-2.5 text-lg font-semibold tabular-nums"
                />
              </label>
            </div>
          </div>
          <button
            type="button"
            disabled={customName.trim() === '' || calories <= 0}
            onClick={() => save(customName.trim(), calories)}
            className="w-full rounded-xl bg-accent py-3.5 font-semibold text-white disabled:opacity-40"
          >
            Add · +{formatCalories(calories)} cal
          </button>
        </Sheet>
      )}
    </div>
  );
}
