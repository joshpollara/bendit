import { useEffect, useState } from 'react';
import { api, type RecipeDraft, type RecipeIngredientInput } from '../lib/api';
import { formatCalories } from '../lib/units';
import { SparkleIcon } from './Icons';

// Checking a recipe before it becomes a food.
//
// The ingredients are the lines as written, editable as text — a recipe is text
// and correcting it should be typing, not a form per line. What each line
// resolved to is shown beside it: the food it matched, the weight, and whether
// that weight came from the food's own portion or from a standard measure.

const field = 'w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm';

export function recipeIngredientInputs(
  lines: string,
  initial: RecipeDraft['ingredients'],
): RecipeIngredientInput[] {
  const imported = new Map(initial.map((item) => [item.raw, item]));
  return lines
    .split('\n')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const original = imported.get(raw);
      return {
        raw,
        matchName: original?.name ?? null,
        foodId: original?.food?.id ?? original?.foodId ?? null,
      };
    });
}

export default function RecipeEditor({
  initial,
  recipeId,
  onSaved,
  onClose,
}: {
  initial: RecipeDraft;
  recipeId?: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name ?? '');
  const [servings, setServings] = useState(String(initial.servings ?? 4));
  const [lines, setLines] = useState(initial.ingredients.map((i) => i.raw).join('\n'));
  const [instructions, setInstructions] = useState(initial.instructions ?? '');
  const [notes, setNotes] = useState(initial.notes ?? '');
  const [priced, setPriced] = useState<RecipeDraft>(initial);
  const [pricing, setPricing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const makes = Number(servings) || 1;

  // Keep the model's lookup and the server's exact food match only while the
  // ingredient line itself is unchanged. This prevents the mount-time reprice
  // and save from throwing away the useful half of an AI import, without
  // applying a stale match after the user edits a line.
  const ingredientInputs = (): RecipeIngredientInput[] => {
    return recipeIngredientInputs(lines, initial.ingredients);
  };

  // Re-price as the lines are edited. It's a database lookup, not a model call,
  // so it can run on every pause without costing anything.
  useEffect(() => {
    const list = ingredientInputs();
    if (list.length === 0) return;
    const timer = setTimeout(async () => {
      setPricing(true);
      try {
        setPriced(await api.priceRecipe(list, makes));
      } finally {
        setPricing(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [lines, makes]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.saveRecipe(
        {
          name: name.trim(),
          servings: makes,
          servingsStated: initial.servingsStated ?? true,
          ingredients: ingredientInputs(),
          instructions: instructions.trim() || null,
          notes: notes.trim() || null,
          sourceType: initial.sourceType ?? 'manual',
          sourceUrl: initial.sourceUrl ?? null,
        },
        recipeId,
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setSaving(false);
    }
  }

  const per = priced.perServing;
  const declaredCalories = initial.sourceNutrition?.calories;
  const nutritionDisagrees =
    declaredCalories != null &&
    declaredCalories > 0 &&
    per.calories != null &&
    Math.abs(per.calories - declaredCalories) / declaredCalories > 0.3;
  const valid = name.trim() !== '' && lines.trim() !== '';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{recipeId ? 'Edit recipe' : 'New recipe'}</h1>
        <button type="button" onClick={onClose} className="text-sm font-medium text-accent">
          Cancel
        </button>
      </div>

      <input className={field} placeholder="Recipe name" value={name} onChange={(e) => setName(e.target.value)} />

      {initial.sourceType === 'url' && (
        <div className="flex items-start gap-2 rounded-xl bg-surface px-3 py-2.5 text-xs text-ink-secondary">
          <SparkleIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p>
            {initial.readBy === 'model' ? 'AI extracted this from the page.' : 'Imported from the recipe page.'}{' '}
            Check the details below before saving.
          </p>
        </div>
      )}

      {initial.sourceType === 'photo' && (
        <div
          className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs ${
            initial.sourceComplete === false
              ? 'bg-warn-soft text-warn-deep'
              : 'bg-surface text-ink-secondary'
          }`}
        >
          <SparkleIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div>
            <p>
              {initial.sourceComplete === false
                ? 'AI could only verify part of this recipe. Add anything missing before saving.'
                : 'AI extracted this from the photo. Check the details below before saving.'}
            </p>
            {initial.sourceComplete === false && (initial.sourceWarnings?.length ?? 0) > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {initial.sourceWarnings!.map((warning, index) => (
                  <li key={`${warning}:${index}`}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <label className="flex items-center gap-3 text-sm text-ink-secondary">
        Makes
        <input
          type="number"
          inputMode="numeric"
          min={1}
          className="w-20 rounded-xl border border-line bg-card px-3 py-2 text-sm tabular-nums"
          value={servings}
          onChange={(e) => setServings(e.target.value)}
        />
        servings
        {initial.servingsStated === false && (
          <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn-deep">
            estimated
          </span>
        )}
      </label>
      {initial.servingsStated === false && initial.servingsReasoning && (
        <p className="-mt-1 text-xs text-ink-muted">{initial.servingsReasoning}</p>
      )}

      <label className="flex flex-col gap-1 text-sm text-ink-secondary">
        Ingredients, one per line
        <textarea
          className={`${field} min-h-40 font-mono text-xs`}
          value={lines}
          onChange={(e) => setLines(e.target.value)}
          placeholder={'2 tbsp olive oil\n1 onion, finely chopped\n500 g beef mince'}
        />
      </label>

      <div className="rounded-2xl border border-line bg-card">
        <div className="flex items-baseline justify-between border-b border-line px-4 py-2.5">
          <span className="text-sm font-medium">What that comes to</span>
          {pricing && <span className="text-xs text-ink-muted">working it out…</span>}
        </div>
        <ul>
          {priced.ingredients.map((item, index) => (
            <li
              key={`${item.raw}:${index}`}
              className="flex items-center gap-3 border-b border-line px-4 py-2 text-xs last:border-b-0"
            >
              <span className="w-16 shrink-0 tabular-nums text-ink-secondary">
                {item.grams == null ? '—' : `${Math.round(item.grams)} g`}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {item.food?.name ?? item.raw}
                {item.weighedBy === 'generic' && (
                  <span className="ml-1.5 text-ink-muted">standard measure</span>
                )}
                {!item.food && item.reason === 'no amount given' && (
                  <span className="ml-1.5 text-ink-muted">amount not stated</span>
                )}
                {!item.food && item.reason !== 'no amount given' && (
                  <span className="ml-1.5 text-over">no match</span>
                )}
              </span>
              <span className="tabular-nums text-ink-secondary">
                {item.nutrition ? `${item.nutrition.calories} cal` : ''}
              </span>
            </li>
          ))}
        </ul>
        <div className="px-4 py-3 text-center">
          <p className="text-2xl font-semibold tabular-nums">
            {per.calories == null ? '—' : formatCalories(per.calories)}{' '}
            <span className="text-base font-normal">
              cal per serving{priced.complete === false ? ' (partial)' : ''}
            </span>
          </p>
          <p className="text-xs text-ink-secondary tabular-nums">
            {per.grams ? `${Math.round(per.grams)} g · ` : ''}
            P {per.protein ?? 0}g · C {per.carbs ?? 0}g · F {per.fat ?? 0}g
          </p>
          {priced.total.calories != null && (
            <p className="mt-1 text-xs text-ink-muted tabular-nums">
              whole recipe {formatCalories(priced.total.calories)} cal
            </p>
          )}
        </div>
      </div>

      {(priced.unmatched?.length ?? 0) + (priced.unweighable?.length ?? 0) > 0 && (
        <p className="rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn-deep">
          {(priced.unmatched?.length ?? 0) + (priced.unweighable?.length ?? 0) === 1
            ? 'One measured ingredient is unresolved, so the nutrition shown is partial.'
            : `${(priced.unmatched?.length ?? 0) + (priced.unweighable?.length ?? 0)} measured ingredients are unresolved, so the nutrition shown is partial.`}
        </p>
      )}

      {(priced.amountMissing?.length ?? 0) > 0 && (
        <p className="rounded-xl bg-surface px-3 py-2 text-xs text-ink-secondary">
          {priced.amountMissing!.length === 1
            ? 'One ingredient has no amount and is excluded from nutrition.'
            : `${priced.amountMissing!.length} ingredients have no amounts and are excluded from nutrition.`}
        </p>
      )}

      {nutritionDisagrees && (
        <p className="rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn-deep">
          This estimate differs substantially from the page’s stated {formatCalories(declaredCalories)} calories per serving. Review the food matches before saving.
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm text-ink-secondary">
        Method
        <textarea
          className={`${field} min-h-24`}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-ink-secondary">
        Notes
        <input className={field} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      {error && <p className="rounded-xl bg-over-soft px-3 py-2 text-sm text-over">{error}</p>}

      <button
        type="button"
        disabled={!valid || saving}
        onClick={() => void save()}
        className="rounded-xl bg-accent py-3 font-semibold text-white disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Save recipe'}
      </button>
    </div>
  );
}
