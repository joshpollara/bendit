// The shopping list, bought from Picnic.
//
// Each line on the list is matched to a Picnic product. Picnic's search takes
// the list's own words — "ground beef" finds rundergehakt — so the top result
// is offered as a suggestion, but it is only a suggestion: "kidney beans" puts
// white beans first. A product someone picks is remembered for that line, for
// the whole household, so the next week's list already knows.
//
// How many to buy comes from the weight the plan needs and the pack size, where
// both are known; otherwise one.

import { packGrams } from './picnicNutrition.mjs';

export function createPicnicShoppingTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS picnic_choices (
    itemKey TEXT PRIMARY KEY,
    productId TEXT NOT NULL, name TEXT NOT NULL, imageId TEXT, unitQuantity TEXT,
    price INTEGER, chosenBy TEXT NOT NULL, chosenAt TEXT NOT NULL
  )`);
}

/** A product in the shape the list carries, from a search result. */
export const productFrom = (unit) => ({
  productId: unit.id,
  name: unit.name,
  imageId: unit.image_id ?? null,
  unitQuantity: unit.unit_quantity ?? null,
  price: unit.display_price ?? null,
});

/** How many packs cover what the plan needs: by weight where both are known, else one. */
export function packsFor(item, product) {
  const pack = packGrams(product?.unitQuantity);
  if (item.grams && pack) return Math.max(1, Math.ceil(item.grams / pack - 0.05));
  // A count of whole things, like "3" onions, against a pack of "3 stuks".
  const counted = item.written?.length === 1 && /^\d+$/.test(item.written[0]) ? Number(item.written[0]) : null;
  const perPack = Number(String(product?.unitQuantity ?? '').match(/(\d+)\s*stuks?\b/i)?.[1] ?? 1);
  if (!item.grams && counted) return Math.max(1, Math.ceil(counted / perPack));
  return 1;
}

export function setChoice(db, itemKey, product, { userId }) {
  db.prepare(
    `INSERT OR REPLACE INTO picnic_choices
       (itemKey, productId, name, imageId, unitQuantity, price, chosenBy, chosenAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    itemKey,
    product.productId,
    product.name,
    product.imageId,
    product.unitQuantity,
    product.price,
    userId,
    new Date().toISOString(),
  );
}

export function clearChoice(db, itemKey) {
  db.prepare('DELETE FROM picnic_choices WHERE itemKey = ?').run(itemKey);
}

/**
 * Searching Picnic for every line on every load would be a dozen requests each
 * time the list opens. Results for a term are kept for an hour.
 */
export function createSuggester(search, { ttlMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async function suggest(term) {
    const key = term.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.product;
    const results = await search(term);
    const product = results?.[0] ? productFrom(results[0]) : null;
    cache.set(key, { at: now(), product });
    return product;
  };
}

/** Runs `fn` over `items` with at most `limit` in flight: Picnic is one account, not a CDN. */
export async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The shopping list with a Picnic product on each line: the household's
 * choice where one was made, a suggestion otherwise. Ticked lines — already in
 * the cupboard — get no suggestion, since they won't be bought.
 */
export async function withProducts(db, list, suggest) {
  const choices = new Map(
    db.prepare('SELECT * FROM picnic_choices').all().map((row) => [row.itemKey, row]),
  );
  const items = await mapLimited(list.items, 4, async (item) => {
    const chosen = choices.get(item.key);
    const choice = chosen
      ? {
          productId: chosen.productId,
          name: chosen.name,
          imageId: chosen.imageId,
          unitQuantity: chosen.unitQuantity,
          price: chosen.price,
        }
      : null;
    const suggestion = choice || item.checked ? null : await suggest(item.name).catch(() => null);
    const product = choice ?? suggestion;
    return { ...item, choice, suggestion, packs: product ? packsFor(item, product) : null };
  });
  return { ...list, items };
}

/**
 * What adding the list to the cart would add: one entry per product, for the
 * lines that aren't ticked off and have a product someone chose. Suggestions
 * are not bought unseen — Picnic's top result for "cumin" was grated
 * mozzarella. Two lines that landed on the same product are added together.
 */
export function cartAdditions(items) {
  const byProduct = new Map();
  for (const item of items) {
    const product = item.choice;
    if (item.checked || !product) continue;
    const current = byProduct.get(product.productId) ?? { productId: product.productId, quantity: 0 };
    current.quantity += item.packs ?? 1;
    byProduct.set(product.productId, current);
  }
  return [...byProduct.values()];
}
