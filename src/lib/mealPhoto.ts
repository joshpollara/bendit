// Estimating a meal from a photograph.
//
// The server does the work; this is the shape of what comes back and the one
// call that fetches it. There is no on-device fallback here, unlike the label
// path: reading printed digits is something the phone can do, but recognising
// a plate of food is not.

import { postToModel, resizeForModel, type VisionMeta } from './vision';

export type ItemConfidence = 'high' | 'medium' | 'low';

export type MealItem = {
  /** What the model called it — kept even when nothing matched. */
  name: string;
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

export const estimateMealFromPhoto = async (photo: Blob): Promise<MealEstimate> =>
  postToModel<MealEstimate>('/api/meals/estimate', {
    image: await resizeForModel(photo),
    mimeType: 'image/jpeg',
  });

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
