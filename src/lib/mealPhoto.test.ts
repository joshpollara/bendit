import { describe, expect, it } from 'vitest';
import {
  applyMealQuestionChoice,
  appendMealFeedbackAction,
  itemFromFood,
  mealFeedbackFor,
  positiveMealNumber,
  replaceItemFood,
  rescaleItem,
  setCalories,
  totalsFor,
  unitOptions,
  type MealFeedbackAction,
  type MealItem,
} from './mealPhoto';
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
  id: 'rice',
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

describe('setCalories', () => {
  it('turns a corrected calorie figure back into a weight', () => {
    const corrected = setCalories(estimated(), 205);
    expect(corrected.grams).toBe(157.7); // 205 ÷ 130 × 100
    expect(corrected.nutrition?.calories).toBe(205);
  });

  it('keeps the macros in step with the calories', () => {
    const corrected = setCalories(estimated(), 130);
    expect(corrected.grams).toBe(100);
    expect(corrected.nutrition?.protein).toBe(2.7);
    expect(corrected.nutrition?.carbs).toBe(28.2);
  });

  it('drops the error band, as a typed weight does', () => {
    const corrected = setCalories(estimated(), 205);
    expect(corrected.error).toBe(0);
    expect(corrected.range).toEqual({ low: 205, high: 205 });
  });

  it('gives an unmatched item the calories it was typed, and nothing else', () => {
    const corrected = setCalories(estimated({ food: null, nutrition: null, range: null }), 320);
    expect(corrected.nutrition).toEqual({ calories: 320, protein: null, carbs: null, fat: null });
    expect(corrected.range).toEqual({ low: 320, high: 320 });
    expect(corrected.grams).toBe(210); // untouched: there is no weight to infer
  });

  it('ignores a figure that is not a number', () => {
    expect(setCalories(estimated(), Number.NaN)).toEqual(estimated());
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

describe('replaceItemFood', () => {
  it('reprices the original portion range instead of treating an identity correction as weighed', () => {
    const original = estimated({
      id: 'item_1',
      portionG: { low: 150, median: 210, high: 280 },
    });

    const replaced = replaceItemFood(original, rice);

    expect(replaced.food?.id).toBe(rice.id);
    expect(replaced.id).toBe('item_1');
    expect(replaced.portionG).toEqual({ low: 150, median: 210, high: 280 });
    expect(replaced.range).toEqual({ low: 195, high: 364 });
    expect(replaced.error).toBe(0.25);
  });
});

describe('applyMealQuestionChoice', () => {
  it('applies only the selected item and keeps a narrow approximate range', () => {
    const items = [
      estimated({ id: 'rice', portionG: { low: 120, median: 210, high: 320 } }),
      estimated({ id: 'other', grams: 100 }),
    ];
    const answered = applyMealQuestionChoice(
      items,
      {
        id: 'portion:rice',
        targetItemId: 'rice',
        question: 'Which amount is closest?',
        expectedReductionKcal: 200,
        choices: [{ id: 'small', label: 'Small (150 g)', grams: 150 }],
      },
      'small',
    );

    expect(answered[0].grams).toBe(150);
    expect(answered[0].nutrition?.calories).toBe(195);
    expect(answered[0].range).toEqual({ low: 176, high: 215 });
    expect(answered[0].error).toBe(0.1);
    expect(answered[1]).toEqual(items[1]);
  });

  it('does nothing for an unknown answer', () => {
    const items = [estimated({ id: 'rice' })];
    expect(
      applyMealQuestionChoice(
        items,
        {
          id: 'portion:rice',
          targetItemId: 'rice',
          question: 'Which amount is closest?',
          expectedReductionKcal: 200,
          choices: [],
        },
        'missing',
      ),
    ).toBe(items);
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

  it('does not count stale nutrition attached to a zero amount', () => {
    expect(totalsFor([estimated({ grams: 0 })])).toEqual({
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      low: 0,
      high: 0,
    });
  });

  it('uses known calories as both bounds when an item has no explicit range', () => {
    expect(totalsFor([estimated({ range: null })])).toMatchObject({
      calories: 273,
      low: 273,
      high: 273,
    });
  });
});

describe('positiveMealNumber', () => {
  it.each(['', ' ', '0', '-1', 'not a number'])('rejects an invalid edit draft: %j', (value) => {
    expect(positiveMealNumber(value)).toBeNull();
  });

  it('accepts a positive decimal', () => {
    expect(positiveMealNumber(' 125.5 ')).toBe(125.5);
  });
});

describe('meal photo feedback', () => {
  it('deduplicates number-field interactions instead of recording keystrokes', () => {
    const once = appendMealFeedbackAction([], { type: 'item_amount_changed', itemId: 'rice' });
    const twice = appendMealFeedbackAction(once, { type: 'item_amount_changed', itemId: 'rice' });
    const anotherItem = appendMealFeedbackAction(twice, {
      type: 'item_amount_changed',
      itemId: 'beans',
    });

    expect(twice).toBe(once);
    expect(anotherItem).toHaveLength(2);
  });

  it('caps semantic actions because the final snapshot carries the actual values', () => {
    let actions: MealFeedbackAction[] = [];
    for (let index = 0; index < 60; index++) {
      actions = appendMealFeedbackAction(actions, {
        type: 'item_added',
        itemId: `item-${index}`,
      });
    }
    expect(actions).toHaveLength(50);
  });

  it('sends only the compact final item snapshot', () => {
    const feedback = mealFeedbackFor({
      outcome: 'logged',
      rating: 'needed_edits',
      issues: ['portion_off'],
      note: '  Bowl was weighed  ',
      actions: [{ type: 'item_amount_changed', itemId: 'rice' }],
      meal: 'dinner',
      items: [estimated({ id: 'rice' })],
    });

    expect(feedback.note).toBe('Bowl was weighed');
    expect(feedback.final!.items).toEqual([
      {
        id: 'rice',
        kind: 'food',
        foodId: 'seed-087',
        name: 'White rice, cooked',
        grams: 210,
        calories: 273,
        protein: 5.7,
        carbs: 59.2,
        fat: 0.6,
        low: 205,
        high: 341,
      },
    ]);
  });

  it('cannot submit stale nutrition for a blank or zero portion', () => {
    const feedback = mealFeedbackFor({
      outcome: 'logged',
      meal: 'dinner',
      items: [estimated({ id: 'rice', grams: 0 }), estimated({ id: 'beans' })],
    });

    expect(feedback.final!.total.calories).toBe(273);
    expect(feedback.final!.items[0]).toMatchObject({ grams: 0, calories: null, low: null, high: null });
  });

  it('does not retain a meal snapshot when the user leaves without logging it', () => {
    const feedback = mealFeedbackFor({
      outcome: 'retake',
      rating: 'way_off',
      issues: ['wrong_food'],
      meal: 'dinner',
      items: [estimated()],
    });

    expect(feedback.final).toBeNull();
  });

  it('drops hidden issue details when the rating is not negative', () => {
    const feedback = mealFeedbackFor({
      outcome: 'logged',
      rating: 'close',
      issues: ['wrong_food'],
      note: 'should not be sent',
      meal: 'lunch',
      items: [estimated({ id: 'rice' })],
    });

    expect(feedback.issues).toEqual([]);
    expect(feedback.note).toBeNull();
  });
});
