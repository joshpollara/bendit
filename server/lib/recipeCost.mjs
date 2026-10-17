// What a recipe costs a serving, at Picnic's prices.
//
// A recipe costs what it uses, not the packs it opens: 200 g from a 500 g
// pack is 40% of the pack's price. Each line is priced with the product the
// household picked for it — the same picks the plan and the recipe's shop
// sheet use — or Picnic's top match where nobody has picked. Lines that can't
// be priced (no product, or no way to tell how much of the pack) are left
// out, and how many were priced is kept with the figure — which isn't given
// at all when under half the lines could be priced.
//
// Working it out searches Picnic for unpicked lines, so it's kept for a week.

import { packGrams } from './picnicNutrition.mjs';
import { recipeShoppingList } from './mealPlan.mjs';
import { withProducts } from './picnicShopping.mjs';

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export function createRecipeCostTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS recipe_costs (
    recipeId TEXT PRIMARY KEY,
    perServing INTEGER,
    priced INTEGER NOT NULL,
    lines INTEGER NOT NULL,
    -- Lines priced with Picnic's top match rather than a household pick.
    guessed INTEGER NOT NULL,
    computedAt TEXT NOT NULL
  )`);
}

/** What one line uses of its product, in euro cents; null when that can't be told. */
export function lineCost(line, product) {
  if (product?.price == null) return null;
  const pack = packGrams(product.unitQuantity);
  if (line.grams && pack) return (product.price * line.grams) / pack;
  // Counted things against a pack of so many: 1 onion from "3 stuks".
  const counted = line.written?.length === 1 && /^\d+$/.test(line.written[0]) ? Number(line.written[0]) : null;
  const perPack = Number(String(product.unitQuantity ?? '').match(/(\d+)\s*stuks?\b/i)?.[1] ?? 0);
  if (!line.grams && counted && perPack) return (product.price * counted) / perPack;
  if (!line.grams && counted && /^1\s*stuks?$|^per stuk$/i.test(String(product.unitQuantity ?? '').trim())) {
    return product.price * counted;
  }
  return null;
}

/** The cost kept for a recipe, or null when there's none or it's old. */
export function cachedCost(db, recipeId, { now = Date.now() } = {}) {
  const row = db.prepare('SELECT * FROM recipe_costs WHERE recipeId = ?').get(recipeId);
  if (!row || now - Date.parse(row.computedAt) > KEEP_MS) return null;
  const updated = db.prepare('SELECT updatedAt FROM recipes WHERE id = ?').get(recipeId)?.updatedAt;
  // An edit since makes it stale.
  if (updated && Date.parse(updated) > Date.parse(row.computedAt)) return null;
  return { perServing: row.perServing, priced: row.priced, lines: row.lines, guessed: row.guessed };
}

/** Works out a recipe's cost a serving and keeps it. */
export async function costRecipe(db, recipeId, { suggest, now = Date.now() }) {
  const list = await withProducts(db, recipeShoppingList(db, recipeId), suggest);
  let total = 0;
  let priced = 0;
  let guessed = 0;
  for (const line of list.items) {
    const product = line.choice ?? line.suggestion;
    const cost = lineCost(line, product);
    if (cost == null) continue;
    total += cost;
    priced++;
    if (!line.choice) guessed++;
  }
  const servings = list.recipe.servings > 0 ? list.recipe.servings : 1;
  // Priced from a few lines of many, a figure would mislead more than help.
  const enough = priced >= Math.max(1, list.items.length / 2);
  const result = {
    perServing: enough ? Math.round(total / servings) : null,
    priced,
    lines: list.items.length,
    guessed,
  };
  db.prepare(
    `INSERT OR REPLACE INTO recipe_costs (recipeId, perServing, priced, lines, guessed, computedAt)
     VALUES (@recipeId, @perServing, @priced, @lines, @guessed, @computedAt)`,
  ).run({ recipeId, ...result, computedAt: new Date(now).toISOString() });
  return result;
}
