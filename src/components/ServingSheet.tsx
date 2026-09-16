import { useState } from 'react';
import { MEAL_LABELS, MEALS, type Food, type Meal } from '../types';
import { formatCalories } from '../lib/units';
import type { Addition, DayStanding } from '../lib/macros';
import DayImpact from './DayImpact';
import NumberInput from './NumberInput';
import Sheet from './Sheet';

// The 3-tap logging surface: pick a food → adjust servings → add to a meal.
export default function ServingSheet({
  food,
  initialMeal,
  day,
  onClose,
  onAdd,
}: {
  food: Food;
  initialMeal: Meal;
  /** Where the day stands, so the sheet can show what this would do to it. */
  day?: DayStanding;
  onClose: () => void;
  onAdd: (servings: number, meal: Meal) => void;
}) {
  const [servings, setServings] = useState(1);
  const [meal, setMeal] = useState<Meal>(initialMeal);
  // Foods whose serving weight is known can be logged by weight instead —
  // essential for anything sold with a per-100g label.
  const gramsPerServing = food.servingGrams;
  const [byWeight, setByWeight] = useState(false);

  const step = (delta: number) => setServings((s) => Math.max(0.25, Math.round((s + delta) * 4) / 4));
  const calories = Math.round(food.caloriesPerServing * servings);
  const grams = gramsPerServing ? Math.round(servings * gramsPerServing) : undefined;
  // A food that doesn't record a macro adds an unknown to the day, not a zero.
  const adding: Addition = {
    calories,
    protein: food.protein == null ? null : food.protein * servings,
    carbs: food.carbs == null ? null : food.carbs * servings,
    fat: food.fat == null ? null : food.fat * servings,
  };

  const macro = (label: string, grams?: number) =>
    grams == null ? null : (
      <span>
        {label} {(grams * servings).toFixed(1).replace(/\.0$/, '')}g
      </span>
    );

  return (
    <Sheet onClose={onClose}>
      <div className="mb-1">
        <h2 className="text-lg font-semibold">{food.name}</h2>
        <p className="text-sm text-ink-muted">
          {food.brand ? `${food.brand} · ` : ''}
          {food.caloriesPerServing} cal per {food.servingLabel}
        </p>
      </div>

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
          <NumberInput
            inputMode="decimal"
            min={1}
            step={1}
            value={grams ?? null}
            onCommit={(g) => setServings(g / gramsPerServing)}
            className="w-32 rounded-xl border border-line bg-surface py-2 text-center text-2xl font-semibold tabular-nums"
            aria-label="Grams"
          />
          <span className="mt-1 text-xs text-ink-muted">
            grams · {gramsPerServing} g per {food.servingLabel}
          </span>
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
          <NumberInput
            inputMode="decimal"
            min={0.25}
            step={0.25}
            value={servings}
            onCommit={setServings}
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

      <div className="mb-4 text-center">
        <p className="text-3xl font-bold tabular-nums">{formatCalories(calories)}</p>
        <p className="text-xs uppercase tracking-wide text-ink-muted">
          calories{!byWeight && grams != null ? ` · ${grams} g` : ''}
        </p>
        <p className="mt-1 flex justify-center gap-3 text-xs text-ink-muted">
          {macro('P', food.protein)}
          {macro('C', food.carbs)}
          {macro('F', food.fat)}
        </p>
      </div>

      {day && <DayImpact day={day} adding={adding} />}

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

      <button
        type="button"
        onClick={() => onAdd(servings, meal)}
        className="w-full rounded-xl bg-accent py-3.5 font-semibold text-white active:bg-accent-deep"
      >
        Add to {MEAL_LABELS[meal]}
      </button>
    </Sheet>
  );
}
