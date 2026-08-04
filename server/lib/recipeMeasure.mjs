// "2 tbsp olive oil" into grams.
//
// A tablespoon of oil is 14 g and a tablespoon of honey is 21 g, so the useful
// answer comes from the food itself. USDA publishes portions per food — "1 cup
// (125g)" for flour, "1 cup (244g)" for milk — and those are already imported
// into food_servings, which is where this looks first.
//
// Failing that there is a table of generic measures, which is right about
// water and roughly right about everything else. Every result says which route
// it took, because a number that came from the food's own data and a number
// that came from assuming the density of water deserve different treatment on
// screen.

const MASS_IN_GRAMS = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOLUME_IN_ML = { ml: 1, l: 1000, cup: 240, tbsp: 15, tsp: 5, 'fl oz': 29.5735 };

/**
 * Generic weights for a measure, when the food has nothing better. Water is
 * 1 g/ml; most cooking liquids are near enough. Solids vary far more, which is
 * why these are the fallback rather than the rule.
 */
const GENERIC_GRAMS = {
  pinch: 0.4,
  clove: 3, // a garlic clove
  slice: 25, // a slice of bread
  handful: 30,
  stick: 113, // a stick of butter
  sprig: 2,
  can: 400,
};

/** How sure the weight is, and where it came from. */
export const SOURCES = {
  stated: 'stated', // the line said grams or millilitres
  food: 'food', // the food's own portion table
  generic: 'generic', // a standard measure, not this food's
  unknown: 'unknown', // no way to weigh it
};

const clean = (label) => String(label ?? '').toLowerCase();

/**
 * A portion of this food matching the unit, if it has one.
 * "1 tablespoon (14g)" answers a tbsp; "1 cup, chopped (160g)" answers a cup.
 */
function portionFor(servings, unit, size) {
  if (!servings?.length) return null;
  const wanted = {
    cup: ['cup'],
    tbsp: ['tbsp', 'tablespoon'],
    tsp: ['tsp', 'teaspoon'],
    slice: ['slice'],
    clove: ['clove'],
    stick: ['stick'],
    can: ['can', 'tin'],
    'fl oz': ['fl oz'],
  }[unit];

  // A size word ("3 large eggs") is answered by "1 large (50g)".
  const words = wanted ?? (size ? [size] : null);
  if (!words) return null;

  const matches = servings.filter((s) => words.some((w) => clean(s.label).includes(w)));
  if (matches.length === 0) return null;
  // Prefer the plainest: "1 cup (125g)" over "1 cup, sifted (110g)".
  return matches.sort((a, b) => clean(a.label).length - clean(b.label).length)[0];
}

/** Grams per millilitre for this food, derived from a volume portion it has. */
function densityFrom(servings) {
  for (const [unit, ml] of Object.entries(VOLUME_IN_ML)) {
    const portion = portionFor(servings, unit, null);
    if (portion?.grams > 0) {
      // "1 cup (244g)" means 244g per 240ml.
      const count = /^([\d.]+)/.exec(clean(portion.label));
      const times = count ? Number(count[1]) || 1 : 1;
      return portion.grams / (ml * times);
    }
  }
  return null;
}

/**
 * The weight of one ingredient line.
 *
 * `servings` is the food's own portion list, or empty when nothing matched —
 * in which case a stated weight still works and everything else doesn't.
 */
export function weighIngredient({ quantity, unit, size, name }, servings = []) {
  const grams = (value, source) => ({ grams: Math.round(value * 10) / 10, source });

  if (!(quantity > 0)) {
    // "Salt and pepper to taste" has no amount, and inventing one would put
    // calories into the recipe that nobody put into the pan.
    return { grams: null, source: SOURCES.unknown, reason: 'no amount given' };
  }

  if (unit && MASS_IN_GRAMS[unit]) return grams(quantity * MASS_IN_GRAMS[unit], SOURCES.stated);

  // A volume in millilitres: use the food's density where it's known.
  if (unit && VOLUME_IN_ML[unit] && ['ml', 'l', 'fl oz'].includes(unit)) {
    const density = densityFrom(servings);
    const ml = quantity * VOLUME_IN_ML[unit];
    return density
      ? grams(ml * density, SOURCES.food)
      : grams(ml, SOURCES.generic); // water, near enough for liquids
  }

  // A household measure: the food's own portion first.
  const portion = portionFor(servings, unit, size);
  if (portion?.grams > 0) {
    const count = /^([\d.]+)/.exec(clean(portion.label));
    const per = portion.grams / (count ? Number(count[1]) || 1 : 1);
    return grams(quantity * per, SOURCES.food);
  }

  if (unit && VOLUME_IN_ML[unit]) {
    const density = densityFrom(servings);
    return grams(quantity * VOLUME_IN_ML[unit] * (density ?? 1), density ? SOURCES.food : SOURCES.generic);
  }
  if (unit && GENERIC_GRAMS[unit]) return grams(quantity * GENERIC_GRAMS[unit], SOURCES.generic);

  // A bare count — "2 onions", "3 eggs". Only the food can say what one weighs.
  const one = portionFor(servings, null, size ?? 'medium') ?? portionFor(servings, null, 'large');
  if (one?.grams > 0) return grams(quantity * one.grams, SOURCES.food);

  return {
    grams: null,
    source: SOURCES.unknown,
    reason: unit ? `no weight for ${quantity} ${unit}` : `no weight for ${quantity} × ${name}`,
  };
}
