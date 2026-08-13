// Turning a photographed plate into numbers.
//
// The model contributes two things: what the foods are, and roughly how much of
// each is there. Every calorie and gram of protein comes from the database, via
// the same name search the food picker uses. Nothing nutritional is taken from
// the model, and its schema has no field to put such a number in.
//
// The honest part is the uncertainty. Identifying food from a photograph is
// largely solved; judging how much is on the plate is not, and the published
// error for portion estimation from a single 2D image is roughly 15–25%. That
// is far larger than any error in the nutrition data, so it is what the numbers
// should be presented with. Each item carries a range, and the meal total carries
// the sum of them.
//
// Depth data would attack exactly this error — a LiDAR frame from a recent
// iPhone gives real volume rather than an inference from apparent size, and
// would slot in here as a per-item grams correction before lookup. Not built:
// it needs a native shell, and the browser has no access to the sensor.

import { nutritionForGrams } from './foodSchema.mjs';
import { matchFood } from './foodSearch.mjs';

/**
 * How wrong the portion could be, by how sure the model was. The middle band
 * is the published figure for eyeballing a portion from a photo; "low" widens
 * it because an uncertain identification usually means an uncertain size too.
 */
export const PORTION_ERROR = { high: 0.15, medium: 0.25, low: 0.4 };

const round = (value, dp = 0) => {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
};

/** A plate is one photograph: an overestimate of one portion tends to come with
 * an overestimate of the next, so the bands are added rather than combined in
 * quadrature. The wider, more honest reading. */
const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);

/**
 * Matches each named item to a food and computes its nutrition.
 * `db` is passed in so this stays testable against a small in-memory database.
 */
export function estimateMeal(db, items = []) {
  // The household portions a food is sold and eaten in — "1 cup (195g)",
  // "1 medium (118g)". Nobody corrects a portion in grams if they can correct
  // it in cups, so these travel with the estimate.
  const servingsFor = db.prepare(
    'SELECT label, grams FROM food_servings WHERE foodId = ? ORDER BY isDefault DESC, grams',
  );

  const estimated = items.map((item) => {
    const grams = Number(item?.grams);
    const name = String(item?.name ?? '').trim();
    const confidence = PORTION_ERROR[item?.confidence] ? item.confidence : 'medium';

    if (!name || !Number.isFinite(grams) || grams <= 0) return null;

    // Three ways of saying the same food, tried from the most specific: the
    // catalogue form the model was asked for, then what it would say out loud,
    // then the broader term it offered for a food it could only half place.
    // How a food is *said* and how it is *catalogued* are different strings,
    // and the database only answers to one of them.
    const food = [item?.query, name, item?.alternate]
      .map((term) => String(term ?? '').trim())
      .filter(Boolean)
      .reduce((found, term) => found ?? matchFood(db, term), null);
    if (!food) {
      // No confident match. Returned anyway: the person can search for it
      // themselves, and dropping it silently would understate the meal.
      return { name, grams: round(grams), confidence, food: null, nutrition: null, error: null };
    }

    const nutrition = nutritionForGrams(food, grams);
    const error = PORTION_ERROR[confidence];
    return {
      name,
      grams: round(grams),
      confidence,
      food: {
        id: food.id,
        name: food.name,
        brand: food.brand ?? null,
        source: food.source,
        kcal100: food.kcal100,
        servingLabel: food.servingLabel,
        servingGrams: food.servingGrams ?? null,
        servings: servingsFor.all(food.id),
      },
      // What the log stores: entries are counted in servings of a food, so the
      // estimated grams are expressed in those terms rather than in a second,
      // parallel unit that the rest of the app would have to learn.
      servings: round(food.servingGrams ? grams / food.servingGrams : grams / 100, 3),
      nutrition: {
        calories: round(nutrition.calories),
        protein: round(nutrition.protein, 1),
        carbs: round(nutrition.carbs, 1),
        fat: round(nutrition.fat, 1),
      },
      // What the calorie figure would be if the portion were as wrong as it
      // plausibly could be, in each direction.
      range: {
        low: round((nutrition.calories ?? 0) * (1 - error)),
        high: round((nutrition.calories ?? 0) * (1 + error)),
      },
      error,
    };
  });

  const found = estimated.filter((item) => item && item.nutrition);
  const total = {
    calories: round(sum(found.map((i) => i.nutrition.calories))),
    protein: round(sum(found.map((i) => i.nutrition.protein)), 1),
    carbs: round(sum(found.map((i) => i.nutrition.carbs)), 1),
    fat: round(sum(found.map((i) => i.nutrition.fat)), 1),
    low: round(sum(found.map((i) => i.range.low))),
    high: round(sum(found.map((i) => i.range.high))),
  };

  return {
    items: estimated.filter(Boolean),
    total,
    /** How many named foods the database couldn't confidently place. */
    unmatched: estimated.filter((item) => item && !item.food).length,
  };
}
