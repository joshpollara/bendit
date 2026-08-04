// A recipe into numbers.
//
// Each ingredient line is parsed, matched to a food, weighed, and priced from
// the database — the same route a photographed meal takes, for the same reason:
// a model can read a recipe far better than it can know what is in one.
//
// What comes out is a per-serving figure, which is the thing worth logging. A
// recipe makes four portions; you eat one.

import { nutritionForGrams } from './foodSchema.mjs';
import { matchCandidates } from './foodSearch.mjs';
import { parseIngredients } from './recipeParse.mjs';
import { SOURCES, weighIngredient } from './recipeMeasure.mjs';

const round = (value, dp = 0) => {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
};

/**
 * Resolves one written line: what food, how much of it, and what that comes to.
 * Everything it couldn't work out is said rather than guessed.
 */
export function resolveIngredient(db, parsed, { ownerId } = {}) {
  // A line with no amount — "salt and pepper to taste" — contributes nothing
  // whichever food it names, and matching one only invites a wrong answer:
  // "salt and pepper" found sweet red peppers, cooked.
  if (!(parsed.quantity > 0)) {
    return {
      ...parsed,
      grams: null,
      weighedBy: SOURCES.unknown,
      reason: 'no amount given',
      food: null,
      nutrition: null,
    };
  }

  const portionsFor = (id) => {
    const rows = db
      .prepare('SELECT label, grams FROM food_servings WHERE foodId = ? ORDER BY isDefault DESC')
      .all(id);
    return rows;
  };

  // The best match that can actually weigh this line. A recipe saying "1 large
  // onion" needs a food with a "1 large" portion; the highest-ranked row may
  // only know what 100 g of onion is, and then the line is lost for the sake of
  // a slightly better name match.
  const candidates = parsed.name ? matchCandidates(db, parsed.name, { ownerId }) : [];
  let food = null;
  let servings = [];
  let weight = { grams: null, source: SOURCES.unknown, reason: 'no matching food' };

  for (const candidate of candidates) {
    const portions = portionsFor(candidate.id);
    if (candidate.servingGrams > 0 && candidate.servingLabel) {
      portions.push({ label: candidate.servingLabel, grams: candidate.servingGrams });
    }
    const attempt = weighIngredient(parsed, portions);
    if (!food) {
      // Keep the best-ranked match even if nothing can be weighed, so the
      // screen can show what it thought the line was.
      food = candidate;
      servings = portions;
      weight = attempt;
    }
    if (attempt.grams != null) {
      food = candidate;
      servings = portions;
      weight = attempt;
      break;
    }
  }
  const nutrition = food && weight.grams != null ? nutritionForGrams(food, weight.grams) : null;

  return {
    ...parsed,
    grams: weight.grams,
    weighedBy: weight.source,
    reason: weight.reason ?? null,
    food: food
      ? {
          id: food.id,
          name: food.name,
          brand: food.brand ?? null,
          source: food.source,
          kcal100: food.kcal100,
        }
      : null,
    nutrition: nutrition
      ? {
          calories: round(nutrition.calories),
          protein: round(nutrition.protein, 1),
          carbs: round(nutrition.carbs, 1),
          fat: round(nutrition.fat, 1),
        }
      : null,
  };
}

/**
 * A whole recipe: its ingredients resolved, its totals, and what one serving
 * comes to.
 *
 * `servings` is how many portions it makes. Without it there is no per-serving
 * figure, which is the only figure anyone logs, so it defaults to one rather
 * than to nothing.
 */
export function buildRecipe(db, { ingredients, servings = 1, ownerId } = {}) {
  const lines = Array.isArray(ingredients) && typeof ingredients[0] === 'object'
    ? ingredients
    : parseIngredients(ingredients ?? []);

  const resolved = lines.map((line) => resolveIngredient(db, line, { ownerId }));
  const priced = resolved.filter((i) => i.nutrition);

  const sum = (fn) => priced.reduce((total, item) => total + (fn(item) ?? 0), 0);
  const makes = servings > 0 ? servings : 1;

  const total = {
    grams: round(sum((i) => i.grams), 1),
    calories: round(sum((i) => i.nutrition.calories)),
    protein: round(sum((i) => i.nutrition.protein), 1),
    carbs: round(sum((i) => i.nutrition.carbs), 1),
    fat: round(sum((i) => i.nutrition.fat), 1),
  };

  return {
    ingredients: resolved,
    servings: makes,
    total,
    perServing: {
      grams: round(total.grams / makes, 1),
      calories: round(total.calories / makes),
      protein: round(total.protein / makes, 1),
      carbs: round(total.carbs / makes, 1),
      fat: round(total.fat / makes, 1),
    },
    /** Lines contributing nothing, because the food or the amount is unknown. */
    unresolved: resolved.filter((i) => !i.nutrition).map((i) => i.raw),
    /** Lines weighed by a standard measure rather than the food's own. */
    approximate: resolved.filter((i) => i.weighedBy === SOURCES.generic).map((i) => i.raw),
  };
}

/**
 * The food a recipe produces: one serving of it, in the canonical shape the
 * rest of the app logs against.
 */
export function recipeFood(recipe, { id, name, ownerId = null }) {
  const per = recipe.perServing;
  const grams = per.grams > 0 ? per.grams : null;
  const scale = (value) => (value == null || !grams ? null : round((value * 100) / grams, 1));

  return {
    id,
    name,
    brand: null,
    barcode: null,
    servingLabel: grams ? `1 serving (${Math.round(grams)}g)` : '1 serving',
    servingGrams: grams,
    caloriesPerServing: per.calories ?? 0,
    protein: per.protein,
    carbs: per.carbs,
    fat: per.fat,
    source: 'custom',
    basis: 'g',
    // Per-100g follows from the serving's weight; without one, a gram-based
    // estimate of this food isn't possible and shouldn't be faked.
    kcal100: scale(per.calories),
    protein100: scale(per.protein),
    carbs100: scale(per.carbs),
    fat100: scale(per.fat),
    ownerId,
    servings: grams
      ? [
          { label: `1 serving (${Math.round(grams)}g)`, grams },
          { label: 'whole recipe', grams: recipe.total.grams },
        ]
      : [],
  };
}
