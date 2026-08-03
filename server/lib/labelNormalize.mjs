// A read label becomes a food.
//
// The awkward part is that labels are printed two ways and the app stores one.
// Dutch packaging leads with per 100 g, which is not how anyone eats; American
// packaging gives a portion, which is not a basis you can rescale from without
// knowing its weight. Both are turned into per-100 values plus a list of
// servings, which is the canonical shape the rest of the app already uses.
//
// Nothing is invented. If a portion's weight isn't printed, no per-100 figure
// is derived from it — a guessed weight would silently corrupt every gram-based
// number downstream.

import { kjToKcal, makeFood } from './foodSchema.mjs';

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The label's field names to the canonical per-100 ones. */
const FIELD_MAP = {
  calories: 'kcal100',
  protein: 'protein100',
  carbs: 'carbs100',
  fat: 'fat100',
  fiber: 'fiber100',
  sugar: 'sugar100',
  satFat: 'satFat100',
};

/** Salt is the same fact as sodium; either can be the one printed. */
function sodiumMg(nutrients) {
  const sodium = num(nutrients.sodiumMg);
  if (sodium != null) return sodium;
  const salt = num(nutrients.saltG);
  return salt == null ? null : Math.round(salt * 400);
}

/** One column of a label, scaled to 100 g/ml. `grams` is what the column covers. */
function columnPer100(nutrients, grams) {
  if (!nutrients || !grams) return null;
  const factor = 100 / grams;
  const out = {};
  for (const [from, to] of Object.entries(FIELD_MAP)) {
    const value = num(nutrients[from]);
    out[to] = value == null ? null : value * factor;
  }
  // Energy in kJ is the only figure on many European labels.
  if (out.kcal100 == null) {
    const kj = num(nutrients.energyKj);
    if (kj != null) out.kcal100 = kjToKcal(kj) * factor;
  }
  const sodium = sodiumMg(nutrients);
  out.sodiumMg100 = sodium == null ? null : sodium * factor;
  return out;
}

/**
 * Turns an extracted label into a draft food.
 *
 * Returns null when there is nothing to build from — no usable column, or a
 * portion-only label whose portion has no stated weight, which can't be
 * converted to a per-100 basis without inventing the weight.
 */
export function normalizeLabel(label = {}, { id, source = 'custom', barcode = null } = {}) {
  const basis = label.basis === 'ml' ? 'ml' : 'g';
  const servingGrams = num(label.servingGrams);

  // The per-100 column is already on the canonical basis. Failing that, a
  // portion column can be converted, but only with a stated weight.
  const per100 =
    columnPer100(label.per100, 100) ??
    (servingGrams ? columnPer100(label.perServing, servingGrams) : null);
  if (!per100 || per100.kcal100 == null) return null;

  // Servings, best first: the portion the label names, then the base unit.
  const servings = [];
  if (servingGrams) {
    const label100 = `100 ${basis}`;
    const named = (label.servingLabel ?? '').trim();
    servings.push({
      label: named && named !== label100 ? named : `${servingGrams} ${basis}`,
      grams: servingGrams,
    });
  }
  servings.push({ label: `100 ${basis}`, grams: 100 });

  // A whole packet is a serving people genuinely use — "I ate the bag".
  const perContainer = num(label.servingsPerContainer);
  if (servingGrams && perContainer && perContainer > 1 && perContainer <= 100) {
    const whole = Math.round(servingGrams * perContainer);
    if (whole <= 5000) servings.push({ label: `whole pack (${whole} ${basis})`, grams: whole });
  }

  return makeFood({
    id: id ?? `custom-${(label.name ?? 'food').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
    source,
    sourceId: null,
    name: (label.name ?? '').trim() || 'Scanned food',
    brand: (label.brand ?? '').trim() || null,
    barcode,
    basis,
    per100,
    servings,
  });
}
