import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  applyMealQuestionChoice,
  appendMealFeedbackAction,
  itemFromFood,
  mealFeedbackFor,
  MAX_MEAL_FEEDBACK_ITEMS,
  positiveMealNumber,
  replaceItemFood,
  rescaleItem,
  setCalories,
  totalsFor,
  unitOptions,
  type MealEstimate,
  type MealFeedback,
  type MealFeedbackAction,
  type MealFeedbackIssue,
  type MealFeedbackOutcome,
  type MealFeedbackRating,
  type MealItem,
} from '../lib/mealPhoto';
import { formatCalories } from '../lib/units';
import type { Food, Meal } from '../types';
import { BarcodeIcon, CameraIcon, WarnIcon } from './Icons';
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
// The calorie figure is editable too. Often the food is right and only the
// number is wrong, and someone who knows the calories shouldn't have to work
// backwards to a weight that produces them. For a matched food that is exactly
// what happens behind the box — calories in, weight out, macros in step. For
// one that matched nothing, the typed figure is the whole entry, and it logs
// the way a quick add does.
//
// Everything the model produced can be overruled: the food it matched, the
// weight, the calories, whether the item belongs at all, and anything it
// missed entirely.

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

const FEEDBACK_RATINGS: { value: MealFeedbackRating; label: string }[] = [
  { value: 'close', label: 'Close' },
  { value: 'needed_edits', label: 'Needed edits' },
  { value: 'way_off', label: 'Way off' },
];

const FEEDBACK_ISSUES: { value: MealFeedbackIssue; label: string }[] = [
  { value: 'wrong_food', label: 'Wrong food' },
  { value: 'portion_off', label: 'Portion was off' },
  { value: 'food_missing', label: 'Food missing' },
  { value: 'extra_food', label: 'Extra food' },
  { value: 'sauce_preparation', label: 'Sauce / preparation' },
  { value: 'calories_macros', label: 'Calories / macros' },
];

function PositiveNumberInput({
  value,
  label,
  className,
  onCommit,
}: {
  value: number | null;
  label: string;
  className: string;
  onCommit: (value: number) => void;
}) {
  const displayed = value == null ? '' : String(value);
  const [draft, setDraft] = useState(displayed);

  useEffect(() => setDraft(displayed), [displayed]);

  const commit = () => {
    const next = positiveMealNumber(draft);
    if (next == null) {
      setDraft(displayed);
      return;
    }
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="number"
      inputMode="decimal"
      min="0.1"
      step="any"
      aria-label={label}
      className={className}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

export default function MealPhotoSheet({
  estimate,
  meal,
  onLog,
  onClose,
  onRetake,
  onScanBarcode,
  onFeedback,
}: {
  estimate: MealEstimate;
  meal: Meal;
  onLog: (items: MealItem[], meal: Meal) => Promise<void> | void;
  onClose: () => void;
  onRetake: () => void;
  onScanBarcode: () => void;
  onFeedback: (feedback: MealFeedback) => void;
}) {
  const [items, setItems] = useState<MealItem[]>(estimate.items);
  const [question, setQuestion] = useState(estimate.question ?? null);
  const [chosenMeal, setChosenMeal] = useState<Meal>(meal);
  const [picking, setPicking] = useState<number | 'new' | null>(null);
  const [saveAs, setSaveAs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rating, setRating] = useState<MealFeedbackRating | null>(null);
  const [issues, setIssues] = useState<MealFeedbackIssue[]>([]);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [actions, setActions] = useState<MealFeedbackAction[]>([]);

  const total = totalsFor(items);
  // An item with a calorie figure can be logged, whether that figure came from
  // a matched food or was typed in over the top of a name nothing matched.
  const loggable = items.filter(
    (item) => item.nutrition && (item.kind === 'adjustment' || item.grams > 0),
  );
  const anyEstimated = loggable.some((item) => (item.error ?? 0) > 0);
  const pathLabel =
    estimate.path?.selected === 'hybrid'
      ? 'Food records checked against a whole-meal estimate'
      : estimate.path?.selected === 'holistic'
        ? 'Whole-meal fallback'
        : 'Calculated from matched food records';

  const update = (index: number, next: MealItem) =>
    setItems((current) => current.map((item, i) => (i === index ? next : item)));

  const record = (action: MealFeedbackAction) =>
    setActions((current) => appendMealFeedbackAction(current, action));

  const setGrams = (index: number, grams: number) => {
    record({ type: 'item_amount_changed', itemId: items[index].id });
    update(index, rescaleItem(items[index], grams));
  };

  const setCals = (index: number, calories: number) => {
    record({ type: 'item_calories_changed', itemId: items[index].id });
    update(index, setCalories(items[index], calories));
  };

  /** Swapping the food keeps the weight: the plate didn't change, the name did. */
  const swap = (index: number, food: Food) => {
    record({ type: 'item_food_changed', itemId: items[index].id });
    update(index, replaceItemFood(items[index], food));
    setPicking(null);
  };

  const answerQuestion = (choiceId: string) => {
    if (!question) return;
    record({ type: 'question_answered', itemId: question.targetItemId, choiceId });
    setItems((current) => applyMealQuestionChoice(current, question, choiceId));
    setQuestion(null);
  };

  const add = (food: Food) => {
    if (items.length >= MAX_MEAL_FEEDBACK_ITEMS) return;
    // A food the photo missed starts at its own serving, which is the amount a
    // person is most likely to have had.
    const item = itemFromFood(food, food.servingGrams || 100);
    record({ type: 'item_added', itemId: item.id });
    setItems((current) => [...current, item]);
    setPicking(null);
  };

  const remove = (index: number) => {
    record({ type: 'item_removed', itemId: items[index].id });
    setItems((current) => current.filter((_, i) => i !== index));
  };

  const feedback = (outcome: MealFeedbackOutcome) =>
    mealFeedbackFor({ outcome, rating, issues, note, actions, meal: chosenMeal, items });

  const finish = (outcome: Exclude<MealFeedbackOutcome, 'logged'>, next: () => void) => {
    onFeedback(feedback(outcome));
    next();
  };

  const chooseRating = (next: MealFeedbackRating) => {
    const selected = rating === next ? null : next;
    setRating(selected);
    if (selected !== 'needed_edits' && selected !== 'way_off') {
      setIssues([]);
      setNote('');
      setShowNote(false);
    }
  };

  const toggleIssue = (issue: MealFeedbackIssue) =>
    setIssues((current) =>
      current.includes(issue) ? current.filter((candidate) => candidate !== issue) : [...current, issue],
    );

  async function log() {
    setSaving(true);
    try {
      if (saveAs) await saveTemplate();
      await onLog(loggable, chosenMeal);
      onFeedback(feedback('logged'));
    } finally {
      setSaving(false);
    }
  }

  /** Repeat meals are most of most diets; a saved meal re-logs in one tap. */
  async function saveTemplate() {
    const name = window.prompt(
      'Save this meal as:',
      loggable.map((i) => i.food?.name ?? i.name).join(', ').slice(0, 40),
    );
    if (!name?.trim()) return;
    await api.createMealTemplate(
      name.trim(),
      loggable.map((item) => ({
        foodId: item.food?.id ?? null,
        // An item with no food behind it keeps its name, or it re-logs as a
        // nameless number.
        label: item.food ? undefined : item.name,
        servings: item.servings ?? item.grams / 100,
        caloriesCached: Math.round(item.nutrition?.calories ?? 0),
      })),
    );
  }

  return (
    <Sheet onClose={() => finish('dismissed', onClose)}>
      <h2 className="text-lg font-semibold">What&apos;s on the plate</h2>
      <p className="mt-1 text-xs text-ink-muted">
        {items.length > 0
          ? 'Check the weights before adding them.'
          : 'Nothing was recognised. Add what you ate.'}
      </p>

      {estimate.status === 'retake' && (
        <div className="mt-3 border-y border-over/20 bg-over-soft px-1 py-3 text-over" role="alert">
          <div className="flex items-start gap-2">
            <WarnIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1 text-sm">
              {estimate.captureQuality?.retakeReason ??
                'The meal is not clear enough for a reliable portion estimate.'}
            </p>
            <button
              type="button"
              onClick={() => finish('retake', onRetake)}
              className="flex shrink-0 items-center gap-1 text-xs font-semibold"
            >
              <CameraIcon className="h-4 w-4" />
              Retake
            </button>
          </div>
        </div>
      )}

      {estimate.mealType === 'packaged' && (
        <div className="mt-3 flex items-center justify-between gap-3 border-y border-line py-3">
          <p className="text-sm text-ink-secondary">Use the package barcode for exact label values.</p>
          <button
            type="button"
            onClick={() => finish('barcode', onScanBarcode)}
            className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-accent"
          >
            <BarcodeIcon className="h-4 w-4" />
            Scan
          </button>
        </div>
      )}

      {question && (
        <section className="mt-3 border-y border-line py-3" aria-labelledby="meal-question">
          <p id="meal-question" className="text-sm font-medium">
            {question.question}
          </p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {question.choices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                onClick={() => answerQuestion(choice.id)}
                className="min-h-10 rounded-lg border border-line px-2 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent hover:text-accent"
              >
                {choice.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <ul className="mt-3 flex flex-col gap-2">
        {items.map((item, index) => {
          const units = unitOptions(item);
          return (
            <li key={item.id} className="rounded-xl border border-line p-3">
              <div className="flex items-start gap-2">
                {item.kind === 'adjustment' ? (
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <p className="truncate text-xs text-ink-muted">
                      Difference detected by the whole-meal estimate
                    </p>
                  </div>
                ) : (
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
                        `“${item.name}” isn't in the database — pick a food, or type the calories`
                      )}
                    </p>
                  </button>
                )}
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

              {item.kind !== 'adjustment' && picking === index && (
                <div className="mt-2">
                  <FoodPicker
                    initialQuery={item.name}
                    onPick={(food) => swap(index, food)}
                    onCancel={() => setPicking(null)}
                  />
                </div>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {item.kind !== 'adjustment' && (
                  <>
                    <PositiveNumberInput
                      label={`Grams of ${item.food?.name ?? item.name}`}
                      className="w-20 rounded-lg border border-line bg-card px-2 py-1.5 text-sm tabular-nums"
                      value={item.grams}
                      onCommit={(grams) => setGrams(index, grams)}
                    />
                    <span className="text-xs text-ink-secondary">g</span>
                  </>
                )}

                {/* The same amount in units a kitchen uses. Tapping one sets the
                    weight, so the grams box and these never disagree. */}
                {item.kind !== 'adjustment' &&
                  units.map((unit) => (
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

                {/* Editable, because the food is often right when the number
                    isn't. For a matched food this sets the weight; for an
                    unmatched one it is the entry. */}
                <span className="ml-auto flex items-center gap-1.5 text-sm tabular-nums">
                  <PositiveNumberInput
                    label={`Calories of ${item.food?.name ?? item.name}`}
                    className="w-20 rounded-lg border border-line bg-card px-2 py-1.5 text-right text-sm font-semibold tabular-nums"
                    value={item.nutrition ? Math.round(item.nutrition.calories) : null}
                    onCommit={(calories) => setCals(index, calories)}
                  />
                  <span className="text-xs text-ink-secondary">cal</span>
                  {item.range && item.range.low !== item.range.high && (
                    <span className="text-[11px] text-ink-muted">
                      {item.range.low}–{item.range.high}
                    </span>
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
          disabled={items.length >= MAX_MEAL_FEEDBACK_ITEMS}
          onClick={() => setPicking('new')}
          className="mt-2 w-full rounded-xl border border-dashed border-line py-2.5 text-sm font-medium text-accent disabled:text-ink-muted"
        >
          {items.length >= MAX_MEAL_FEEDBACK_ITEMS
            ? '20 item limit reached'
            : items.length > 0
              ? '+ Add something the photo missed'
              : '+ Add a food'}
        </button>
      )}

      <div className="mt-3 rounded-xl bg-surface p-3 text-center">
        <p className="text-2xl font-semibold tabular-nums">
          {formatCalories(total.calories)} <span className="text-base font-normal">cal</span>
        </p>
        {anyEstimated && total.low !== total.high && (
          <p className="text-xs text-ink-muted tabular-nums">
            Estimated range {total.low}–{total.high}
          </p>
        )}
        <p className="mt-1 text-xs text-ink-secondary tabular-nums">
          P {total.protein}g · C {total.carbs}g · F {total.fat}g
        </p>
        {estimate.path && <p className="mt-1 text-[11px] text-ink-muted">{pathLabel}</p>}
      </div>

      {(estimate.uncertaintyReasons?.length ?? 0) > 0 && (
        <div className="mt-3 border-y border-line py-2.5">
          {estimate.uncertaintyReasons!.slice(0, 3).map((reason) => (
            <p key={reason} className="flex gap-2 py-0.5 text-xs text-ink-muted">
              <span aria-hidden="true">•</span>
              <span>{reason}</span>
            </p>
          ))}
        </div>
      )}

      <section className="mt-3 border-y border-line py-3" aria-labelledby="meal-feedback-question">
        <p id="meal-feedback-question" className="text-sm font-medium">
          How close was the first estimate?
        </p>
        <div
          className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-surface p-1"
          role="group"
          aria-labelledby="meal-feedback-question"
        >
          {FEEDBACK_RATINGS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={rating === option.value}
              onClick={() => chooseRating(option.value)}
              className={`min-h-10 rounded-md px-1 text-xs font-medium ${
                rating === option.value
                  ? 'bg-card text-accent-deep shadow-sm ring-1 ring-line'
                  : 'text-ink-secondary hover:text-ink'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {(rating === 'needed_edits' || rating === 'way_off') && (
          <div className="mt-3">
            <p className="text-xs text-ink-muted">What needed work? Optional.</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {FEEDBACK_ISSUES.map((issue) => (
                <label
                  key={issue.value}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                    issues.includes(issue.value)
                      ? 'border-accent bg-accent-soft text-accent-deep'
                      : 'border-line text-ink-secondary hover:border-accent'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={issues.includes(issue.value)}
                    onChange={() => toggleIssue(issue.value)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  {issue.label}
                </label>
              ))}
            </div>

            {showNote ? (
              <label className="mt-3 block text-xs text-ink-secondary">
                Anything else? <span className="text-ink-muted">Optional</span>
                <textarea
                  value={note}
                  maxLength={300}
                  rows={2}
                  onChange={(event) => setNote(event.target.value)}
                  className="mt-1.5 block w-full resize-none rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
                />
              </label>
            ) : (
              <button
                type="button"
                onClick={() => setShowNote(true)}
                className="mt-2 text-xs font-medium text-accent"
              >
                Add a note
              </button>
            )}
          </div>
        )}
      </section>

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
