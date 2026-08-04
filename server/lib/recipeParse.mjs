// Reading an ingredient line.
//
// "2 tbsp olive oil" has to become a quantity, a unit and a food name before
// anything can be looked up. Recipes are written by people, so the input is
// "1 1/2 cups milk", "500g chicken", "3 large eggs, beaten", "a pinch of salt",
// and "2 tablespoons (30 ml) olive oil" — all of which mean something precise
// and none of which are written the same way.
//
// This is deliberately a parser rather than a model call: the line is already
// text, and arithmetic on text is something a computer does exactly.

const VULGAR = {
  '¼': 0.25, '½': 0.5, '¾': 0.75, '⅐': 1 / 7, '⅑': 1 / 9, '⅒': 0.1,
  '⅓': 1 / 3, '⅔': 2 / 3, '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

/** Canonical unit names, and every spelling that means them. */
const UNITS = {
  g: ['g', 'gr', 'gram', 'grams', 'gramme', 'grammes'],
  kg: ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms'],
  oz: ['oz', 'ounce', 'ounces'],
  lb: ['lb', 'lbs', 'pound', 'pounds'],
  ml: ['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters', 'cc'],
  l: ['l', 'litre', 'litres', 'liter', 'liters'],
  cup: ['cup', 'cups'],
  tbsp: ['tbsp', 'tbs', 'tablespoon', 'tablespoons', 'el'],
  tsp: ['tsp', 'teaspoon', 'teaspoons', 'tl'],
  'fl oz': ['floz', 'fl oz', 'fluid ounce', 'fluid ounces'],
  pinch: ['pinch', 'pinches'],
  clove: ['clove', 'cloves'],
  slice: ['slice', 'slices'],
  can: ['can', 'cans', 'tin', 'tins'],
  handful: ['handful', 'handfuls'],
  stick: ['stick', 'sticks'],
  sprig: ['sprig', 'sprigs'],
  rasher: ['rasher', 'rashers'],
  stalk: ['stalk', 'stalks', 'stick', 'sticks'],
};

const UNIT_BY_SPELLING = new Map();
for (const [canonical, spellings] of Object.entries(UNITS)) {
  for (const spelling of spellings) UNIT_BY_SPELLING.set(spelling, canonical);
}

/** Words that describe the item's size rather than measure it. */
const SIZES = new Set(['large', 'medium', 'small', 'extra-large', 'jumbo']);

/** Preparation that follows the food and isn't part of its name. */
const PREPARATION =
  /\b(finely |roughly |thinly |coarsely |freshly )?(chopped|sliced|diced|minced|grated|crushed|beaten|melted|softened|peeled|drained|rinsed|cubed|shredded|julienned|halved|quartered|trimmed|to taste|for (serving|garnish|drizzling|frying)|optional)\b/gi;

/** A number, however it's written: 2, 1.5, 1/2, ½, 1 1/2, 1½. */
function readQuantity(text) {
  const rest0 = text.trim();

  // A range means the middle of it: "2-3 cloves" is two or three.
  const range = /^(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\b/.exec(rest0);
  if (range) {
    return {
      quantity: (Number(range[1]) + Number(range[2])) / 2,
      rest: rest0.slice(range[0].length).trim(),
    };
  }

  // A bare fraction, before anything else: "1/2 cup" is a half, not a one.
  // This can't swallow the "1" of "1 1/2" — that has a space where the slash
  // would have to be.
  const bare = /^(\d+)\s*\/\s*(\d+)\s*/.exec(rest0);
  if (bare) {
    return { quantity: Number(bare[1]) / Number(bare[2]), rest: rest0.slice(bare[0].length).trim() };
  }
  const bareVulgar = VULGAR[rest0[0]];
  if (bareVulgar !== undefined) {
    return { quantity: bareVulgar, rest: rest0.slice(1).trim() };
  }

  const whole = /^(\d+(?:[.,]\d+)?)\s*/.exec(rest0);
  if (!whole) return { quantity: null, rest: rest0 };

  let total = Number(whole[1].replace(',', '.'));
  let rest = rest0.slice(whole[0].length);

  // A fraction straight after a whole number adds to it, written either way:
  // "1 1/2 cups" and "1½ cups" are the same amount.
  const fraction = /^(\d+)\s*\/\s*(\d+)\s*/.exec(rest);
  if (fraction) {
    total += Number(fraction[1]) / Number(fraction[2]);
    rest = rest.slice(fraction[0].length);
  } else if (VULGAR[rest[0]] !== undefined) {
    total += VULGAR[rest[0]];
    rest = rest.slice(1);
  }

  return { quantity: total, rest: rest.trim() };
}

/** The leading unit word, if the line has one. */
function readUnit(text) {
  // "fl oz" and "fluid ounce" are two words; try those before single words.
  const two = /^([a-zà-ÿ]+\s+[a-zà-ÿ]+)\b\.?/i.exec(text);
  if (two && UNIT_BY_SPELLING.has(two[1].toLowerCase())) {
    return { unit: UNIT_BY_SPELLING.get(two[1].toLowerCase()), rest: text.slice(two[0].length).trim() };
  }
  const one = /^([a-zà-ÿ]+)\b\.?/i.exec(text);
  if (one && UNIT_BY_SPELLING.has(one[1].toLowerCase())) {
    return { unit: UNIT_BY_SPELLING.get(one[1].toLowerCase()), rest: text.slice(one[0].length).trim() };
  }
  return { unit: null, rest: text };
}

/**
 * One written line into its parts.
 *
 * `note` keeps whatever the line said about preparation, so nothing is thrown
 * away — a person checking the parse can see the line they wrote.
 */
export function parseIngredient(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return null;

  // Leading list marks, and a trailing note after the last comma.
  let text = raw.replace(/^[-•*•]\s*/, '').trim();

  let { quantity, rest: working } = readQuantity(text);

  // "2 x 400g tins" is two of a 400g tin, which is 800g of tomatoes.
  const multiplied = /^x\s*(\d+(?:[.,]\d+)?)\s*(g|gr|grams?|kg|ml|l)\b\.?/i.exec(working);
  if (multiplied && quantity != null) {
    const each = Number(multiplied[1].replace(',', '.'));
    const unit = UNIT_BY_SPELLING.get(multiplied[2].toLowerCase());
    return finish(raw, quantity * each, unit, null, working.slice(multiplied[0].length).trim());
  }

  // A parenthesised weight is the precise version of the same amount:
  // "1 (400g) tin chopped tomatoes", "2 tablespoons (30 ml) olive oil".
  let parenthesised = null;
  working = working.replace(/\(([^)]*)\)/g, (whole, inside) => {
    const measure = /^\s*(\d+(?:[.,]\d+)?)\s*(g|gr|gram|grams|kg|ml|l|oz|lb)\b/i.exec(inside);
    if (measure && !parenthesised) {
      parenthesised = {
        quantity: Number(measure[1].replace(',', '.')),
        unit: UNIT_BY_SPELLING.get(measure[2].toLowerCase()),
      };
      return ' ';
    }
    return ` ${inside} `; // keep other parentheticals as words
  });

  let { unit, rest } = readUnit(working.trim());

  // "3 large eggs": a size word isn't a unit, but it does belong to the name.
  let size = null;
  const sizeMatch = /^([a-z-]+)\b/i.exec(rest);
  if (!unit && sizeMatch && SIZES.has(sizeMatch[1].toLowerCase())) {
    size = sizeMatch[1].toLowerCase();
    rest = rest.slice(sizeMatch[0].length).trim();
  }

  // "of" survives from "a pinch of salt".
  rest = rest.replace(/^of\s+/i, '').trim();

  const notes = [];
  rest = rest
    .replace(PREPARATION, (match) => {
      notes.push(match.trim());
      return ' ';
    })
    .replace(/[,;]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Recipes write the measure after the food as readily as before it: "2 celery
  // sticks", "2 garlic cloves", "4 bacon rashers". Left in the name those match
  // nothing — the database has celery, not celery sticks. Preparation has to be
  // off the end first, or the last word is "chopped".
  if (!unit) {
    const trailing = /^(.*?)\s+([a-zà-ÿ]+)$/i.exec(rest);
    const candidate = trailing && UNIT_BY_SPELLING.get(trailing[2].toLowerCase());
    if (candidate && trailing[1].trim()) {
      unit = candidate;
      rest = trailing[1].trim();
    }
  }

  return finish(
    raw,
    parenthesised ? parenthesised.quantity : quantity,
    parenthesised ? parenthesised.unit : unit,
    size,
    rest,
    notes.join(', ') || null,
  );
}

/** Packaging, which is not the food and only spoils the match. */
const CONTAINERS = /^(tins?|cans?|jars?|packs?|packets?|boxes|bags?|bottles?|punnets?)\s+/i;

/** The parsed shape, with the food name tidied the same way on every path. */
function finish(raw, quantity, unit, size, name, note = null) {
  const notes = [];
  const cleaned = String(name ?? '')
    .replace(PREPARATION, (match) => {
      notes.push(match.trim());
      return ' ';
    })
    .replace(/[,;]\s*$/, '')
    .replace(CONTAINERS, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    raw,
    quantity,
    unit,
    size: size ?? null,
    name: cleaned.replace(/^and\s+/i, '').trim(),
    note: note ?? (notes.join(', ') || null),
  };
}

/** A block of lines into ingredients, ignoring blanks and headings. */
export function parseIngredients(lines) {
  const list = Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/);
  return list
    .map((line) => parseIngredient(line))
    .filter((item) => item && item.name)
    // "For the sauce:" is a heading, not an ingredient.
    .filter((item) => !/^for the\b/i.test(item.raw) && !item.raw.trim().endsWith(':'));
}
