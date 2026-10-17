// Nutri-Score for Picnic products, and better-scoring swaps for the worst.
//
// A product's grade comes from the nutrition on its Picnic page. For one graded
// D or E, the candidates are Picnic's own "similar products" plus a search for
// its name without the brand. Picnic's list happily offers ham for chicken
// fillet, so a candidate only counts if its name shares a word with the
// original's — once brands and generic words like "naturel" are left out.
//
// A product page takes a request, and a swap check takes a dozen, so grades and
// swaps are kept for a month: what's in a product rarely changes.

import { picnicFood } from './picnicNutrition.mjs';
import { nutriScore } from './nutriScore.mjs';
import { mapLimited } from './picnicShopping.mjs';

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Raised when grading changes, so grades kept from before are worked out again. */
const GRADE_VERSION = 2;
const SWAP_GRADES = new Set(['D', 'E']);
/** A swap has to be worth making: E to D is barely one. */
const GOOD_GRADES = new Set(['A', 'B', 'C']);
const MAX_CANDIDATES = 12;
const MAX_SWAPS = 3;

export function createSwapTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS picnic_product_grades (
    productId TEXT PRIMARY KEY, name TEXT, brand TEXT, grade TEXT,
    similarJson TEXT NOT NULL DEFAULT '[]', swapsJson TEXT, checkedAt TEXT NOT NULL
  )`);
  const columns = new Set(db.prepare('PRAGMA table_info(picnic_product_grades)').all().map((c) => c.name));
  if (!columns.has('version')) db.exec('ALTER TABLE picnic_product_grades ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
}

/** Words in names that say nothing about what the food is. */
const GENERIC = new Set(
  'naturel original origineel classic plakken stuks gesneden flinterdun mager light zero extra bio biologisch vers verse groot grote klein kleine mini pack voordeelverpakking smaak'.split(
    ' ',
  ),
);

const wordsOf = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/);

/** The words of a name that say what it is: no brand, nothing generic, nothing short. */
export function foodWords(name, brand) {
  const brandWords = new Set(wordsOf(brand));
  return wordsOf(name).filter((w) => w.length >= 4 && !GENERIC.has(w) && !brandWords.has(w) && !/^\d/.test(w));
}

/**
 * How many of the original's food words the candidate shares, or 0 when they
 * are under half of the candidate's own: "olives filled with feta" mentions
 * feta, but isn't feta.
 */
export function sharedWords(original, candidate, { strict = true } = {}) {
  const theirs = new Set(foodWords(candidate.name, candidate.brand));
  const shared = foodWords(original.name, original.brand).filter((w) => theirs.has(w)).length;
  return !strict || shared * 2 >= theirs.size ? shared : 0;
}

/**
 * The best swaps among graded candidates: graded A to C, sharing a food word,
 * ordered by how alike they are and then by grade.
 */
export function pickSwaps(original, candidates) {
  return candidates
    // Graded A to C, and better than the original: a C is only swapped for an A or B.
    .filter(
      (c) =>
        c.productId !== original.productId && GOOD_GRADES.has(c.grade) && 'ABCDE'.indexOf(c.grade) < 'ABCDE'.indexOf(original.grade),
    )
    .map((c) => ({ ...c, shared: sharedWords(original, c) }))
    .filter((c) => c.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.grade.localeCompare(b.grade) || (a.price ?? 0) - (b.price ?? 0))
    .slice(0, MAX_SWAPS)
    .map(({ shared, brand, ...swap }) => swap);
}

const fresh = (row, now) => row && row.version === GRADE_VERSION && now - Date.parse(row.checkedAt) < KEEP_MS;

export function createSwapChecker(db, picnic, { now = () => Date.now() } = {}) {
  const read = db.prepare('SELECT * FROM picnic_product_grades WHERE productId = ?');
  const write = db.prepare(
    `INSERT OR REPLACE INTO picnic_product_grades (productId, name, brand, grade, similarJson, swapsJson, checkedAt, version)
     VALUES (@productId, @name, @brand, @grade, @similarJson, @swapsJson, @checkedAt, ${GRADE_VERSION})`,
  );
  const setSwaps = db.prepare('UPDATE picnic_product_grades SET swapsJson = ? WHERE productId = ?');

  /** A product's grade (null when its page has no usable nutrition), from the shelf or Picnic. */
  async function graded({ productId, name }) {
    const kept = read.get(productId);
    if (fresh(kept, now())) return kept;
    let details = null;
    try {
      details = await picnic.product(productId);
    } catch {
      // Some product pages don't parse; such a product just has no grade.
    }
    const food = details && picnicFood(details, { name });
    const row = {
      productId,
      name: name || details?.name || productId,
      brand: details?.brand ?? null,
      grade: (food && nutriScore(food)?.grade) ?? null,
      similarJson: JSON.stringify(
        (details?.similarProducts ?? []).map((s) => ({
          productId: s.id,
          name: s.name,
          imageId: s.imageId ?? null,
          unitQuantity: s.unitQuantity ?? null,
          price: s.displayPrice ?? null,
        })),
      ),
      swapsJson: null,
      checkedAt: new Date(now()).toISOString(),
    };
    write.run(row);
    return row;
  }

  async function swapsFor(row) {
    if (row.swapsJson) return JSON.parse(row.swapsJson);
    const candidates = new Map();
    for (const s of JSON.parse(row.similarJson)) candidates.set(s.productId, s);
    const query = foodWords(row.name, row.brand).join(' ');
    if (query) {
      const found = await picnic.search(query).catch(() => []);
      for (const unit of found ?? []) {
        if (!/^s\d+$/.test(unit.id ?? '') || candidates.has(unit.id)) continue;
        candidates.set(unit.id, {
          productId: unit.id,
          name: unit.name,
          imageId: unit.image_id ?? null,
          unitQuantity: unit.unit_quantity ?? null,
          price: unit.display_price ?? null,
        });
      }
    }
    candidates.delete(row.productId);
    // Only names that could be a swap are worth a request for their grade.
    // Their brand isn't known until then, so this is the loose test.
    const plausible = [...candidates.values()]
      .filter((c) => sharedWords(row, c, { strict: false }) > 0)
      .slice(0, MAX_CANDIDATES);
    const scored = await mapLimited(plausible, 3, async (c) => {
      const g = await graded(c);
      return { ...c, grade: g.grade, brand: g.brand };
    });
    const swaps = pickSwaps(row, scored);
    setSwaps.run(JSON.stringify(swaps), row.productId);
    return swaps;
  }

  /**
   * Each product's grade, and for a D or E, up to three better swaps — for a
   * C too when `alsoC`, as during someone's A/B month.
   */
  async function check(products, { alsoC = false } = {}) {
    return mapLimited(products, 3, async (product) => {
      const row = await graded(product);
      const swaps = SWAP_GRADES.has(row.grade) || (alsoC && row.grade === 'C') ? await swapsFor(row) : [];
      return { productId: product.productId, grade: row.grade, swaps };
    });
  }

  /** A product's grade, or null, kept for a month. */
  check.gradeOf = async (product) => (await graded(product)).grade;

  /** A product's brand and Picnic's similar products, from the same month-long keeping. */
  check.similar = async (product) => {
    const row = await graded(product);
    return { brand: row.brand, products: JSON.parse(row.similarJson) };
  };
  return check;
}
