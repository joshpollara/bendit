// Finding a food by name.
//
// This is the join between a vision model's words ("grilled chicken breast")
// and a database row ("Chicken, broilers or fryers, breast, meat only, cooked,
// grilled"). Two things make that hard:
//
//   • USDA names are written back-to-front, comma-separated, with the qualifier
//     last. Ordinary phrase matching fails on them; token matching doesn't.
//   • Cooking methods and vague adjectives ("fresh", "homemade") are noise in
//     some rows and signal in others, so they're dropped only when keeping them
//     finds nothing.
//
// Everything here is plain SQLite FTS5 with bm25 — no vector index, no embedding
// service, no extra dependency.

/** Words that add nothing to a match and often prevent one. */
const NOISE = new Set([
  'a', 'an', 'and', 'the', 'of', 'with', 'without', 'some', 'my', 'fresh',
  'homemade', 'plain', 'regular', 'ordinary', 'serving', 'portion', 'piece',
  'pieces', 'slice', 'slices', 'medium', 'large', 'small',
]);

/**
 * Preparation words. Kept for the first attempt — "grilled" genuinely
 * distinguishes rows — then dropped on the retry, because a database that has
 * "chicken breast, roasted" but not "grilled" should still answer.
 */
export const PREPARATION = new Set([
  'grilled', 'roasted', 'baked', 'fried', 'boiled', 'steamed', 'cooked',
  'raw', 'broiled', 'sauteed', 'sauteed', 'poached', 'toasted', 'seared',
]);

/**
 * The words a match has to actually contain. Preparation is excluded: a
 * database holding "chicken breast, roasted" but not "grilled" should still
 * answer "grilled chicken breast", because the cooking method barely moves the
 * nutrition. It still counts for *ranking* — a grilled row wins when it exists.
 */
const contentTokens = (tokens) => {
  const content = tokens.filter((t) => !PREPARATION.has(t));
  return content.length > 0 ? content : tokens;
};

/**
 * The written forms a singularised token might appear as in a name.
 *
 * Singularising "-ies" to "-y" is right for berries and wrong for cookies —
 * "cooky" appears in no food name, so the coverage check couldn't find its own
 * token and refused a row that matched perfectly well. English can't tell the
 * two apart without a dictionary, so both endings are accepted. (The FTS index
 * itself is unaffected: Porter stemming already matches either.)
 */
function writtenForms(token) {
  if (!token.endsWith('y')) return [token];
  const root = token.slice(0, -1);
  return [token, `${root}ies`, `${root}ie`];
}

/** Crude, deliberate: only the plural forms that actually show up in food names. */
function singular(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('oes')) return word.slice(0, -2);
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('ches')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** A query string into comparable tokens. */
export function tokenize(query) {
  return String(query ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents: "sautéed" ~ "sauteed"
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .filter((w) => !NOISE.has(w));
}

/** FTS5 is a query language, and user text must never be spliced into it raw. */
const quote = (token) => `"${token.replace(/"/g, '""')}"`;

/**
 * Builds the match expressions to try in order: everything, then without
 * preparation words, then any-of as a last resort.
 */
export function buildMatchPlan(query) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const plan = [tokens.map(quote).join(' AND ')];

  const withoutPrep = tokens.filter((t) => !PREPARATION.has(t));
  if (withoutPrep.length > 0 && withoutPrep.length < tokens.length) {
    plan.push(withoutPrep.map(quote).join(' AND '));
  }
  // Prefixed OR: "chicken* OR breast*" still ranks rows containing both first.
  if (tokens.length > 1) plan.push(tokens.map((t) => `${quote(t)}*`).join(' OR '));
  return plan;
}

// Whole-food references beat crowd-sourced packaged data for a generic name
// like "rice"; a barcode lookup would have gone down a different path entirely.
const SOURCE_BONUS = { usda: 2.5, seed: 2, custom: 1, openfoodfacts: 0 };

/**
 * Words that head a *derived or prepared* product rather than the ingredient.
 * USDA names lead with the category, so "almonds" otherwise matches "Oil,
 * almond" (884 kcal/100g) as readily as "Nuts, almonds" (579) — a fivefold
 * error from one wrong row. Penalised only when the query didn't ask for it,
 * so "olive oil" still finds the oil.
 */
const DERIVED_HEAD = new Set([
  'oil', 'juice', 'soup', 'sauce', 'syrup', 'powder', 'extract', 'flour',
  'drink', 'beverage', 'beverages', 'candy', 'candies', 'snack', 'snacks',
  'restaurant', 'fast', 'babyfood', 'infant', 'formula', 'formulated', 'gravy',
  'butter', // "almonds" must not land on "Almond butter"; "peanut butter" still does
]);

/**
 * bm25 is a relevance score, not a food score. These adjustments encode what
 * bm25 can't know: that a short name is usually the plain form of an
 * ingredient, and that a row whose name contains every query word is a better
 * answer than one that merely mentions them.
 */
export function rankRows(rows, query) {
  const tokens = tokenize(query);
  return rows
    .map((row) => {
      const name = row.name.toLowerCase();
      const required = contentTokens(tokens);
      const covered = required.filter((t) => writtenForms(t).some((f) => name.includes(f))).length;
      const coverage = required.length ? covered / required.length : 0;
      // Preparation still influences the ordering, just not admissibility.
      const prepBonus = tokens.filter((t) => PREPARATION.has(t) && name.includes(t)).length;

      let score = -(row.bm25 ?? 0); // bm25 is negative-better; flip it
      score += coverage * 6;
      score += prepBonus * 2;
      score += SOURCE_BONUS[row.source] ?? 0;
      if (name === tokens.join(' ')) score += 5; // exact phrase
      score -= Math.min(3, name.length / 40); // prefer the plainer name
      if (row.kcal100 == null) score -= 4; // useless for computing nutrition

      // The leading segment of a USDA name says what kind of thing the row is.
      // If it announces a derived product the query never mentioned, it's the
      // wrong row however well the words line up.
      const head = tokenize(name.split(',')[0]);
      if (head.some((word) => DERIVED_HEAD.has(word) && !tokens.includes(word))) score -= 7;

      // A head that says nothing the query didn't is the plain form of the
      // food. "boiled potatoes" otherwise matched "Sweet potato, cooked,
      // boiled" ahead of "Potatoes, boiled" — a different vegetable that
      // happens to contain the word. A qualifier in the head changes what the
      // food *is*, so a head without one wins.
      if (head.length > 0 && head.every((word) => tokens.includes(word))) score += 2.5;

      return { ...row, score, coverage };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Searches the foods table. `db` is a better-sqlite3 handle; kept as a
 * parameter so this stays testable against an in-memory database.
 */
export function searchFoods(db, query, { limit = 25, requireNutrition = false, sources } = {}) {
  const plan = buildMatchPlan(query);
  let filter = requireNutrition ? 'AND f.kcal100 IS NOT NULL' : '';
  const extra = [];
  if (sources?.length) {
    filter += ` AND f.source IN (${sources.map(() => '?').join(', ')})`;
    extra.push(...sources);
  }

  for (const match of plan) {
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT f.*, bm25(foods_fts) AS bm25
           FROM foods_fts JOIN foods f ON f.rowid = foods_fts.rowid
           WHERE foods_fts MATCH ? ${filter}
           ORDER BY bm25 LIMIT ?`,
        )
        .all(match, ...extra, limit * 4);
    } catch {
      // A malformed match expression means no results, not a 500.
      continue;
    }
    if (rows.length > 0) return rankRows(rows, query).slice(0, limit);
  }
  return [];
}

/**
 * How much of the query a row must actually contain to be committed to. Set so
 * a two-word query needs both words: "salmon fillet" must not settle for
 * "Vegetarian fillets" on the strength of one of them.
 */
export const MIN_COVERAGE = 0.75;

/**
 * Sources that describe a food rather than a product. A meal photo says "white
 * rice", never "Jumbo White Rice 1kg", and the reference tables are where a
 * generic name has an authoritative answer.
 */
export const GENERIC_SOURCES = ['usda', 'seed'];

/**
 * The single best match, or null. Used by the meal-photo path, where a wrong
 * confident answer is worse than admitting there wasn't one.
 *
 * `preferSources` is tried first and the rest of the table only if it finds
 * nothing. With 300,000 crowd-sourced products in the same index, a short
 * branded name will out-rank the reference row for a generic query — which is
 * how "white rice" landed on a packaged product at 221 kcal/100g instead of
 * USDA's cooked long-grain at 130. A source bonus alone couldn't fix that
 * reliably; asking the reference tables first does.
 */
export function matchFood(db, query, { preferSources = GENERIC_SOURCES, ...options } = {}) {
  const search = (sources) =>
    searchFoods(db, query, { ...options, sources, limit: 1, requireNutrition: true })[0];

  const preferred = preferSources?.length ? search(preferSources) : null;
  if (preferred && preferred.coverage >= MIN_COVERAGE) return preferred;

  const best = search(undefined);
  if (!best || best.coverage < MIN_COVERAGE) return null;
  return best;
}
