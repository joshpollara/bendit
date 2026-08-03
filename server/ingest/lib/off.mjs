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
 * Sanity limits. Nothing edible has 1000 kcal per 100 g (pure fat is ~900), and
 * no macro can exceed 100 g per 100 g. Rows outside these are data-entry
 * errors, of which OFF has plenty.
 */
export function isPlausible(per100) {
  if (per100.kcal100 == null || per100.kcal100 <= 0 || per100.kcal100 > 1000) return false;
  for (const key of ['protein100', 'carbs100', 'fat100', 'fiber100', 'sugar100', 'satFat100']) {
    const value = per100[key];
    if (value != null && (value < 0 || value > 100)) return false;
  }
  const macros = (per100.protein100 ?? 0) + (per100.carbs100 ?? 0) + (per100.fat100 ?? 0);
  return macros <= 105; // a little slack for rounding and water content
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
  });
}
