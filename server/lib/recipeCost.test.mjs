import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { cachedCost, costRecipe, createRecipeCostTables, lineCost } from './recipeCost.mjs';
import { createMealPlanTables } from './mealPlan.mjs';
import { createPicnicShoppingTables, setChoice } from './picnicShopping.mjs';
import { createRecipeTables } from './recipeStore.mjs';

const product = (unitQuantity, price) => ({ productId: 'p', name: 'x', unitQuantity, price, imageId: null });

describe('what a line uses', () => {
  it('is its share of the pack by weight', () => {
    expect(lineCost({ grams: 200, written: [] }, product('500 gram', 500))).toBe(200);
  });
  it('is its share of a pack of so many', () => {
    expect(lineCost({ grams: null, written: ['1'] }, product('3 stuks', 90))).toBe(30);
    expect(lineCost({ grams: null, written: ['2'] }, product('1 stuk', 79))).toBe(158);
  });
  it("can't be told without an amount, a pack size or a price", () => {
    expect(lineCost({ grams: null, written: ['1 bunch'] }, product('1 bosje', 99))).toBeNull();
    expect(lineCost({ grams: 100, written: [] }, product('1 bosje', 99))).toBeNull();
    expect(lineCost({ grams: 100, written: [] }, { ...product('500 gram', null) })).toBeNull();
  });
});

describe("a recipe's cost a serving", () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    createRecipeTables(db);
    createMealPlanTables(db);
    createPicnicShoppingTables(db);
    createRecipeCostTables(db);
    db.exec(`
      INSERT INTO recipes (id, name, servings, createdBy, createdAt, updatedAt) VALUES ('chili', 'Chili', 4, 'x', '2026-01-01', '2026-01-01');
      INSERT INTO recipe_ingredients (id, recipeId, position, raw, name, quantity, unit, grams, foodId) VALUES
        ('i1', 'chili', 0, '500 g beef', 'beef', 500, 'g', 500, 'beef'),
        ('i2', 'chili', 1, '1 onion', 'onion', 1, NULL, NULL, NULL),
        ('i3', 'chili', 2, '1 bunch coriander', 'coriander', 1, 'bunch', NULL, NULL);
    `);
    setChoice(db, 'food:beef', product('500 gram', 540), { userId: 'ann' });
  });
  // Picnic's top match for anything nobody picked.
  const suggest = async (term) => (term === 'onion' ? product('3 stuks', 90) : product('1 bosje', 99));

  it('adds up what each line uses, and says how much was priced', async () => {
    const cost = await costRecipe(db, 'chili', { suggest, now: Date.parse('2026-10-17T12:00:00Z') });
    // (€5.40 beef + €0.30 onion) / 4; the coriander can't be priced.
    expect(cost).toEqual({ perServing: 143, priced: 2, lines: 3, guessed: 1 });
    expect(cachedCost(db, 'chili', { now: Date.parse('2026-10-18T12:00:00Z') })).toEqual(cost);
  });

  it('gives no figure when under half the lines could be priced', async () => {
    const nothing = async () => product('1 bosje', 99);
    db.prepare("DELETE FROM picnic_choices").run();
    expect(await costRecipe(db, 'chili', { suggest: nothing })).toMatchObject({ perServing: null, priced: 0, lines: 3 });
  });

  it('is worked out again after a week, or after an edit', async () => {
    await costRecipe(db, 'chili', { suggest, now: Date.parse('2026-10-17T12:00:00Z') });
    expect(cachedCost(db, 'chili', { now: Date.parse('2026-10-25T12:00:00Z') })).toBeNull();
    db.prepare("UPDATE recipes SET updatedAt = '2026-10-17T13:00:00Z'").run();
    expect(cachedCost(db, 'chili', { now: Date.parse('2026-10-17T14:00:00Z') })).toBeNull();
  });
});
