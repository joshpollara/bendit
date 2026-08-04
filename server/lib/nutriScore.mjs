// Nutri-Score: the European front-of-pack grade, A to E.
//
// This is somebody else's published algorithm, not one invented here. That is
// the whole reason for choosing it: the number can be traced to a regulation
// and argued with, rather than being a weighting I made up and nobody can
// check. Zoe's score is proprietary and comes from their own cohort's blood
// and microbiome data — it cannot be reproduced, and a lookalike would be a
// guess wearing its authority.
//
// Points are counted against a food (energy, sugars, saturated fat, salt) and
// for it (fibre, protein, and the fruit/vegetable/nut share). The total maps to
// a letter.
//
// Two honest limits:
//
//   • The fruit/vegetable share is counted where a food states one. Nothing
//     imported carries it, so it is set on the curated foods and absent
//     elsewhere — which under-grades whole fruit and veg by about a letter.
//     Where a product publishes its own grade, that one is used instead.
//   • Fats and oils have their own table in the official system, which this
//     doesn't implement: olive oil computes as E where the official grade is C.
//     Published grades cover branded oils; a curated one reads worse than it
//     should.

/** Points from a threshold table: the first band the value falls in. */
const points = (value, thresholds) => {
  for (let i = 0; i < thresholds.length; i++) if (value <= thresholds[i]) return i;
  return thresholds.length;
};

// Energy in kJ per 100 g.
const ENERGY = [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350];
const SUGARS = [4.5, 9, 13.5, 18, 22.5, 27, 31, 36, 40, 45];
const SAT_FAT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const SODIUM_MG = [90, 180, 270, 360, 450, 540, 630, 720, 810, 900];

// The fruit, vegetable and nut share, in percent. The bands are 0, 1, 2 and 5:
// the jump at the top is what makes a whole fruit an A.
const FRUIT_VEG = [40, 60, 80];
const FIBRE = [0.9, 1.9, 2.8, 3.7, 4.7];
const PROTEIN = [1.6, 3.2, 4.8, 6.4, 8];

// Drinks are scored on their own, far stricter tables — a cola is nothing like
// a food of the same energy. Without these it graded B, where the official
// grade is E, which is the sort of wrong that would make the whole thing worth
// ignoring.
const DRINK_ENERGY = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270];
const DRINK_SUGARS = [0.5, 2, 3.5, 5, 6.5, 8, 9, 10, 11, 12];

const KJ_PER_KCAL = 4.184;

/** A to E, from the total. Drinks are banded far more tightly than food. */
export function gradeFor(score, beverage = false) {
  if (beverage) {
    if (score <= 2) return 'B'; // only water itself is an A
    if (score <= 6) return 'C';
    if (score <= 9) return 'D';
    return 'E';
  }
  if (score <= -1) return 'A';
  if (score <= 2) return 'B';
  if (score <= 10) return 'C';
  if (score <= 18) return 'D';
  return 'E';
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The grade for a food, from its per-100g figures, or null when too little is
 * known to compute one honestly.
 *
 * Energy, sugars, saturated fat and salt are all needed: a food missing any of
 * them would score better than it deserves simply for having no data.
 */
export function nutriScore(per100, { beverage = per100?.basis === 'ml' } = {}) {
  const kcal = num(per100?.kcal100);
  const sugar = num(per100?.sugar100);
  const satFat = num(per100?.satFat100);
  const sodium = num(per100?.sodiumMg100);
  if (kcal == null || sugar == null || satFat == null || sodium == null) return null;

  const kj = kcal * KJ_PER_KCAL;
  const negative =
    points(kj, beverage ? DRINK_ENERGY : ENERGY) +
    points(sugar, beverage ? DRINK_SUGARS : SUGARS) +
    points(satFat, SAT_FAT) +
    points(sodium, SODIUM_MG);

  // Water is the only drink the system grades A, by name rather than by score.
  if (beverage && kj === 0 && sugar === 0) return { score: 0, grade: 'A', computed: true };

  const fibrePoints = points(num(per100?.fiber100) ?? 0, FIBRE);
  const proteinPoints = points(num(per100?.protein100) ?? 0, PROTEIN);
  // Above 80% the award jumps from 2 to 5, on both scales.
  const share = num(per100?.fruitVeg) ?? 0;
  const fruitPoints = share > 80 ? 5 : points(share, FRUIT_VEG);

  // Protein stops counting in its favour once a food is this far into the
  // negative — otherwise cured meat and hard cheese score like a salad. A food
  // that is mostly fruit or vegetable keeps it.
  const positive =
    negative >= 11 && fruitPoints < 5
      ? fibrePoints + fruitPoints
      : fibrePoints + proteinPoints + fruitPoints;

  const score = negative - positive;
  return { score, grade: gradeFor(score, beverage), computed: true };
}

/** The order of the grades, worst last, for averaging and comparing. */
const GRADE_VALUE = { A: 1, B: 2, C: 3, D: 4, E: 5 };
const VALUE_GRADE = ['A', 'B', 'C', 'D', 'E'];

/**
 * One grade for several foods, weighted by how much of each was eaten.
 *
 * A meal is not a food, and no regulation says how to grade one. Weighting by
 * grams is the least arbitrary choice available: 200 g of rice should count for
 * more than a 5 g clove of garlic. Foods with no grade are left out rather than
 * counted as average, and how much of the meal was gradeable is reported so a
 * grade resting on a quarter of the plate can be recognised as such.
 */
export function gradeMeal(items) {
  const graded = (items ?? []).filter((i) => i?.grade && GRADE_VALUE[i.grade] && i.grams > 0);
  if (graded.length === 0) return null;

  const totalGrams = graded.reduce((sum, i) => sum + i.grams, 0);
  const allGrams = (items ?? []).reduce((sum, i) => sum + (i?.grams > 0 ? i.grams : 0), 0);
  const weighted = graded.reduce((sum, i) => sum + GRADE_VALUE[i.grade] * i.grams, 0) / totalGrams;

  return {
    grade: VALUE_GRADE[Math.round(weighted) - 1],
    /** 0–1: how much of the meal's weight carried a grade at all. */
    covered: allGrams > 0 ? totalGrams / allGrams : 0,
  };
}

/** NOVA 1–4: how processed, on the published classification. */
export const NOVA_LABEL = {
  1: 'unprocessed',
  2: 'culinary ingredient',
  3: 'processed',
  4: 'ultra-processed',
};

/**
 * The processing group for a meal: the worst thing in it, by weight.
 *
 * An average would say a plate of vegetables with a stock cube is "lightly
 * processed", which misses the point of the classification. What matters is
 * how much of what you ate was ultra-processed, so that share is reported too.
 */
export function processingForMeal(items) {
  const known = (items ?? []).filter((i) => i?.nova >= 1 && i?.nova <= 4 && i.grams > 0);
  if (known.length === 0) return null;

  const totalGrams = known.reduce((sum, i) => sum + i.grams, 0);
  const ultraGrams = known.filter((i) => i.nova === 4).reduce((sum, i) => sum + i.grams, 0);

  return {
    worst: Math.max(...known.map((i) => i.nova)),
    ultraShare: totalGrams > 0 ? ultraGrams / totalGrams : 0,
  };
}
