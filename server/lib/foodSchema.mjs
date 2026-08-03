// The single internal shape every source is normalized into, and the
// conversions between it and the per-serving form the app logs against.
//
// Two representations, one row:
//   • per-100g/ml — canonical, source of truth, what a photo's gram estimate
//     gets multiplied by.
//   • per-serving — the logging surface, derived from the above and a serving
//     weight. Kept because a person logs "a bar", not "43 grams".
//
// A record always carries `source` and `sourceId` so any number on screen can
// be traced back to the row it came from.

/** Nutrient fields carried per 100 g/ml. Sodium is milligrams; the rest grams. */
export const PER_100_FIELDS = [
  'kcal100',
  'protein100',
  'carbs100',
  'fat100',
  'fiber100',
  'sugar100',
  'satFat100',
  'sodiumMg100',
];

const round = (v, places = 2) => {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** kJ → kcal, for sources (and EU labels) that only publish energy in kJ. */
export const kjToKcal = (kj) => (kj == null ? null : kj / 4.184);

/**
 * Builds a canonical food record. Anything unknown stays null rather than
 * being defaulted to zero — "no data" and "contains none of it" are different
 * claims, and only one of them is safe to add up.
 */
export function makeFood({
  id,
  source,
  sourceId,
  name,
  brand = null,
  barcode = null,
  basis = 'g',
  per100 = {},
  servings = [],
}) {
  if (!id) throw new Error('food needs an id');
  if (!source) throw new Error('food needs a source');
  if (!name?.trim()) throw new Error('food needs a name');

  const record = {
    id,
    source,
    sourceId: sourceId == null ? null : String(sourceId),
    name: name.trim().replace(/\s+/g, ' '),
    brand: brand?.trim() || null,
    barcode: barcode ? String(barcode).trim() : null,
    basis: basis === 'ml' ? 'ml' : 'g',
    updatedAt: new Date().toISOString(),
  };
  for (const field of PER_100_FIELDS) record[field] = round(per100[field] ?? null);

  // The serving the app logs by default: the first given, else 100 of the base
  // unit, which is always a truthful fallback even if it's a clumsy portion.
  const usable = servings.filter((s) => s.grams > 0 && s.label);
  const primary = usable[0] ?? { label: `100 ${record.basis}`, grams: 100 };
  record.servingLabel = primary.label;
  record.servingGrams = round(primary.grams, 1);
  record.caloriesPerServing = round(scale(record.kcal100, primary.grams), 0) ?? 0;
  record.protein = round(scale(record.protein100, primary.grams), 1);
  record.carbs = round(scale(record.carbs100, primary.grams), 1);
  record.fat = round(scale(record.fat100, primary.grams), 1);
  record.servings = usable;
  return record;
}

/** A per-100 value at some number of grams. */
export function scale(per100, grams) {
  if (per100 == null || grams == null) return null;
  return (per100 * grams) / 100;
}

/**
 * Recovers per-100g values from a per-serving record — how existing rows and
 * hand-entered foods join the canonical schema. Without a serving weight there
 * is nothing to divide by, and inventing one would poison every later estimate.
 */
export function per100FromServing({ servingGrams, caloriesPerServing, protein, carbs, fat }) {
  if (!servingGrams || servingGrams <= 0) return null;
  const factor = 100 / servingGrams;
  return {
    kcal100: round(caloriesPerServing == null ? null : caloriesPerServing * factor),
    protein100: round(protein == null ? null : protein * factor),
    carbs100: round(carbs == null ? null : carbs * factor),
    fat100: round(fat == null ? null : fat * factor),
  };
}

/** Nutrition for an arbitrary portion — what the meal-photo path computes with. */
export function nutritionForGrams(food, grams) {
  return {
    grams,
    calories: Math.round(scale(food.kcal100, grams) ?? 0),
    protein: round(scale(food.protein100, grams), 1),
    carbs: round(scale(food.carbs100, grams), 1),
    fat: round(scale(food.fat100, grams), 1),
    /** False when the food has no per-100g data, so callers don't trust zeros. */
    known: food.kcal100 != null,
  };
}
