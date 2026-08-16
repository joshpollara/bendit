import { describe, expect, it } from 'vitest';
import type { RecipeIngredient } from '../lib/api';
import { recipeIngredientInputs } from './RecipeEditor';

const imported: RecipeIngredient[] = [
  {
    raw: '1 cup chicken or vegetable broth',
    name: 'chicken broth',
    grams: 244,
    foodId: 'usda-broth',
    food: {
      id: 'usda-broth',
      name: 'Chicken broth',
      brand: null,
      source: 'usda',
      kcal100: 10,
    },
  },
];

describe('recipeIngredientInputs', () => {
  it('preserves AI names and server-selected foods for unchanged lines', () => {
    expect(recipeIngredientInputs(imported[0].raw, imported)).toEqual([
      {
        raw: imported[0].raw,
        matchName: 'chicken broth',
        foodId: 'usda-broth',
      },
    ]);
  });

  it('drops a stale match when the ingredient text is edited', () => {
    expect(recipeIngredientInputs('1 cup vegetable broth', imported)).toEqual([
      {
        raw: '1 cup vegetable broth',
        matchName: null,
        foodId: null,
      },
    ]);
  });
});
