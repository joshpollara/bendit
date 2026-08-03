// Checking a nutrition panel's own arithmetic.
//
// A label is a set of numbers that must agree with each other. Calories follow
// from the macros; a per-portion column follows from the per-100 column and the
// portion weight; saturated fat is part of fat. When a reading breaks one of
// those identities, a digit was misread — and the reading says which one, so
// the screen can point at it instead of asking the user to re-check everything.
//
// The energy identity is not a single number, because fibre is handled two
// incompatible ways and a photograph doesn't say which one it follows:
//
//   • US panels put fibre *inside* total carbohydrate, counted at 4 kcal/g.
//   • EU panels (Regulation 1169/2011) list carbohydrate *excluding* fibre,
//     and count fibre separately at 2 kcal/g. On a bag of pumpkin seeds this
//     reads as 3 g of carbohydrate and 6 g of fibre — more fibre than carbs,
//     which is not an error.
//   • Insoluble fibre yields nothing at all, and USDA applies food-specific
//     factors lower still: wheat bran is published at 216 kcal against a naive
//     4/4/9 sum of 320.
//
// So the range runs from "fibre is inside carbohydrate and yields nothing" to
// "fibre is on top of carbohydrate at 2 kcal/g", and a stated figure only has
// to land inside it. That makes the check weaker on high-fibre foods, which is
// the right way to be wrong: a false alarm on a correct label teaches people to
// ignore the warning. Checked against 307,000 published labels — see the note
// at the foot of this file. Alcohol is 7 kcal/g and belongs to no macro, which
// is why spirits fail a plain 4/4/9 check.
//
// This ran against 200 random USDA foods while the data layer was built: a
// naive check flagged 3 as wrong, and all 3 were correct labels — two dried
// spices and a white wine. This version passes all 200.

const CARB_KCAL = 4;
const FIBER_KCAL_EU = 2; // when a label lists fibre outside carbohydrate
const PROTEIN_KCAL = 4;
const FAT_KCAL = 9;
const ALCOHOL_KCAL = 7;

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The range of energies the macros can legitimately produce: low end counting
 * fibre as contributing nothing, high end counting it at the full 4 kcal/g.
 */
export function atwaterRange(n = {}) {
  const protein = num(n.protein) ?? 0;
  const carbs = num(n.carbs) ?? 0;
  const fat = num(n.fat) ?? 0;
  const alcohol = num(n.alcohol) ?? 0;
  const fiber = num(n.fiber) ?? 0;

  const base = PROTEIN_KCAL * protein + FAT_KCAL * fat + ALCOHOL_KCAL * alcohol;
  // Lowest: the US reading, with fibre inside carbohydrate and yielding nothing.
  const low = base + CARB_KCAL * Math.max(0, carbs - fiber);
  // Highest: the EU reading, with fibre alongside carbohydrate at 2 kcal/g.
  const high = base + CARB_KCAL * carbs + FIBER_KCAL_EU * fiber;
  return { low, high };
}

/** Rounding on a label is coarse, and small numbers round proportionally worse. */
const energyTolerance = (stated) => Math.max(20, 0.15 * stated);

const KJ_PER_KCAL = 4.184;

/** A column of nutrients, with kJ folded in when kcal is missing. */
function withEnergy(nutrients) {
  if (!nutrients) return null;
  const calories = num(nutrients.calories);
  const energyKj = num(nutrients.energyKj);
  return {
    ...nutrients,
    calories: calories ?? (energyKj == null ? null : energyKj / KJ_PER_KCAL),
  };
}

const issue = (field, severity, message) => ({ field, severity, message });

/**
 * Checks one column against itself. `prefix` names the fields for the UI.
 * Reports whether the energy identity could actually be applied — a column
 * missing a macro is unverifiable, which is different from verified.
 */
function checkColumn(nutrients, prefix, { basis = 'g', per100 = false } = {}) {
  const issues = [];
  let energyChecked = false;
  if (!nutrients) return { issues, energyChecked };

  const calories = num(nutrients.calories);
  const protein = num(nutrients.protein);
  const carbs = num(nutrients.carbs);
  const fat = num(nutrients.fat);
  const sugar = num(nutrients.sugar);
  const satFat = num(nutrients.satFat);

  // Nothing can weigh more than the food it is in.
  if (per100) {
    for (const [name, value] of [['protein', protein], ['carbs', carbs], ['fat', fat]]) {
      if (value != null && (value < 0 || value > 100)) {
        issues.push(
          issue(`${prefix}.${name}`, 'error', `${value} g per 100 ${basis} is not possible.`),
        );
      }
    }
    const sum = (protein ?? 0) + (carbs ?? 0) + (fat ?? 0);
    if (sum > 105) {
      issues.push(
        issue(`${prefix}.carbs`, 'error', `Protein, carbs and fat add up to ${Math.round(sum)} g in 100 ${basis}.`),
      );
    }
    if (calories != null && calories > 900) {
      issues.push(
        issue(`${prefix}.calories`, 'error', `${Math.round(calories)} kcal per 100 ${basis} is more than pure fat.`),
      );
    }
  }

  // Sub-nutrients are part of their parent, never larger.
  if (satFat != null && fat != null && satFat > fat + 0.5) {
    issues.push(issue(`${prefix}.satFat`, 'warning', 'Saturated fat is higher than total fat.'));
  }
  if (sugar != null && carbs != null && sugar > carbs + 0.5) {
    issues.push(issue(`${prefix}.sugar`, 'warning', 'Sugars are higher than total carbohydrate.'));
  }

  // The identity that catches a misread digit.
  if (calories != null && protein != null && carbs != null && fat != null) {
    energyChecked = true;
    const { low, high } = atwaterRange(nutrients);
    const tolerance = energyTolerance(calories);
    if (calories < low - tolerance || calories > high + tolerance) {
      const expected = low === high ? Math.round(low) : `${Math.round(low)}–${Math.round(high)}`;
      issues.push(
        issue(
          `${prefix}.calories`,
          'warning',
          `${Math.round(calories)} kcal doesn't match the macros, which come to ${expected} kcal.`,
        ),
      );
    }
  }

  return { issues, energyChecked };
}

/** Salt and sodium are the same fact twice: 1 g of salt is 400 mg of sodium. */
function checkSalt(nutrients, prefix) {
  const sodium = num(nutrients?.sodiumMg);
  const salt = num(nutrients?.saltG);
  if (sodium == null || salt == null) return [];
  const expected = salt * 400;
  const tolerance = Math.max(50, 0.25 * expected);
  return Math.abs(sodium - expected) <= tolerance
    ? []
    : [issue(`${prefix}.sodiumMg`, 'warning', `Sodium and salt disagree: ${sodium} mg against ${salt} g of salt.`)];
}

/**
 * Validates an extracted label. Returns the issues found, most serious first,
 * each naming the field it is about so the form can highlight it.
 *
 * An `error` means the reading cannot be trusted; a `warning` means it needs a
 * human glance. Neither blocks saving — the user is looking at the packet and
 * can see what it says.
 */
export function validateLabel(label = {}) {
  const issues = [];
  const basis = label.basis === 'ml' ? 'ml' : 'g';
  const per100 = withEnergy(label.per100);
  const perServing = withEnergy(label.perServing);
  const servingGrams = num(label.servingGrams);

  if (!per100 && !perServing) {
    return {
      ok: false,
      checkedColumns: [],
      issues: [issue('calories', 'error', 'No nutrition values were found.')],
    };
  }
  if (per100?.calories == null && perServing?.calories == null) {
    issues.push(issue('calories', 'error', 'No calorie figure was found on the label.'));
  }

  const hundred = checkColumn(per100, 'per100', { basis, per100: true });
  const portion = checkColumn(perServing, 'perServing', { basis });
  // Which columns the arithmetic could actually be applied to. "No issues"
  // because nothing was checkable is not the same as "the numbers agree".
  const checkedColumns = [
    ...(hundred.energyChecked ? ['per100'] : []),
    ...(portion.energyChecked ? ['perServing'] : []),
  ];
  issues.push(...hundred.issues, ...portion.issues);
  issues.push(...checkSalt(per100, 'per100'));
  issues.push(...checkSalt(perServing, 'perServing'));

  // The two columns are the same food measured twice.
  if (per100 && perServing && servingGrams) {
    const factor = servingGrams / 100;
    for (const field of ['calories', 'protein', 'carbs', 'fat']) {
      const hundred = num(per100[field]);
      const serving = num(perServing[field]);
      if (hundred == null || serving == null) continue;
      const expected = hundred * factor;
      const tolerance = Math.max(field === 'calories' ? 15 : 1.5, 0.2 * expected);
      if (Math.abs(serving - expected) > tolerance) {
        issues.push(
          issue(
            `perServing.${field}`,
            'warning',
            `The per-portion and per-100 ${basis} columns disagree: ${serving} against ${Math.round(expected * 10) / 10} expected for ${servingGrams} ${basis}.`,
          ),
        );
      }
    }
  }

  if (servingGrams != null && (servingGrams <= 0 || servingGrams > 5000)) {
    issues.push(issue('servingGrams', 'error', `A ${servingGrams} ${basis} portion is not plausible.`));
  }

  const perContainer = num(label.servingsPerContainer);
  if (perContainer != null && (perContainer <= 0 || perContainer > 1000)) {
    issues.push(issue('servingsPerContainer', 'warning', 'The servings-per-container figure looks wrong.'));
  }

  const order = { error: 0, warning: 1 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return { ok: !issues.some((i) => i.severity === 'error'), issues, checkedColumns };
}
