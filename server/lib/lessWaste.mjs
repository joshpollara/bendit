// Buying for the plan with less left over.
//
// For each line on the week's list that's bought by weight: how much of the
// packs will be left after the planned meals, whether another pack size of the
// same food would leave less, and which of the household's other recipes
// would use up what's left.

import { packGrams } from './picnicNutrition.mjs';
import { packsFor } from './picnicShopping.mjs';
import { gramsOf, keyFor } from './mealPlan.mjs';
import { sharedWords } from './picnicSwaps.mjs';

/** Less than this is a scraping, not a leftover. */
const MIN_LEFT_GRAMS = 20;
const MIN_LEFT_SHARE = 0.15;

const round = (n) => Math.round(n);

/**
 * What each pack-bought line leaves over: lines not ticked off, whose amount
 * is a weight and whose product says its pack size.
 */
export function leftovers(items) {
  const out = [];
  for (const item of items) {
    const product = item.choice ?? item.suggestion;
    const pack = packGrams(product?.unitQuantity);
    if (item.checked || !item.grams || !pack) continue;
    const packs = item.packs ?? packsFor(item, product);
    const bought = packs * pack;
    const left = bought - item.grams;
    if (left < MIN_LEFT_GRAMS || left < bought * MIN_LEFT_SHARE) continue;
    out.push({
      key: item.key,
      name: item.name,
      needed: round(item.grams),
      bought: round(bought),
      left: round(left),
      product,
      packs,
    });
  }
  return out.sort((a, b) => b.left - a.left);
}

/**
 * The pack size that leaves least, among the same food in other sizes, when it
 * leaves clearly less than now (at least 30 g and a quarter less) and doesn't
 * cost more than the food it saves from waste: four tins of 125 g at triple
 * the price aren't worth it to save half a tin of beans. Equal leftovers go to
 * the cheaper.
 */
export function bestPack(line, candidates) {
  const currentPack = packGrams(line.product.unitQuantity);
  const pricePerGram =
    line.product.price != null && currentPack ? line.product.price / (line.packs * currentPack) : null;
  const currentCost = line.product.price != null ? line.packs * line.product.price : null;
  let best = null;
  for (const candidate of candidates) {
    const pack = packGrams(candidate.unitQuantity);
    if (!pack || candidate.productId === line.product.productId) continue;
    const packs = packsFor({ grams: line.needed }, candidate);
    // A pack may come up a little short; that's nothing left over, not less than nothing.
    const left = Math.max(0, round(packs * pack - line.needed));
    if (line.left - left < Math.max(30, line.left / 4)) continue;
    const cost = candidate.price != null ? packs * candidate.price : null;
    if (cost != null && currentCost != null && pricePerGram != null) {
      if (cost - currentCost > (line.left - left) * pricePerGram) continue;
    }
    const rank = cost ?? Infinity;
    if (!best || left < best.left || (left === best.left && rank < best.rank)) {
      best = { product: candidate, packs, left, rank };
    }
  }
  if (!best) return null;
  const { rank, ...better } = best;
  return better;
}

/**
 * The household's recipes that use an ingredient, with the servings that would
 * use up a leftover of it: the closest fit first, and only where that uses at
 * least half of it without needing much more. Recipes already planned this
 * week are left out.
 */
export function useItUp(db, leftover, { planned = new Set(), limit = 3 } = {}) {
  const rows = db
    .prepare(
      `SELECT r.id, r.name, r.servings, i.foodId, i.name AS ingredient, i.raw, i.quantity, i.unit, i.grams
       FROM recipe_ingredients i JOIN recipes r ON r.id = i.recipeId
       WHERE r.servings > 0 AND r.foodId IS NOT NULL`,
    )
    .all();
  const perServing = new Map();
  for (const row of rows) {
    if (planned.has(row.id) || keyFor(row.foodId, row.ingredient ?? row.raw) !== leftover.key) continue;
    const grams = gramsOf(row);
    if (!grams) continue;
    const entry = perServing.get(row.id) ?? { recipeId: row.id, name: row.name, grams: 0 };
    entry.grams += grams / row.servings;
    perServing.set(row.id, entry);
  }
  return (
    [...perServing.values()]
      .map(({ grams, ...recipe }) => {
        const servings = Math.min(8, Math.max(1, Math.round(leftover.left / grams)));
        return { ...recipe, servings, needs: servings * grams };
      })
      // Using at least half, without needing much more than there is.
      .filter((r) => r.needs >= leftover.left / 2 && r.needs <= leftover.left * 1.25)
      .map(({ needs, ...recipe }) => ({ ...recipe, uses: round(Math.min(needs, leftover.left)) }))
      .sort((a, b) => b.uses - a.uses || a.servings - b.servings || a.name.localeCompare(b.name))
      .slice(0, limit)
  );
}

/**
 * The whole report for a list with Picnic products on it. `similar(product)`
 * gives the same food in other sizes, as far as Picnic knows; `search(term)`
 * adds what a search for the line finds.
 */
export async function lessWaste(db, list, { similar, search, planned }) {
  const lines = leftovers(list.items);
  const out = [];
  for (const line of lines) {
    const own = await similar(line.product).catch(() => ({ brand: null, products: [] }));
    const found = await search(line.name).catch(() => []);
    const original = { name: line.product.name, brand: own.brand };
    const candidates = [...own.products, ...found].filter((c) => sharedWords(original, c) > 0);
    out.push({ ...line, better: bestPack(line, candidates), recipes: useItUp(db, line, { planned }) });
  }
  return out;
}
