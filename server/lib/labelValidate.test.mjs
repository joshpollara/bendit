import { describe, expect, it } from 'vitest';
import { atwaterRange, validateLabel } from './labelValidate.mjs';

// The fixtures are real labels, transcribed from the packet. A validator is
// only worth having if it passes the awkward true ones and fails the wrong
// ones, so both are here.

const fieldsOf = (result) => result.issues.map((i) => i.field);
const messages = (result) => result.issues.map((i) => i.message).join(' | ');

describe('labels that are correct and must not be flagged', () => {
  it('accepts an ordinary US panel', () => {
    const result = validateLabel({
      basis: 'g',
      servingGrams: 40,
      perServing: { calories: 150, protein: 5, carbs: 27, fat: 3, fiber: 4, sugar: 1, satFat: 0.5 },
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('accepts a Dutch per-100g panel with a portion column beside it', () => {
    const result = validateLabel({
      basis: 'g',
      servingGrams: 30,
      per100: { calories: 375, protein: 12.5, carbs: 67.5, fat: 7.5, fiber: 10 },
      perServing: { calories: 113, protein: 3.8, carbs: 20.3, fat: 2.3, fiber: 3 },
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('accepts wheat bran, where fibre makes a plain 4/4/9 sum wrong', () => {
    // 216 kcal stated, against 320 counting fibre at 4 and 274 counting it at
    // 2. The published figure is right; the naive sum is what is wrong.
    const result = validateLabel({
      basis: 'g',
      per100: { calories: 216, protein: 15.6, carbs: 64.5, fat: 4.3, fiber: 42.8 },
    });
    expect(result.ok).toBe(true);
    expect(messages(result)).not.toMatch(/doesn't match/);
  });

  it('accepts cinnamon, which is mostly fibre', () => {
    // The kind of row that made a naive check flag a correct USDA entry.
    const result = validateLabel({
      basis: 'g',
      per100: { calories: 247, protein: 4, carbs: 80.6, fat: 1.2, fiber: 53.1 },
    });
    expect(result.ok).toBe(true);
    expect(messages(result)).not.toMatch(/doesn't match/);
  });

  it('accepts white wine, whose calories are alcohol', () => {
    // 82 kcal against macros worth 10. Alcohol is in no macro column.
    const result = validateLabel({
      basis: 'ml',
      per100: { calories: 82, protein: 0.07, carbs: 2.6, fat: 0, alcohol: 10.1 },
    });
    expect(result.ok).toBe(true);
    expect(messages(result)).not.toMatch(/doesn't match/);
  });

  it('accepts a label giving only kJ', () => {
    const result = validateLabel({
      basis: 'g',
      per100: { calories: null, energyKj: 1569, protein: 12.5, carbs: 67.5, fat: 7.5 },
    });
    expect(result.ok).toBe(true);
    expect(fieldsOf(result)).toEqual([]);
  });

  it('accepts olive oil at the top of the range', () => {
    const result = validateLabel({
      basis: 'g',
      per100: { calories: 884, protein: 0, carbs: 0, fat: 100 },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a diet drink where rounding dominates', () => {
    // Small numbers: 2 kcal against macros worth 1.2. A percentage tolerance
    // alone would reject this.
    const result = validateLabel({
      basis: 'ml',
      per100: { calories: 2, protein: 0, carbs: 0.3, fat: 0 },
    });
    expect(result.ok).toBe(true);
  });
});

describe('labels that were misread and must be flagged', () => {
  it('catches a misread calorie figure and says which field', () => {
    // 550 stated where the macros come to about 150 — a leading digit invented.
    const result = validateLabel({
      basis: 'g',
      perServing: { calories: 550, protein: 5, carbs: 27, fat: 3 },
    });
    expect(fieldsOf(result)).toContain('perServing.calories');
    expect(messages(result)).toMatch(/155 kcal/); // what the macros come to
  });

  it('catches a decimal point lost from a macro', () => {
    // Fat read as 30 rather than 3.0.
    const result = validateLabel({
      basis: 'g',
      perServing: { calories: 150, protein: 5, carbs: 27, fat: 30 },
    });
    expect(fieldsOf(result)).toContain('perServing.calories');
  });

  it('catches more than 100 g of something in 100 g of food', () => {
    const result = validateLabel({ basis: 'g', per100: { calories: 400, protein: 250, carbs: 10, fat: 5 } });
    expect(result.ok).toBe(false);
    expect(fieldsOf(result)).toContain('per100.protein');
  });

  it('catches macros that add up to more than the food weighs', () => {
    const result = validateLabel({ basis: 'g', per100: { calories: 600, protein: 40, carbs: 40, fat: 40 } });
    expect(result.ok).toBe(false);
    expect(messages(result)).toMatch(/add up to 120 g/);
  });

  it('catches energy above pure fat', () => {
    const result = validateLabel({ basis: 'g', per100: { calories: 1000, protein: 0, carbs: 0, fat: 50 } });
    expect(result.ok).toBe(false);
    expect(fieldsOf(result)).toContain('per100.calories');
  });

  it('catches saturated fat exceeding total fat', () => {
    const result = validateLabel({
      basis: 'g',
      per100: { calories: 400, protein: 5, carbs: 40, fat: 20, satFat: 35 },
    });
    expect(fieldsOf(result)).toContain('per100.satFat');
  });

  it('catches sugars exceeding carbohydrate', () => {
    const result = validateLabel({
      basis: 'g',
      per100: { calories: 400, protein: 5, carbs: 40, fat: 20, sugar: 60 },
    });
    expect(fieldsOf(result)).toContain('per100.sugar');
  });

  it('catches two columns that disagree with the portion weight', () => {
    // Per-portion column read from the wrong row: 375 is the per-100 figure.
    const result = validateLabel({
      basis: 'g',
      servingGrams: 30,
      per100: { calories: 375, protein: 12.5, carbs: 67.5, fat: 7.5 },
      perServing: { calories: 375, protein: 12.5, carbs: 67.5, fat: 7.5 },
    });
    expect(fieldsOf(result)).toContain('perServing.calories');
    expect(messages(result)).toMatch(/112\.5/); // what 30 g should have been
  });

  it('catches salt and sodium that disagree', () => {
    const result = validateLabel({
      basis: 'g',
      per100: { calories: 400, protein: 5, carbs: 40, fat: 20, sodiumMg: 40, saltG: 2.5 },
    });
    expect(fieldsOf(result)).toContain('per100.sodiumMg');
  });

  it('catches an impossible portion weight', () => {
    const result = validateLabel({
      basis: 'g',
      servingGrams: 9000,
      perServing: { calories: 150, protein: 5, carbs: 27, fat: 3 },
    });
    expect(result.ok).toBe(false);
    expect(fieldsOf(result)).toContain('servingGrams');
  });

  it('refuses a reading with no numbers at all', () => {
    expect(validateLabel({ basis: 'g' }).ok).toBe(false);
    expect(validateLabel({}).ok).toBe(false);
  });

  it('flags a reading with macros but no calories', () => {
    const result = validateLabel({ basis: 'g', per100: { protein: 5, carbs: 27, fat: 3 } });
    expect(result.ok).toBe(false);
    expect(fieldsOf(result)).toContain('calories');
  });

  it('puts the serious problems first', () => {
    const result = validateLabel({
      basis: 'g',
      per100: { calories: 400, protein: 250, carbs: 40, fat: 20, satFat: 35 },
    });
    expect(result.issues[0].severity).toBe('error');
  });
});

describe('atwaterRange', () => {
  it('spans both labelling conventions', () => {
    const { low, high } = atwaterRange({ protein: 10, carbs: 60, fat: 5, fiber: 30 });
    // US reading: fibre is inside the 60 g of carbohydrate and yields nothing.
    expect(Math.round(low)).toBe(205);
    // EU reading: the 60 g excludes fibre, which adds 2 kcal/g on top.
    expect(Math.round(high)).toBe(385);
  });

  it('accepts a European label listing more fibre than carbohydrate', () => {
    // Pumpkin seeds: 3 g carbohydrate, 6 g fibre, and that is what the bag says.
    const seeds = { calories: 559, protein: 30, carbs: 3, fat: 49, fiber: 6 };
    const result = validateLabel({ basis: 'g', per100: seeds });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('collapses to a single figure when there is no fibre', () => {
    const { low, high } = atwaterRange({ protein: 10, carbs: 20, fat: 5 });
    expect(low).toBe(high);
    expect(low).toBe(165);
  });

  it('counts alcohol, which belongs to no macro', () => {
    expect(atwaterRange({ alcohol: 10 }).low).toBe(70);
  });

  it('treats missing values as zero rather than failing', () => {
    expect(atwaterRange({}).low).toBe(0);
    expect(atwaterRange().low).toBe(0);
  });
});
