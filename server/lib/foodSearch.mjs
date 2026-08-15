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
 * What shape the food is in, as opposed to what it is.
 *
 * Cheddar is cheddar whether it is shredded, sliced or in a block, but the
 * reference tables rarely say which, so requiring the word finds only the
 * packets that happen to print it — "shredded cheddar cheese" landed on a
 * dairy-free alternative at 80 kcal/100g, a fifth of real cheddar, because it
 * was the one row that used the word. Treated like preparation: dropped when a
 * match depends on it, still counted when ranking, so a row that does say
 * "shredded" is preferred when one exists.
 *
 * "soft" is here for the same reason from the other direction: "soft boiled
 * egg" matched nothing at all, while every hard-boiled row sat one word short.
 */
// Deliberately excludes words that change what the food *is* rather than its
// shape: "whole" (milk), "ground" (beef) and "minced" carry real nutrition.
export const FORM = new Set([
  'soft', 'shredded', 'grated', 'sliced', 'chopped', 'diced',
  'crumbled', 'flaked', 'flake', 'mashed', 'mini',
]);

/** Words a match may lack: how it was cooked, and what shape it is in. */
const OPTIONAL = new Set([...PREPARATION, ...FORM]);

/**
 * The words a match has to actually contain. Preparation is excluded: a
 * database holding "chicken breast, roasted" but not "grilled" should still
 * answer "grilled chicken breast", because the cooking method barely moves the
 * nutrition. It still counts for *ranking* — a grilled row wins when it exists.
 */
const contentTokens = (tokens) => {
  const content = tokens.filter((t) => !OPTIONAL.has(t));
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

/**
 * British and Dutch-English words for foods the database names American.
 *
 * USDA is the reference data and it says "ground beef", "eggplant", "cilantro".
 * A recipe written here says mince, aubergine, coriander — and matched nothing
 * at all, because a name that shares only half its words is refused rather than
 * guessed at. Translating the query is the fix; the index stays as published.
 */
const SYNONYMS = {
  mince: 'ground',
  minced: 'ground',
  aubergine: 'eggplant',
  courgette: 'zucchini',
  coriander: 'cilantro',
  rocket: 'arugula',
  prawn: 'shrimp',
  chickpea: 'garbanzo',
  swede: 'rutabaga',
  beetroot: 'beet',
  sultana: 'raisin',
  passata: 'tomato',
  gammon: 'ham',
  rasher: 'bacon',
  biscuit: 'cookie',
  crisp: 'chip',
  chips: 'fries',
  yoghurt: 'yogurt',
  maize: 'corn',
  tinned: 'canned',
};

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
    .map((word) => SYNONYMS[word] ?? word)
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

  const withoutPrep = tokens.filter((t) => !OPTIONAL.has(t));
  if (withoutPrep.length > 0 && withoutPrep.length < tokens.length) {
    plan.push(withoutPrep.map(quote).join(' AND '));
  }
  // Prefixed OR: "chicken* OR breast*" still ranks rows containing both first.
  if (tokens.length > 1) plan.push(tokens.map((t) => `${quote(t)}*`).join(' OR '));
  return plan;
}

// Whole-food references beat crowd-sourced packaged data for a generic name
// like "rice"; a barcode lookup would have gone down a different path entirely.
const SOURCE_BONUS = { nevo: 3, usda: 2.5, seed: 2, custom: 1, openfoodfacts: 0 };

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
 * Parts that are catalogued separately from the food they came from, and whose
 * nutrition is nothing like it. USDA lists "Chicken, skin (drumsticks and
 * thighs), cooked, roasted" at 462 kcal/100g beside the drumstick itself at
 * 191 — and the skin row won, because its name is shorter and leads with the
 * word asked for. Nobody photographing dinner means the skin.
 *
 * Not penalised when the name also says "meat": USDA writes the whole piece as
 * "meat and skin", which is exactly what a drumstick is.
 */
const PART_WORDS = new Set([
  'skin', 'giblets', 'gizzard', 'liver', 'kidney', 'heart', 'neck', 'bone',
  'bones', 'marrow', 'rind', 'peel', 'hull', 'bran', 'germ', 'tallow', 'lard',
  'drippings', 'shell', 'shells',
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
      // Whole words, not substrings. "toasted bread rounds" was committed to
      // "Veal, leg (top round), cooked, pan-fried, breaded" at full coverage,
      // because "bread" is inside "breaded" and "round" inside "(top round)".
      // Both sides go through the same tokeniser, so singulars and the British
      // spellings line up as they did before.
      const words = new Set(tokenize(name));
      const required = contentTokens(tokens);
      const covered = required.filter((t) => writtenForms(t).some((f) => words.has(f))).length;
      const coverage = required.length ? covered / required.length : 0;
      // Preparation and form still influence the ordering, just not admissibility.
      const prepBonus = tokens.filter((t) => OPTIONAL.has(t) && words.has(t)).length;

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
      //
      // Only the first couple of words count as the announcement. A product
      // name is a phrase rather than a classification, and one of these words
      // can appear anywhere in it without being what the row is: "Texas Toast
      // Garlic & Butter Flavored Croutons" is croutons, and reading it as
      // butter cost the only match "garlic croutons" had. "Peanut butter cups"
      // still names its derived product where such a name always does — at
      // the front.
      const head = tokenize(name.split(',')[0]);
      const leading = tokenize(name).slice(0, 2);
      if (leading.some((word) => DERIVED_HEAD.has(word) && !tokens.includes(word))) score -= 7;

      // A row for a part of the animal, when the query asked for the animal.
      if (
        !words.has('meat') &&
        [...words].some((word) => PART_WORDS.has(word) && !tokens.includes(word))
      ) {
        score -= 6;
      }

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
export function searchFoods(
  db,
  query,
  { limit = 25, requireNutrition = false, sources, ownerId } = {},
) {
  const plan = buildMatchPlan(query);
  let filter = requireNutrition ? 'AND f.kcal100 IS NOT NULL' : '';
  const extra = [];
  if (sources?.length) {
    filter += ` AND f.source IN (${sources.map(() => '?').join(', ')})`;
    extra.push(...sources);
  }
  // Shared reference data, plus this user's own foods. Another user's private
  // food is not a search result, however well it matches.
  if (ownerId !== undefined) {
    filter += ' AND (f.ownerId IS NULL OR f.ownerId = ?)';
    extra.push(ownerId);
  }

  // Every plan runs and the results are ranked together, rather than stopping
  // at the first that returns anything. A strict plan finding one poor row used
  // to hide the better answers a relaxed plan would have found: "shredded
  // cheddar cheese" matched exactly one product — a dairy-free alternative at a
  // fifth of cheddar's calories — and the plan that would have found cheddar
  // never ran. Ranking decides between them; matching only decides who is
  // considered. The strict plan is still cheapest and usually enough, so it is
  // the only one that runs when it fills the result set.
  const collected = new Map();
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
    for (const row of rows) if (!collected.has(row.id)) collected.set(row.id, row);
    if (collected.size >= limit * 4) break;
  }
  if (collected.size === 0) return [];
  return rankRows([...collected.values()], query).slice(0, limit);
}

/**
 * Search results with the reference foods first.
 *
 * Typing "chicken breast" means the food; typing "Nutella" means the packet.
 * The difference can't be expressed as a weight: bm25 rewards a short product
 * named exactly "Chicken breast" more than any source bonus safe enough to set,
 * and raising that bonus threefold still left five of eight generic searches on
 * a crowd-sourced row.
 *
 * So it is a rule instead. If a reference food covers everything the query
 * asked for, reference foods come first and the products follow. A query
 * nothing curated matches — pindakaas, hagelslag, every Dutch staple USDA has
 * never heard of — falls straight through to the products, which for those
 * foods are the only record there is.
 */
export function searchFoodsTiered(db, query, { limit = 25, ...options } = {}) {
  const reference = searchFoods(db, query, {
    ...options,
    limit,
    sources: ['nevo', 'usda', 'seed', 'custom'],
  }).filter((row) => row.coverage >= MIN_COVERAGE);

  if (reference.length === 0) return searchFoods(db, query, { ...options, limit });

  const seen = new Set(reference.map((row) => row.id));
  const products = searchFoods(db, query, { ...options, limit }).filter((row) => !seen.has(row.id));
  return [...reference, ...products].slice(0, limit);
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
export const GENERIC_SOURCES = ['nevo', 'usda', 'seed'];

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
export function matchFood(db, query, options = {}) {
  return matchCandidates(db, query, { ...options, limit: 1 })[0] ?? null;
}

/**
 * The matches worth considering, best first — all of them confident enough to
 * commit to. A caller that needs more than a name from the row (a recipe line
 * needs a portion it can weigh "1 large onion" by) can take the best one that
 * actually answers, rather than the best one overall.
 */
export function matchCandidates(db, query, { preferSources = GENERIC_SOURCES, limit = 5, ...options } = {}) {
  // Ask for more than are wanted, because the coverage floor is applied after
  // the search has already ranked and cut. A row that answers the query can sit
  // just outside a five-row cut behind rows that are about to be thrown away,
  // and cutting first loses it: "garlic croutons" and "instant ramen noodles"
  // both went from a good match to none that way.
  const pool = Math.max(limit * 5, 25);
  const search = (sources) =>
    searchFoods(db, query, { ...options, sources, limit: pool, requireNutrition: true }).filter(
      (row) => row.coverage >= MIN_COVERAGE,
    );

  const preferred = preferSources?.length ? search(preferSources) : [];
  const rest = search(undefined).filter((row) => !preferred.some((p) => p.id === row.id));
  return [...preferred, ...rest].slice(0, limit);
}
