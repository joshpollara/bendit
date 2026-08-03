import { describe, expect, it } from 'vitest';
import { normalizeLabel } from './labelNormalize.mjs';

describe('normalizeLabel', () => {
  it('keeps a per-100g column as it stands', () => {
    const food = normalizeLabel({
      name: 'Havermout',
      brand: 'Albert Heijn',
      basis: 'g',
      servingGrams: 40,
      servingLabel: '1 portie (40 g)',
      per100: { calories: 375, protein: 12.5, carbs: 67.5, fat: 7.5, fiber: 10 },
    });
    expect(food.kcal100).toBe(375);
    expect(food.protein100).toBe(12.5);
    expect(food.servings[0]).toEqual({ label: '1 portie (40 g)', grams: 40 });
    expect(food.servings.at(-1)).toEqual({ label: '100 g', grams: 100 });
  });

  it('logs the portion, not the 100 g, when the label names one', () => {
    // The whole point for European packaging: 100 g is not a serving.
    const food = normalizeLabel({
      basis: 'g',
      servingGrams: 40,
      servingLabel: '1 portie (40 g)',
      per100: { calories: 375, protein: 12.5, carbs: 67.5, fat: 7.5 },
    });
    expect(food.servingLabel).toBe('1 portie (40 g)');
    expect(food.caloriesPerServing).toBe(150); // 375 × 0.4
  });

  it('converts an American per-serving panel to the canonical basis', () => {
    const food = normalizeLabel({
      name: 'Rolled Oats',
      basis: 'g',
      servingGrams: 40,
      servingLabel: '1/2 cup dry (40g)',
      perServing: { calories: 150, protein: 5, carbs: 27, fat: 3 },
    });
    expect(food.kcal100).toBe(375);
    expect(food.protein100).toBe(12.5);
    expect(food.caloriesPerServing).toBe(150);
  });

  it('prefers the per-100 column when both are printed', () => {
    // It carries more significant figures than a rounded portion column.
    const food = normalizeLabel({
      basis: 'g',
      servingGrams: 30,
      per100: { calories: 375, protein: 12.5, carbs: 67.5, fat: 7.5 },
      perServing: { calories: 113, protein: 3.8, carbs: 20.3, fat: 2.3 },
    });
    expect(food.kcal100).toBe(375);
  });

  it('refuses a portion-only label with no stated weight', () => {
    // Deriving per-100 would mean inventing the weight of "1 bar", and every
    // gram-based number after that would inherit the invention.
    expect(
      normalizeLabel({ basis: 'g', servingLabel: '1 bar', perServing: { calories: 150, protein: 5 } }),
    ).toBeNull();
  });

  it('refuses a label with no energy figure at all', () => {
    expect(normalizeLabel({ basis: 'g', per100: { protein: 5, carbs: 27 } })).toBeNull();
    expect(normalizeLabel({})).toBeNull();
  });

  it('converts kJ when that is all the label prints', () => {
    const food = normalizeLabel({
      basis: 'g',
      per100: { calories: null, energyKj: 1569, protein: 12.5, carbs: 67.5, fat: 7.5 },
    });
    expect(Math.round(food.kcal100)).toBe(375);
  });

  it('turns salt into sodium, since that is what gets stored', () => {
    const food = normalizeLabel({
      basis: 'g',
      per100: { calories: 400, protein: 5, carbs: 40, fat: 20, saltG: 1.25 },
    });
    expect(food.sodiumMg100).toBe(500);
  });

  it('keeps a drink measured in millilitres', () => {
    const food = normalizeLabel({
      name: 'Sinaasappelsap',
      basis: 'ml',
      servingGrams: 200,
      per100: { calories: 45, protein: 0.7, carbs: 10.4, fat: 0.2 },
    });
    expect(food.basis).toBe('ml');
    expect(food.servings.at(-1).label).toBe('100 ml');
    expect(food.caloriesPerServing).toBe(90);
  });

  it('offers the whole pack, because people eat the whole pack', () => {
    const food = normalizeLabel({
      basis: 'g',
      servingGrams: 25,
      servingsPerContainer: 6,
      per100: { calories: 500, protein: 6, carbs: 60, fat: 25 },
    });
    expect(food.servings.map((s) => s.label)).toContain('whole pack (150 g)');
  });

  it('does not offer an absurd whole pack', () => {
    const food = normalizeLabel({
      basis: 'g',
      servingGrams: 25,
      servingsPerContainer: 400, // a misread
      per100: { calories: 500, protein: 6, carbs: 60, fat: 25 },
    });
    expect(food.servings.map((s) => s.label).join()).not.toMatch(/whole pack/);
  });

  it('leaves nutrients the label did not state as unknown, not zero', () => {
    const food = normalizeLabel({
      basis: 'g',
      per100: { calories: 375, protein: 12.5, carbs: 67.5, fat: 7.5 },
    });
    expect(food.fiber100).toBeNull();
    expect(food.sodiumMg100).toBeNull();
  });

  it('carries a barcode through, so the next scan finds it', () => {
    const food = normalizeLabel(
      { basis: 'g', per100: { calories: 375, protein: 1, carbs: 1, fat: 1 } },
      { barcode: '8712345678906' },
    );
    expect(food.barcode).toBe('8712345678906');
    expect(food.source).toBe('custom');
  });
});
