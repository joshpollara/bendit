// Estimating a meal from a photograph.
//
// The server does the work; this is the shape of what comes back and the one
// call that fetches it. There is no on-device fallback here, unlike the label
// path: reading printed digits is something the phone can do, but recognising
// a plate of food is not.

import type { Food } from '../types';
import { postToModel, resizeForModel, type VisionMeta } from './vision';

export type ItemConfidence = 'high' | 'medium' | 'low';

export type MealItem = {
  /** What the model called it — kept even when nothing matched. */
  name: string;
  /** The model's words, once the matched food has its own name on screen. */
  seenAs?: string;
  grams: number;
  confidence: ItemConfidence;
  food: {
    id: string;
    name: string;
    brand: string | null;
    source: string;
    kcal100: number | null;
    servingLabel: string;
    servingGrams: number | null;
    /** Household portions: "1 cup (158g)", "1 medium (118g)". */
    servings?: { label: string; grams: number }[];
  } | null;
  nutrition: { calories: number; protein: number | null; carbs: number | null; fat: number | null } | null;
  range: { low: number; high: number } | null;
  /** The portion's error band, as a fraction: 0.15 at best. */
  error: number | null;
  servings?: number;
};

export type MealEstimate = {
  items: MealItem[];
  total: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    low: number;
    high: number;
  };
  unmatched: number;
  meta: VisionMeta;
};

export async function estimateMealFromPhoto(photo: Blob): Promise<MealEstimate> {
  const estimate = await postToModel<MealEstimate>('/api/meals/estimate', {
    image: await resizeForModel(photo),
    mimeType: 'image/jpeg',
  });
  // Remember the model's own words before the matched food's name takes over on
  // screen, so a wrong match is visible as a wrong match.
  return { ...estimate, items: estimate.items.map((item) => ({ ...item, seenAs: item.name })) };
}

/**
 * Recomputes an item after its grams are changed by hand. Scaling the numbers
 * already returned avoids a round trip, and the arithmetic is the same one the
 * server did — per-100g times weight.
 */
export function rescaleItem(item: MealItem, grams: number): MealItem {
  if (!item.food || item.food.kcal100 == null || !(grams > 0)) return { ...item, grams };
  const factor = grams / 100;
  const scale = (per100: number | null | undefined, dp = 1) =>
    per100 == null ? null : Math.round(per100 * factor * 10 ** dp) / 10 ** dp;

  const calories = Math.round(item.food.kcal100 * factor);
  // A weight the user typed is a weight they know; the model's error band no
  // longer applies to it.
  const error = 0;
  return {
    ...item,
    grams,
    error,
    nutrition: {
      calories,
      protein: item.nutrition?.protein == null ? null : scale(perHundred(item, 'protein')),
      carbs: item.nutrition?.carbs == null ? null : scale(perHundred(item, 'carbs')),
      fat: item.nutrition?.fat == null ? null : scale(perHundred(item, 'fat')),
    },
    range: { low: calories, high: calories },
    servings: item.food.servingGrams ? grams / item.food.servingGrams : grams / 100,
  };
}

/**
 * Recomputes an item after its calorie figure is corrected by hand.
 *
 * A matched food has a known energy density, so a corrected calorie count is
 * really a corrected weight: it goes back through the same per-100g arithmetic,
 * and the grams box, the macros and the unit chips all stay in step with each
 * other. An item that matched nothing has no density to work from, so the
 * number typed is all there is — it becomes the item's calories directly, and
 * that is enough to log it.
 */
export function setCalories(item: MealItem, calories: number): MealItem {
  if (!(calories >= 0)) return item;
  const kcal100 = item.food?.kcal100 ?? null;
  if (kcal100 != null && kcal100 > 0) {
    return rescaleItem(item, Math.round(((calories * 100) / kcal100) * 10) / 10);
  }
  const rounded = Math.round(calories);
  return {
    ...item,
    error: 0,
    nutrition: { calories: rounded, protein: null, carbs: null, fat: null },
    range: { low: rounded, high: rounded },
  };
}

/**
 * A food chosen by hand becomes an item at the given weight. Its numbers come
 * from the same per-100g figures the server would have used, so a corrected
 * item is priced exactly like an estimated one — and carries no error band,
 * because nothing about it was guessed.
 */
export function itemFromFood(food: Food, grams: number, seenAs?: string): MealItem {
  const factor = grams / 100;
  const per100 = (value: number | null | undefined) => (value == null ? null : value);
  const scale = (value: number | null | undefined, dp = 1) =>
    value == null ? null : Math.round(value * factor * 10 ** dp) / 10 ** dp;

  // A food with no per-100g figures (an old custom entry) still has a serving,
  // which is enough to price it.
  const kcal100 =
    food.kcal100 ?? (food.servingGrams ? (food.caloriesPerServing * 100) / food.servingGrams : null);

  return {
    name: food.name,
    seenAs,
    grams,
    confidence: 'high',
    error: 0,
    food: {
      id: food.id,
      name: food.name,
      brand: food.brand ?? null,
      source: food.source,
      kcal100,
      servingLabel: food.servingLabel,
      servingGrams: food.servingGrams ?? null,
      servings: food.servingGrams
        ? [{ label: food.servingLabel, grams: food.servingGrams }]
        : [],
    },
    nutrition: {
      calories: Math.round((kcal100 ?? 0) * factor),
      protein: scale(per100(food.protein100)),
      carbs: scale(per100(food.carbs100)),
      fat: scale(per100(food.fat100)),
    },
    range: { low: Math.round((kcal100 ?? 0) * factor), high: Math.round((kcal100 ?? 0) * factor) },
    servings: food.servingGrams ? grams / food.servingGrams : grams / 100,
  };
}

/**
 * The household amounts to offer beside the grams box, as whole and half
 * portions of what the food is actually sold in. Capped at a handful: a row of
 * twenty chips is not a choice, it's a search.
 */
export function unitOptions(item: MealItem): { label: string; grams: number }[] {
  // Reference foods carry their portions in a table; the hand-curated ones just
  // have the one printed on the row ("1 cup (158g)"). Either is worth offering
  // — without the fallback the commonest matches got no units at all.
  const own =
    item.food?.servingGrams && item.food.servingLabel
      ? [{ label: item.food.servingLabel, grams: item.food.servingGrams }]
      : [];
  const servings = item.food?.servings?.length ? item.food.servings : own;
  const options: { label: string; grams: number }[] = [];

  for (const serving of servings) {
    if (!serving.grams || serving.grams <= 0) continue;
    // A "portion" that is just a weight — "100 g", "25.0g" — is what the grams
    // box already says, in the same units. Only named portions earn a chip.
    if (/^[\d.,]+\s*(g|ml|gram|grams)$/i.test(serving.label.trim())) continue;
    const noun = serving.label.replace(/\s*\([^)]*\)\s*$/, '').trim() || serving.label;
    options.push({ label: noun, grams: serving.grams });
    // Half of "1 cup" is "½ cup", not "½ 1 cup": the leading count is replaced,
    // not prefixed. Anything else ("2 biscuits") keeps its own wording.
    const half = /^1\s+(.+)$/.exec(noun);
    if (half && options.length < 3) {
      options.push({ label: `½ ${half[1]}`, grams: serving.grams / 2 });
    }
    if (options.length >= 4) break;
  }
  return options.slice(0, 4);
}

/** Recovers a per-100g figure from what the server sent for the original grams. */
function perHundred(item: MealItem, key: 'protein' | 'carbs' | 'fat'): number | null {
  const value = item.nutrition?.[key];
  if (value == null || !item.grams) return null;
  return (value * 100) / item.grams;
}

/** The meal's totals, recomputed after edits. */
export function totalsFor(items: MealItem[]): MealEstimate['total'] {
  const priced = items.filter((i) => i.nutrition);
  const add = (fn: (i: MealItem) => number | null | undefined) =>
    priced.reduce((sum, item) => sum + (fn(item) ?? 0), 0);
  return {
    calories: Math.round(add((i) => i.nutrition?.calories)),
    protein: Math.round(add((i) => i.nutrition?.protein) * 10) / 10,
    carbs: Math.round(add((i) => i.nutrition?.carbs) * 10) / 10,
    fat: Math.round(add((i) => i.nutrition?.fat) * 10) / 10,
    low: Math.round(add((i) => i.range?.low)),
    high: Math.round(add((i) => i.range?.high)),
  };
}
