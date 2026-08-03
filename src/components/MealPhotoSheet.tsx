import { useState } from 'react';
import {
  rescaleItem,
  totalsFor,
  type MealEstimate,
  type MealItem,
} from '../lib/mealPhoto';
import { formatCalories } from '../lib/units';
import type { Meal } from '../types';
import Sheet from './Sheet';

// What a photographed plate turned into, before any of it is logged.
//
// The screen is built around one fact: identifying the food is the easy part
// and judging how much of it there is, is not. So the weight is the control —
// large, editable, first — and the calorie figure is shown with the range that
// weight implies. Typing a weight collapses the range to a single number,
// because a weight someone knows is not a guess any more.

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
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [chosenMeal, setChosenMeal] = useState<Meal>(meal);
  const [saving, setSaving] = useState(false);

  const kept = items.filter((_, index) => !dropped.has(index));
  const total = totalsFor(kept);
  const loggable = kept.filter((item) => item.food && item.nutrition);
  const stillEstimated = loggable.some((item) => (item.error ?? 0) > 0);

  const setGrams = (index: number, grams: number) =>
    setItems((current) =>
      current.map((item, i) => (i === index ? rescaleItem(item, grams) : item)),
    );

  const toggle = (index: number) =>
    setDropped((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  async function log() {
    setSaving(true);
    try {
      await onLog(loggable, chosenMeal);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet onClose={onClose}>
      <h2 className="text-lg font-semibold">What&apos;s on the plate</h2>
      <p className="mt-1 text-xs text-ink-muted">
        The foods come from your photo; the calories come from the food database. Weights are
        estimated from a flat picture, so correct any that look wrong.
      </p>

      <ul className="mt-3 flex flex-col gap-2">
        {items.map((item, index) => {
          const isDropped = dropped.has(index);
          return (
            <li
              key={`${item.name}:${index}`}
              className={`rounded-xl border border-line p-3 ${isDropped ? 'opacity-40' : ''}`}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.food?.name ?? item.name}</p>
                  <p className="truncate text-xs text-ink-muted">
                    {item.food ? (
                      <>
                        {item.food.brand ? `${item.food.brand} · ` : ''}
                        seen as “{item.name}”
                      </>
                    ) : (
                      'Not in the food database — add it by hand'
                    )}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    CONFIDENCE_STYLE[item.confidence] ?? ''
                  }`}
                >
                  {CONFIDENCE_LABEL[item.confidence] ?? item.confidence}
                </span>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
                  <input
                    type="number"
                    inputMode="numeric"
                    aria-label={`Grams of ${item.food?.name ?? item.name}`}
                    className="w-20 rounded-lg border border-line bg-card px-2 py-1.5 text-sm tabular-nums"
                    value={item.grams}
                    onChange={(e) => setGrams(index, Number(e.target.value))}
                  />
                  g
                </label>

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
                  onClick={() => toggle(index)}
                  className="rounded-lg px-2 py-1 text-xs font-medium text-accent"
                >
                  {isDropped ? 'Keep' : 'Remove'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 rounded-xl bg-surface p-3 text-center">
        <p className="text-2xl font-semibold tabular-nums">
          {formatCalories(total.calories)} <span className="text-base font-normal">cal</span>
        </p>
        {stillEstimated && total.low !== total.high && (
          <p className="text-xs text-ink-muted">
            somewhere between {total.low} and {total.high}, depending on the portions
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
