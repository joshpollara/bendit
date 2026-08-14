import { useState } from 'react';
import { api, type JoinedEntry } from '../lib/api';
import { formatCalories } from '../lib/units';
import { MEALS, MEAL_LABELS, type Meal } from '../types';
import Sheet from './Sheet';
import MacroInputs, { macroFields, macroGrams } from './MacroFields';

// Edit something already logged: change the amount, move it to another meal, or
// remove it — without deleting and re-adding.

export default function EntrySheet({
  entry,
  onClose,
  onChanged,
}: {
  entry: JoinedEntry;
  onClose: () => void;
  onChanged: () => void;
}) {
  const food = entry.food;
  const gramsPerServing = food?.servingGrams;

  const [servings, setServings] = useState(entry.servings);
  const [calories, setCalories] = useState(String(Math.round(entry.caloriesCached)));
  const [label, setLabel] = useState(entry.label ?? '');
  const [macros, setMacros] = useState(macroFields(entry));
  const [meal, setMeal] = useState<Meal>(entry.meal);
  const [byWeight, setByWeight] = useState(false);

  // A food entry's calories follow from the serving count; a quick add has no
  // food behind it, so its calories are typed directly.
  const nextCalories = food ? Math.round(food.caloriesPerServing * servings) : Number(calories);
  const valid = food ? servings > 0 : Number.isFinite(nextCalories) && nextCalories > 0;
  const grams = gramsPerServing ? Math.round(servings * gramsPerServing) : undefined;

  async function save() {
    await api.updateLogEntry(entry.id, {
      meal,
      servings: food ? servings : 1,
      caloriesCached: nextCalories,
      label: food ? entry.label : label.trim() || 'Quick add',
      // A food's macros scale with the servings above; only an entry standing on
      // its own carries its own.
      proteinCached: food ? entry.proteinCached : macroGrams(macros.protein),
      carbsCached: food ? entry.carbsCached : macroGrams(macros.carbs),
      fatCached: food ? entry.fatCached : macroGrams(macros.fat),
    });
    onChanged();
  }

  async function remove() {
    await api.deleteLogEntry(entry.id);
    onChanged();
  }

  const step = (delta: number) =>
    setServings((s) => Math.max(0.25, Math.round((s + delta) * 4) / 4));

  return (
    <Sheet onClose={onClose}>
      <div className="mb-1">
        <h2 className="text-lg font-semibold">{food?.name ?? entry.label ?? 'Entry'}</h2>
        <p className="text-sm text-ink-muted">
          {food
            ? `${food.caloriesPerServing} cal per ${food.servingLabel}`
            : 'No food behind this one'}
        </p>
      </div>

      {food ? (
        <>
          {gramsPerServing && (
            <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-surface p-1 text-center text-xs font-semibold">
              <button
                type="button"
                onClick={() => setByWeight(false)}
                className={`rounded-lg py-2 ${!byWeight ? 'bg-accent text-white' : 'text-ink-secondary'}`}
              >
                Servings
              </button>
              <button
                type="button"
                onClick={() => setByWeight(true)}
                className={`rounded-lg py-2 ${byWeight ? 'bg-accent text-white' : 'text-ink-secondary'}`}
              >
                Grams
              </button>
            </div>
          )}

          {byWeight && gramsPerServing ? (
            <div className="my-4 flex flex-col items-center gap-1">
              <input
                type="number"
                inputMode="decimal"
                min={1}
                value={grams ?? ''}
                onChange={(e) => {
                  const g = Number(e.target.value);
                  if (Number.isFinite(g) && g > 0) setServings(g / gramsPerServing);
                }}
                className="w-32 rounded-xl border border-line bg-surface py-2 text-center text-2xl font-semibold tabular-nums"
                aria-label="Grams"
              />
              <span className="mt-1 text-xs text-ink-muted">grams</span>
            </div>
          ) : (
            <div className="my-4 flex items-center justify-center gap-4">
              <button
                type="button"
                aria-label="Fewer servings"
                onClick={() => step(-0.5)}
                className="h-11 w-11 rounded-full border border-line text-xl font-medium text-ink-secondary active:bg-surface"
              >
                −
              </button>
              <div className="flex flex-col items-center">
                <input
                  type="number"
                  inputMode="decimal"
                  min={0.25}
                  step={0.25}
                  value={servings}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v > 0) setServings(v);
                  }}
                  className="w-24 rounded-xl border border-line bg-surface py-2 text-center text-2xl font-semibold tabular-nums"
                  aria-label="Servings"
                />
                <span className="mt-1 text-xs text-ink-muted">servings</span>
              </div>
              <button
                type="button"
                aria-label="More servings"
                onClick={() => step(0.5)}
                className="h-11 w-11 rounded-full border border-line text-xl font-medium text-ink-secondary active:bg-surface"
              >
                +
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="my-4 flex flex-col gap-3">
          <label className="flex flex-col items-center gap-1">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={calories}
              onChange={(e) => setCalories(e.target.value)}
              className="w-36 rounded-xl border border-line bg-surface py-2.5 text-center text-3xl font-bold tabular-nums"
              aria-label="Calories"
            />
            <span className="text-xs uppercase tracking-wide text-ink-muted">calories</span>
          </label>
          <input
            className="w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm"
            placeholder="What was it?"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <MacroInputs values={macros} onChange={setMacros} />
        </div>
      )}

      {food && (
        <p className="mb-4 text-center text-2xl font-bold tabular-nums">
          {formatCalories(nextCalories)}
          <span className="ml-1 text-xs font-medium uppercase tracking-wide text-ink-muted">
            cal{grams != null && !byWeight ? ` · ${grams} g` : ''}
          </span>
        </p>
      )}

      <div className="mb-4 grid grid-cols-4 gap-2">
        {MEALS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMeal(m)}
            className={`rounded-full py-2 text-xs font-semibold ${
              meal === m ? 'bg-accent text-white' : 'bg-surface text-ink-secondary'
            }`}
          >
            {MEAL_LABELS[m]}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={remove}
          className="rounded-xl border border-over px-4 py-3.5 text-sm font-semibold text-over"
        >
          Remove
        </button>
        <button
          type="button"
          disabled={!valid}
          onClick={save}
          className="flex-1 rounded-xl bg-accent py-3.5 font-semibold text-white disabled:opacity-40"
        >
          Save changes
        </button>
      </div>
    </Sheet>
  );
}
