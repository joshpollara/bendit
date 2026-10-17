// Picnic's deals, and spending less on an order.
//
// A product's deal is on Picnic's search results page, in the tile for that
// product: its label ("2 voor €5", "25% korting", "nu €1.89"), its price, and
// the price before when it's a reduction. The product details page has a
// "promotion" too, but it's the first one anywhere on the page — usually some
// other product's, further down — so it isn't used.
//
// The search page is one request and lists the products themselves as well,
// so searching a product's name gives its price and its deal together.

import { packGrams } from './picnicNutrition.mjs';
import { sharedWords } from './picnicSwaps.mjs';
import { mapLimited } from './picnicShopping.mjs';

const CACHE_MS = 60 * 60 * 1000;
const GRADES = 'ABCDE';

/** Every object in a page under some key, wherever it is. */
function collect(node, visit, context = null) {
  if (!node || typeof node !== 'object') return;
  const tile = typeof node.id === 'string' && /^selling-unit-(s\d+)-tile/.exec(node.id);
  const here = tile ? tile[1] : context;
  visit(node, here);
  for (const value of Array.isArray(node) ? node : Object.values(node)) collect(value, visit, here);
}

/** Picnic's word for why a product can't be delivered, if it can't. */
function unavailableText(unit) {
  const d = (unit.decorators ?? []).find((x) => x?.type === 'UNAVAILABLE');
  if (!d) return null;
  return d.explanation?.short_explanation || d.reason || 'Not available';
}

/** The products on a search page, and each one's deal where it has one. */
export function readSearchPage(page) {
  const products = new Map();
  const deals = new Map();
  collect(page, (node, tile) => {
    const unit = node.sellingUnit;
    if (unit && typeof unit === 'object' && /^s\d+$/.test(unit.id ?? '') && !products.has(unit.id)) {
      products.set(unit.id, {
        productId: unit.id,
        name: unit.name,
        imageId: unit.image_id ?? null,
        unitQuantity: unit.unit_quantity ?? null,
        price: unit.display_price ?? null,
        unavailable: unavailableText(unit),
      });
    }
    if (tile && typeof node.promotion_label === 'string' && !deals.has(tile)) {
      deals.set(tile, {
        label: node.promotion_label,
        price: node.price ?? null,
        was: node.show_strikethrough_price ? (node.strikethrough_price ?? null) : null,
      });
    }
  });
  return { products: [...products.values()], deals };
}

/**
 * What a deal means for the price of several: how many it takes, and what
 * that many cost together. A reduction ("25% korting", "nu €1.89") is
 * already in the tile's price; a multi-buy is worked out from the regular one.
 */
export function dealTerms(label, price) {
  const text = String(label ?? '').toLowerCase();
  const multi = /^(\d+)\s*voor\s*€\s*(\d+(?:[.,]\d+)?)/.exec(text);
  if (multi) return { count: Number(multi[1]), total: Math.round(Number(multi[2].replace(',', '.')) * 100) };
  if (/^1\s*\+\s*1\s*gratis/.test(text)) return { count: 2, total: price };
  if (/^2\s*\+\s*1\s*gratis/.test(text)) return { count: 3, total: 2 * price };
  if (/^2e\s*halve\s*prijs/.test(text)) return { count: 2, total: Math.round(1.5 * price) };
  const second = /^2e\s*=?\s*(\d+)%\s*korting/.exec(text);
  if (second) return { count: 2, total: Math.round(price * (2 - Number(second[1]) / 100)) };
  return { count: 1, total: price };
}

/** What `quantity` of a product costs, with its deal. */
export function costOf(quantity, price, deal) {
  if (price == null) return null;
  const terms = deal ? dealTerms(deal.label, deal.price ?? price) : { count: 1, total: price };
  if (terms.count <= 1) return quantity * (deal?.price ?? price);
  return Math.floor(quantity / terms.count) * terms.total + (quantity % terms.count) * price;
}

/** What `quantity` would cost without any deal. */
const regularCost = (quantity, price, deal) => quantity * (deal?.was ?? price);

/**
 * `similarOf(product)` and `grade(product)` come from the Nutri-Score checker,
 * which keeps them for a month: a product's brand and Picnic's similar
 * products, and its grade, so a cheaper swap is never a less healthy one.
 */
export function createDealFinder(picnic, { now = () => Date.now(), grade = null, similarOf = async () => null } = {}) {
  const cache = new Map();

  /** A search page, read and kept for an hour. */
  async function lookup(term) {
    const key = term.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.read;
    const read = readSearchPage(await picnic.searchPage(term));
    cache.set(key, { at: now(), read });
    return read;
  }

  /** A product's current price and deal, from a search for its name. */
  async function priceOf({ productId, name }) {
    const { products, deals } = await lookup(name).catch(() => ({ products: [], deals: new Map() }));
    const found = products.find((p) => p.productId === productId);
    return { ...(found ?? { productId, name, price: null }), deal: deals.get(productId) ?? null };
  }

  /**
   * The same food in other brands and sizes: Picnic's own "similar products"
   * for it, which stay within its kind (fresh asparagus, not jarred), and
   * among those, ones whose names share what the food is.
   */
  async function alternatives(item) {
    const similar = (await similarOf(item).catch(() => null))?.products ?? [];
    return similar.filter((p) => p.productId !== item.productId && sharedWords(item, p, { strict: false }) > 0);
  }

  /**
   * Cheaper ways to buy about the same amount of the same food: at least 30
   * cents and a tenth less, within a quarter of the weight, and never a worse
   * Nutri-Score where both are known.
   */
  async function cheaperFor(item, current) {
    const pack = packGrams(current.unitQuantity ?? item.unitQuantity);
    const cost = costOf(item.quantity, current.price, current.deal);
    if (!pack || cost == null) return [];
    const weight = item.quantity * pack;
    const options = [];
    for (const alt of await alternatives(item)) {
      const altPack = packGrams(alt.unitQuantity);
      if (!altPack || alt.price == null) continue;
      const quantity = Math.max(1, Math.round(weight / altPack));
      if (Math.abs(quantity * altPack - weight) > weight / 4) continue;
      const altCost = costOf(quantity, alt.price, alt.deal);
      const saves = cost - altCost;
      if (saves < Math.max(30, cost / 10)) continue;
      options.push({ ...alt, quantity, cost: altCost, saves });
    }
    options.sort((a, b) => b.saves - a.saves);
    const kept = [];
    for (const option of options) {
      if (kept.length === 2) break;
      if (grade) {
        const [mine, theirs] = await Promise.all([grade(item), grade(option)]);
        if (mine && theirs && GRADES.indexOf(theirs) > GRADES.indexOf(mine)) continue;
      }
      kept.push(option);
    }
    return kept;
  }

  return {
    priceOf,

    /** Usuals on a deal this week. */
    async usualDeals(list) {
      const priced = await mapLimited(list, 3, (usual) => priceOf(usual));
      return list
        .map((usual, i) => ({ ...usual, price: priced[i].price, deal: priced[i].deal }))
        .filter((usual) => usual.deal);
    },

    /**
     * For each item in an order: its price and deal, what the deal saves, one
     * more to complete a multi-buy where that's worth it, and cheaper ways to
     * buy the same food. `regulars` are products bought often enough that a
     * spare one will get used.
     */
    async check(items, { regulars = new Set() } = {}) {
      return mapLimited(items, 3, async (input) => {
        const item = { ...input, brand: (await similarOf(input).catch(() => null))?.brand ?? null };
        const current = await priceOf(item);
        const { price, deal } = current;
        const cost = costOf(item.quantity, price, deal);
        const saves = cost == null ? 0 : regularCost(item.quantity, price, deal) - cost;
        let oneMore = null;
        if (deal && price != null && regulars.has(item.productId)) {
          const terms = dealTerms(deal.label, deal.price ?? price);
          if (terms.count > 1 && item.quantity % terms.count === terms.count - 1) {
            const extra = costOf(item.quantity + 1, price, deal) - cost;
            oneMore = { extra, saves: price - extra };
          }
        }
        return {
          productId: item.productId,
          price,
          deal,
          unavailable: current.unavailable ?? null,
          cost,
          saves,
          oneMore: oneMore && oneMore.saves > 0 ? oneMore : null,
          cheaper: await cheaperFor(item, current),
        };
      });
    },
  };
}
