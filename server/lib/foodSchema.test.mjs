import { describe, expect, it } from 'vitest';
import {
  kjToKcal,
  makeFood,
  nutritionForGrams,
  per100FromServing,
  scale,
} from './foodSchema.mjs';

describe('makeFood', () => {
  const oats = () =>
    makeFood({
      id: 'usda-1',
      source: 'usda',
      sourceId: 1750340,
      name: '  Oats,  rolled  ',
      per100: { kcal100: 379, protein100: 13.2, carbs100: 67.7, fat100: 6.5 },
      servings: [{ label: '1/2 cup (40g)', grams: 40 }],
    });

  it('keeps the source and id on every record so a number can be traced', () => {
    const food = oats();
    expect(food.source).toBe('usda');
    expect(food.sourceId).toBe('1750340'); // stringified, ids are opaque
  });

  it('tidies whitespace in names without altering the words', () => {
    expect(oats().name).toBe('Oats, rolled');
  });

  it('derives the per-serving figures the app logs against', () => {
    const food = oats();
    expect(food.servingLabel).toBe('1/2 cup (40g)');
    expect(food.servingGrams).toBe(40);
    expect(food.caloriesPerServing).toBe(152); // 379 × 0.4
    expect(food.protein).toBe(5.3);
  });

  it('falls back to 100 of the base unit when no serving is given', () => {
    const food = makeFood({
      id: 'x',
      source: 'usda',
      name: 'Something',
      per100: { kcal100: 200 },
    });
    expect(food.servingLabel).toBe('100 g');
    expect(food.caloriesPerServing).toBe(200);
  });

  it('marks liquids so 100 ml is never mistaken for 100 g', () => {
    const drink = makeFood({
      id: 'off-1',
      source: 'openfoodfacts',
      name: 'Cola',
      basis: 'ml',
      per100: { kcal100: 42 },
    });
    expect(drink.basis).toBe('ml');
    expect(drink.servingLabel).toBe('100 ml');
  });

  it('leaves unknown nutrients null rather than zero', () => {
    const food = oats();
    // "no data" and "contains none" are different claims; only one can be summed.
    expect(food.fiber100).toBeNull();
    expect(food.sodiumMg100).toBeNull();
  });

  it('refuses to build a record without the fields that identify it', () => {
    expect(() => makeFood({ source: 'usda', name: 'x' })).toThrow(/id/);
    expect(() => makeFood({ id: 'a', name: 'x' })).toThrow(/source/);
    expect(() => makeFood({ id: 'a', source: 'usda', name: '   ' })).toThrow(/name/);
  });
});

describe('per100FromServing', () => {
  it('recovers per-100g from a per-serving record', () => {
    // The existing Apple seed: 95 kcal in 182 g.
    const per100 = per100FromServing({
      servingGrams: 182,
      caloriesPerServing: 95,
      protein: 0.5,
      carbs: 25,
      fat: 0.3,
    });
    expect(per100.kcal100).toBe(52.2);
    expect(per100.carbs100).toBe(13.74);
  });

  it('gives up when there is no serving weight to divide by', () => {
    // Inventing a weight here would poison every gram-based estimate later.
    expect(per100FromServing({ servingGrams: null, caloriesPerServing: 200 })).toBeNull();
    expect(per100FromServing({ servingGrams: 0, caloriesPerServing: 200 })).toBeNull();
  });
});

describe('nutritionForGrams', () => {
  const food = { kcal100: 165, protein100: 31, carbs100: 0, fat100: 3.6 };

  it('computes a portion from the canonical per-100g values', () => {
    const result = nutritionForGrams(food, 150);
    expect(result.calories).toBe(248);
    expect(result.protein).toBe(46.5);
    expect(result.known).toBe(true);
  });

  it('reports when a food has no nutrition, instead of returning zeros', () => {
    const result = nutritionForGrams({ kcal100: null }, 150);
    expect(result.known).toBe(false);
  });
});

describe('unit conversions', () => {
  it('converts kJ to kcal for sources that only publish joules', () => {
    expect(Math.round(kjToKcal(2100))).toBe(502);
    expect(kjToKcal(null)).toBeNull();
  });

  it('scales a per-100 value to any weight', () => {
    expect(scale(200, 50)).toBe(100);
    expect(scale(null, 50)).toBeNull();
  });
});
