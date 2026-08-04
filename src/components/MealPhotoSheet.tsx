import { useState } from 'react';
import { api } from '../lib/api';
import {
  itemFromFood,
  rescaleItem,
  totalsFor,
  unitOptions,
  type MealEstimate,
  type MealItem,
} from '../lib/mealPhoto';
import { formatCalories } from '../lib/units';
import type { Food, Meal } from '../types';
import FoodPicker from './FoodPicker';
import Sheet from './Sheet';

// What a photographed plate turned into, before any of it is logged.
//
// Built around one fact: identifying the food is the easy part and judging how
// much of it there is, is not. So the amount is the control — first, editable,
// and adjustable in the units the packet or the kitchen uses rather than only
// in grams. The calories carry the range that amount implies, and typing an
// amount collapses the range, because an amount someone knows is not a guess.
//
// Everything the model produced can be overruled: the food it matched, the
// weight, whether the item belongs at all, and anything it missed entirely.

const CONFIDENCE_LABEL: Record<string, string> = {
  high: 'clear',
  medium: 'rough',
  low: 'unsure',
};

const CONFIDENCE_STYLE: Record<string, string> = {
  high: 'bg-good-soft text-good',
  medium: 'bg-warn-soft text-warn-deep',
  low: 'bg-over-soft text-over',
};

export default function MealPhotoSheet({
  estimate,
  meal,
  onLog,
  onClose,
}: {
  estimate: MealEstimate;
  meal: Meal;
  onLog: (items: MealItem[], meal: Meal) => Promise<void> | void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<MealItem[]>(estimate.items);
  const [chosenMeal, setChosenMeal] = useState<Meal>(meal);
  const [picking, setPicking] = useState<number | 'new' | null>(null);
  const [saveAs, setSaveAs] = useState(false);
  const [saving, setSaving] = useState(false);

  const total = totalsFor(items);
  const loggable = items.filter((item) => item.food && item.nutrition);
  const anyEstimated = loggable.some((item) => (item.error ?? 0) > 0);

  const update = (index: number, next: MealItem) =>
    setItems((current) => current.map((item, i) => (i === index ? next : item)));

  const setGrams = (index: number, grams: number) =>
    update(index, rescaleItem(items[index], grams));

  /** Swapping the food keeps the weight: the plate didn't change, the name did. */
  const swap = (index: number, food: Food) => {
    update(index, itemFromFood(food, items[index].grams, items[index].name));
    setPicking(null);
  };

  const add = (food: Food) => {
    // A food the photo missed starts at its own serving, which is the amount a
    // person is most likely to have had.
    setItems((current) => [...current, itemFromFood(food, food.servingGrams || 100)]);
    setPicking(null);
  };

  const remove = (index: number) => setItems((current) => current.filter((_, i) => i !== index));

  async function log() {
    setSaving(true);
    try {
      if (saveAs) await saveTemplate();
      await onLog(loggable, chosenMeal);
    } finally {
      setSaving(false);
    }
  }

  /** Repeat meals are most of most diets; a saved meal re-logs in one tap. */
  async function saveTemplate() {
    const name = window.prompt('Save this meal as:', loggable.map((i) => i.food?.name).join(', ').slice(0, 40));
    if (!name?.trim()) return;
    await api.createMealTemplate(
      name.trim(),
      loggable.map((item) => ({
        foodId: item.food?.id ?? null,
        servings: item.servings ?? item.grams / 100,
        caloriesCached: Math.round(item.nutrition?.calories ?? 0),
      })),
    );
  }

  return (
    <Sheet onClose={onClose}>
      <h2 className="text-lg font-semibold">What&apos;s on the plate</h2>
      <p className="mt-1 text-xs text-ink-muted">Check the weights before adding them.</p>

      <ul className="mt-3 flex flex-col gap-2">
        {items.map((item, index) => {
          const units = unitOptions(item);
          return (
            <li key={`${item.name}:${index}`} className="rounded-xl border border-line p-3">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => setPicking(picking === index ? null : index)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm font-medium">
                    {item.food?.name ?? item.name}
                    <span className="ml-1 text-xs font-normal text-accent">change</span>
                  </p>
                  <p className="truncate text-xs text-ink-muted">
                    {item.food ? (
                      <>
                        {item.food.brand ? `${item.food.brand} · ` : ''}
                        {item.seenAs ? `seen as “${item.seenAs}”` : 'you chose this'}
                      </>
                    ) : (
                      `“${item.name}” isn't in the database — pick something`
                    )}
                  </p>
                </button>
                {item.confidence && item.error !== 0 && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      CONFIDENCE_STYLE[item.confidence] ?? ''
                    }`}
                  >
                    {CONFIDENCE_LABEL[item.confidence] ?? item.confidence}
                  </span>
                )}
              </div>

              {picking === index && (
                <div className="mt-2">
                  <FoodPicker
                    initialQuery={item.name}
                    onPick={(food) => swap(index, food)}
                    onCancel={() => setPicking(null)}
                  />
                </div>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  aria-label={`Grams of ${item.food?.name ?? item.name}`}
                  className="w-20 rounded-lg border border-line bg-card px-2 py-1.5 text-sm tabular-nums"
                  value={item.grams}
                  onChange={(e) => setGrams(index, Number(e.target.value))}
                />
                <span className="text-xs text-ink-secondary">g</span>

                {/* The same amount in units a kitchen uses. Tapping one sets the
                    weight, so the grams box and these never disagree. */}
                {units.map((unit) => (
                  <button
                    key={unit.label}
                    type="button"
                    onClick={() => setGrams(index, Math.round(unit.grams))}
                    className={`rounded-full border px-2.5 py-1 text-[11px] ${
                      Math.abs(item.grams - unit.grams) < 1
                        ? 'border-accent bg-accent-soft text-accent-deep'
                        : 'border-line text-ink-secondary'
                    }`}
                  >
                    {unit.label}
                  </button>
                ))}

                <span className="ml-auto text-sm tabular-nums">
                  {item.nutrition ? (
                    <>
                      <strong>{formatCalories(item.nutrition.calories)}</strong> cal
                      {item.range && item.range.low !== item.range.high && (
                        <span className="text-ink-muted">
                          {' '}
                          ({item.range.low}–{item.range.high})
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-muted">no data</span>
                  )}
                </span>

                <button
                  type="button"
                  aria-label={`Remove ${item.food?.name ?? item.name}`}
                  onClick={() => remove(index)}
                  className="rounded-lg px-2 py-1 text-xs font-medium text-ink-muted hover:text-over"
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {picking === 'new' ? (
        <div className="mt-2">
          <FoodPicker onPick={add} onCancel={() => setPicking(null)} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPicking('new')}
          className="mt-2 w-full rounded-xl border border-dashed border-line py-2.5 text-sm font-medium text-accent"
        >
          + Add something the photo missed
        </button>
      )}

      <div className="mt-3 rounded-xl bg-surface p-3 text-center">
        <p className="text-2xl font-semibold tabular-nums">
          {formatCalories(total.calories)} <span className="text-base font-normal">cal</span>
        </p>
        {anyEstimated && total.low !== total.high && (
          <p className="text-xs text-ink-muted tabular-nums">
            {total.low}–{total.high}
          </p>
        )}
        <p className="mt-1 text-xs text-ink-secondary tabular-nums">
          P {total.protein}g · C {total.carbs}g · F {total.fat}g
        </p>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1 rounded-xl bg-surface p-1 text-center text-xs font-semibold">
        {(['breakfast', 'lunch', 'dinner', 'snacks'] as Meal[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setChosenMeal(m)}
            className={`rounded-lg py-2 capitalize ${
              chosenMeal === m ? 'bg-accent text-white' : 'text-ink-secondary'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-ink-secondary">
        <input
          type="checkbox"
          checked={saveAs}
          onChange={(e) => setSaveAs(e.target.checked)}
          className="h-4 w-4 rounded border-line"
        />
        Save as a meal, to log again in one tap
      </label>

      <button
        type="button"
        disabled={loggable.length === 0 || saving}
        onClick={log}
        className="mt-3 w-full rounded-xl bg-accent py-3 font-semibold text-white disabled:opacity-40"
      >
        {saving
          ? 'Adding…'
          : `Add ${loggable.length} item${loggable.length === 1 ? '' : 's'} to ${chosenMeal}`}
      </button>
    </Sheet>
  );
}
