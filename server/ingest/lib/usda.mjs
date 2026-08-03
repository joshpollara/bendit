import { makeFood } from '../../lib/foodSchema.mjs';
import { kjToKcal } from '../../lib/foodSchema.mjs';
import { number } from './csv.mjs';

// USDA FoodData Central → canonical records.
//
// FDC publishes nutrition per 100 g already, which is the canonical basis, so
// no conversion is needed — the work is joining four tables and picking the
// right energy row.
//
// Nutrients carry two identifiers and they are not interchangeable:
// nutrient.csv row 2047 is "Energy (Atwater General Factors)" with
// nutrient_nbr 957. The familiar 1008/1003/1004 numbers are the `id` column;
// nutrient_nbr is the older INFOODS tag (208 energy, 203 protein). Releases
// differ in which they populate, so both tables are consulted — matching on
// the wrong one silently drops every nutrient and therefore every food.

/** By FDC nutrient id. */
export const NUTRIENT_IDS = {
  1008: 'kcal100', // Energy (kcal)
  1003: 'protein100',
  1005: 'carbs100', // Carbohydrate, by difference
  1004: 'fat100', // Total lipid (fat)
  1079: 'fiber100',
  2000: 'sugar100', // Sugars, total including NLEA
  1258: 'satFat100', // Fatty acids, total saturated
  1093: 'sodiumMg100', // Sodium, Na (mg)
};

/** By legacy INFOODS tag number, for releases that only carry those. */
export const NUTRIENT_NBRS = {
  208: 'kcal100',
  203: 'protein100',
  205: 'carbs100',
  204: 'fat100',
  291: 'fiber100',
  269: 'sugar100',
  606: 'satFat100',
  307: 'sodiumMg100',
};

const ENERGY_KJ = new Set([1062, 268]);
// Atwater-derived energy: used only when a stated kcal row is absent.
const ENERGY_ATWATER = new Set([2047, 2048, 957, 958]);

/** id → legacy nutrient_nbr, read from nutrient.csv rather than assumed. */
export function buildNutrientMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = number(row.id);
    const nbr = number(row.nutrient_nbr);
    if (id != null && nbr != null) map.set(id, nbr);
  }
  return map;
}

/** The canonical field for a nutrient, by whichever identifier resolves. */
function fieldFor(id, nbr) {
  return NUTRIENT_IDS[id] ?? (nbr == null ? undefined : NUTRIENT_NBRS[nbr]);
}

/**
 * Folds food_nutrient rows into per-food nutrition. Energy is resolved in
 * order of preference: stated kcal, then Atwater kcal, then kJ converted —
 * so a food is never left without calories when the data has them.
 */
export function collectNutrition(rows, nutrientMap) {
  const byFood = new Map();
  for (const row of rows) {
    const fdcId = row.fdc_id;
    const amount = number(row.amount);
    if (!fdcId || amount == null) continue;

    const id = number(row.nutrient_id);
    const nbr = nutrientMap.get(id) ?? null;
    const field = fieldFor(id, nbr);
    const isKj = ENERGY_KJ.has(id) || (nbr != null && ENERGY_KJ.has(nbr));
    const isAtwater = ENERGY_ATWATER.has(id) || (nbr != null && ENERGY_ATWATER.has(nbr));
    if (!field && !isKj && !isAtwater) continue;

    let entry = byFood.get(fdcId);
    if (!entry) {
      entry = {};
      byFood.set(fdcId, entry);
    }
    if (field) {
      entry[field] = amount;
    } else if (isKj) {
      entry._kj = amount;
    } else {
      entry._atwater = amount;
    }
  }

  for (const entry of byFood.values()) {
    if (entry.kcal100 == null) entry.kcal100 = entry._atwater ?? kjToKcal(entry._kj) ?? null;
    delete entry._kj;
    delete entry._atwater;
  }
  return byFood;
}

/**
 * Serving definitions from food_portion.csv. "1 cup (240g)" reads better than
 * "240 g" and is how the correction UI will offer adjustments.
 */
export function collectPortions(rows, measureUnits = new Map()) {
  const byFood = new Map();
  for (const row of rows) {
    const grams = number(row.gram_weight);
    if (!row.fdc_id || !grams || grams <= 0) continue;

    const amount = number(row.amount);
    const unit = measureUnits.get(number(row.measure_unit_id)) ?? '';
    const described = [row.portion_description, row.modifier].find((v) => v && v !== 'undetermined');
    // "1 cup", "1 medium", or whatever text the row carries.
    const noun = unit && unit !== 'undetermined' ? unit : (described ?? '').trim();
    if (!noun) continue;

    const label = amount && amount !== 1 ? `${amount} ${noun}` : `1 ${noun}`;
    const list = byFood.get(row.fdc_id) ?? [];
    list.push({ label: `${label} (${Math.round(grams)}g)`, grams });
    byFood.set(row.fdc_id, list);
  }
  return byFood;
}

/** Names read better with the qualifiers after the food, as FDC writes them. */
function tidyName(description) {
  return description.replace(/\s+/g, ' ').trim();
}

/** Data types that represent a food a person can log. */
export const LOGGABLE_TYPES = new Set(['foundation_food', 'sr_legacy_food', 'survey_fndds_food']);

/** Combines the four tables into canonical records. */
export function buildFoods({ foods, nutrition, portions }) {
  const out = [];
  for (const row of foods) {
    // Foundation ships lab sample rows alongside real foods; they duplicate
    // products under names like "HUMMUS, SABRA CLASSIC" and shouldn't be logged.
    if (row.data_type && !LOGGABLE_TYPES.has(row.data_type)) continue;
    const fdcId = row.fdc_id;
    const per100 = nutrition.get(fdcId);
    // No nutrition means nothing can be computed from it; skip rather than
    // store a row that would match a search and then contribute zeros.
    if (!per100 || per100.kcal100 == null) continue;

    const servings = (portions.get(fdcId) ?? []).slice(0, 6);
    servings.push({ label: '100 g', grams: 100 });

    out.push(
      makeFood({
        id: `usda-${fdcId}`,
        source: 'usda',
        sourceId: fdcId,
        name: tidyName(row.description ?? ''),
        per100,
        servings,
      }),
    );
  }
  return out;
}
