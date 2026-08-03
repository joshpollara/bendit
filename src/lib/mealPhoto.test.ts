import { describe, expect, it } from 'vitest';
import { itemFromFood, rescaleItem, totalsFor, unitOptions, type MealItem } from './mealPhoto';
import type { Food } from '../types';

// The correction layer: what happens after the model has had its say.

const rice: Food = {
  id: 'seed-087',
  name: 'White rice, cooked',
  servingLabel: '1 cup (158g)',
  servingGrams: 158,
  caloriesPerServing: 205,
  protein: 4.3,
  carbs: 44.6,
  fat: 0.4,
  source: 'seed',
  kcal100: 130,
  protein100: 2.7,
  carbs100: 28.2,
  fat100: 0.3,
};

const estimated = (over: Partial<MealItem> = {}): MealItem => ({
  name: 'white rice',
  seenAs: 'white rice',
  grams: 210,
  confidence: 'medium',
  error: 0.25,
  food: {
    id: 'seed-087',
    name: 'White rice, cooked',
    brand: null,
    source: 'seed',
    kcal100: 130,
    servingLabel: '1 cup (158g)',
    servingGrams: 158,
    servings: [],
  },
  nutrition: { calories: 273, protein: 5.7, carbs: 59.2, fat: 0.6 },
  range: { low: 205, high: 341 },
  ...over,
});

describe('unitOptions', () => {
  it('offers the portion a food is actually sold in', () => {
    expect(unitOptions(estimated())).toEqual([
      { label: '1 cup', grams: 158 },
      { label: '½ cup', grams: 79 },
    ]);
  });

  it('prefers the food’s own portion table when it has one', () => {
    const withTable = estimated({
      food: {
        ...estimated().food!,
        servings: [
          { label: '1 cup (195g)', grams: 195 },
          { label: '100 g', grams: 100 },
        ],
      },
    });
    expect(unitOptions(withTable).map((u) => u.label)).toEqual(['1 cup', '½ cup']);
  });

  it('leaves out portions that are just a weight, which the grams box says already', () => {
    for (const label of ['100 g', '25.0g', '150 ml']) {
      const weightOnly = estimated({
        food: { ...estimated().food!, servingGrams: null, servings: [{ label, grams: 100 }] },
      });
      expect(unitOptions(weightOnly), label).toEqual([]);
    }
  });

  it('does not mangle a portion that is not one of something', () => {
    const biscuits = estimated({
      food: { ...estimated().food!, servings: [{ label: '2 biscuits (25g)', grams: 25 }] },
    });
    expect(unitOptions(biscuits)).toEqual([{ label: '2 biscuits', grams: 25 }]);
  });

  it('has nothing to offer for an unmatched item', () => {
    expect(unitOptions(estimated({ food: null }))).toEqual([]);
  });
});

describe('rescaleItem', () => {
  it('reprices an item at a weight the user typed', () => {
    const corrected = rescaleItem(estimated(), 158);
    expect(corrected.nutrition?.calories).toBe(205); // 130 × 1.58
    expect(corrected.grams).toBe(158);
  });

  it('drops the error band: a weight someone knows is not a guess', () => {
    const corrected = rescaleItem(estimated(), 158);
    expect(corrected.error).toBe(0);
    expect(corrected.range).toEqual({ low: 205, high: 205 });
  });

  it('leaves an unmatched item alone apart from the weight', () => {
    const unmatched = estimated({ food: null, nutrition: null });
    expect(rescaleItem(unmatched, 50).grams).toBe(50);
    expect(rescaleItem(unmatched, 50).nutrition).toBeNull();
  });
});

describe('itemFromFood', () => {
  it('prices a food picked by hand from its per-100g figures', () => {
    const item = itemFromFood(rice, 200);
    expect(item.nutrition?.calories).toBe(260);
    expect(item.nutrition?.protein).toBe(5.4);
    expect(item.food?.id).toBe('seed-087');
  });

  it('carries no error band — nothing about it was estimated', () => {
    const item = itemFromFood(rice, 200);
    expect(item.error).toBe(0);
    expect(item.range?.low).toBe(item.range?.high);
  });

  it('remembers what the model had called it, when it is a correction', () => {
    expect(itemFromFood(rice, 200, 'risotto').seenAs).toBe('risotto');
  });

  it('falls back to the serving when a food has no per-100g figures', () => {
    const old: Food = { ...rice, kcal100: null, protein100: null, carbs100: null, fat100: null };
    expect(itemFromFood(old, 158).nutrition?.calories).toBe(205);
  });

  it('expresses the amount in servings, which is what the log counts', () => {
    expect(itemFromFood(rice, 79).servings).toBe(0.5);
  });
});

describe('totalsFor', () => {
  it('adds up only the items that have numbers', () => {
    const total = totalsFor([estimated(), estimated({ food: null, nutrition: null, range: null })]);
    expect(total.calories).toBe(273);
    expect(total.low).toBe(205);
  });

  it('is zero for an empty plate', () => {
    expect(totalsFor([]).calories).toBe(0);
  });
});
