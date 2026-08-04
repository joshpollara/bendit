import { makeFood, kjToKcal } from '../../lib/foodSchema.mjs';
import { number } from './csv.mjs';

// Open Food Facts → canonical records.
//
// OFF is crowd-sourced, which shows: fields are missing, units vary, and some
// rows carry values that can't be true. The importer is therefore strict —
// a row that can't be trusted is dropped rather than stored, because a wrong
// number that matches a barcode is worse than no match at all.
//
// Data © Open Food Facts contributors, ODbL. Attribution is surfaced in the app.

/** Products sold where the user shops. Global OFF is ~9GB; this is ~2% of it. */
export const DEFAULT_COUNTRIES = ['netherlands', 'belgium', 'germany'];

const field = (row, ...names) => {
  for (const name of names) {
    const value = row[name];
    if (value != null && value !== '') return value;
  }
  return null;
};

/** OFF stores sodium and salt in grams; the canonical field is milligrams. */
function sodiumMg(row) {
  const sodium = number(field(row, 'sodium_100g'));
  if (sodium != null) return sodium * 1000;
  const salt = number(field(row, 'salt_100g'));
  return salt == null ? null : salt * 400; // salt → sodium, 1g salt ≈ 400mg Na
}

/**
 * Energy the macros can actually account for: protein and carbohydrate at 4
 * kcal/g, fat at 9, alcohol at 7. Fiber is inside the carbohydrate figure and
 * yields nearer 2 kcal/g than 4, so this runs high rather than low — which is
 * what makes it safe to use as a ceiling.
 */
export function atwaterEnergy(per100) {
  return (
    4 * (per100.protein100 ?? 0) +
    4 * (per100.carbs100 ?? 0) +
    9 * (per100.fat100 ?? 0) +
    7 * (per100.alcohol100 ?? 0)
  );
}

/**
 * Sanity limits. OFF is crowd-sourced, and a fair number of rows have a kJ
 * figure typed into the kcal field or a decimal point in the wrong place.
 *
 * Three checks, cheapest first: nothing edible exceeds pure fat at 900 kcal per
 * 100 g; no macro exceeds the weight of the food; and stated energy can't be
 * far above what the macros could produce. The last one is deliberately loose —
 * polyols, glycerol and rounding all push real labels a little over — so it
 * only catches the gross errors ("1000 kcal" against macros worth 115).
 */
export function isPlausible(per100) {
  if (per100.kcal100 == null || per100.kcal100 <= 0 || per100.kcal100 > 900) return false;
  for (const key of ['protein100', 'carbs100', 'fat100', 'fiber100', 'sugar100', 'satFat100']) {
    const value = per100[key];
    if (value != null && (value < 0 || value > 100)) return false;
  }
  const macros = (per100.protein100 ?? 0) + (per100.carbs100 ?? 0) + (per100.fat100 ?? 0);
  if (macros > 105) return false; // a little slack for rounding and water content

  // Only checkable when the macros are actually published; most rows have them.
  const stated = per100.kcal100;
  if (per100.protein100 == null || per100.carbs100 == null || per100.fat100 == null) return true;
  return stated <= atwaterEnergy(per100) * 1.4 + 60;
}

/** Does this product belong to the countries we're importing? */
export function matchesCountries(row, countries) {
  if (countries.length === 0) return true;
  const tags = (field(row, 'countries_tags', 'countries_en', 'countries') ?? '').toLowerCase();
  return countries.some((country) => tags.includes(country));
}

/**
 * One OFF export row → a canonical record, or null when the row can't support
 * one. Liquids are marked `ml` so a "100 ml" basis isn't silently treated as
 * grams later.
 */
export function toFood(row) {
  const grade = String(field(row, 'nutriscore_grade') ?? '').trim().toUpperCase();
  const nova = number(field(row, 'nova_group'));

  const barcode = String(field(row, 'code') ?? '').trim();
  const name = (field(row, 'product_name') ?? '').trim();
  if (!barcode || !name || name.length > 200) return null;

  const kcal = number(field(row, 'energy-kcal_100g'));
  const kj = number(field(row, 'energy-kj_100g', 'energy_100g'));
  const per100 = {
    kcal100: kcal ?? kjToKcal(kj),
    protein100: number(field(row, 'proteins_100g')),
    carbs100: number(field(row, 'carbohydrates_100g')),
    fat100: number(field(row, 'fat_100g')),
    fiber100: number(field(row, 'fiber_100g')),
    sugar100: number(field(row, 'sugars_100g')),
    satFat100: number(field(row, 'saturated-fat_100g')),
    sodiumMg100: sodiumMg(row),
    // Not stored — the canonical schema has no alcohol field — but a drink's
    // calories come mostly from it, so the plausibility check needs it.
    alcohol100: number(field(row, 'alcohol_100g')),
  };
  if (!isPlausible(per100)) return null;

  const servingGrams = number(field(row, 'serving_quantity'));
  const servingLabel = (field(row, 'serving_size') ?? '').trim();
  const basis = /\b(ml|l|liter|litre)\b/i.test(servingLabel) ? 'ml' : 'g';

  const servings = [];
  if (servingGrams && servingGrams > 0 && servingGrams < 2000) {
    servings.push({ label: servingLabel || `${servingGrams} ${basis}`, grams: servingGrams });
  }
  servings.push({ label: `100 ${basis}`, grams: 100 });

  return makeFood({
    id: `off-${barcode}`,
    source: 'openfoodfacts',
    sourceId: barcode,
    name,
    brand: (field(row, 'brands') ?? '').split(',')[0]?.trim() || null,
    barcode,
    basis,
    per100,
    servings,
    // Published by Open Food Facts rather than worked out here: their grade
    // accounts for the fruit and vegetable share, which no column in this
    // database carries.
    nutriGrade: /^[A-E]$/.test(grade) ? grade : null,
    nova: nova >= 1 && nova <= 4 ? nova : null,
  });
}
