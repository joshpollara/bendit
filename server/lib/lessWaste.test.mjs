import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { bestPack, leftovers, lessWaste, useItUp } from './lessWaste.mjs';

const product = (productId, name, unitQuantity, price = 200) => ({
  productId,
  name,
  unitQuantity,
  price,
  imageId: null,
});
const CREME = product('s1', 'Picnic crème fraîche', '500 ml', 250);

const line = (overrides = {}) => ({
  key: 'name:crème fraîche',
  name: 'crème fraîche',
  grams: 150,
  written: [],
  usedIn: ['Pasta'],
  checked: false,
  choice: CREME,
  suggestion: null,
  packs: 1,
  ...overrides,
});

let db;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE recipes (id TEXT PRIMARY KEY, name TEXT, servings REAL, foodId TEXT);
    CREATE TABLE recipe_ingredients (id TEXT, recipeId TEXT, position INTEGER, raw TEXT, name TEXT,
      quantity REAL, unit TEXT, grams REAL, foodId TEXT);
  `);
  const recipe = db.prepare('INSERT INTO recipes VALUES (?, ?, ?, ?)');
  const ingredient = db.prepare('INSERT INTO recipe_ingredients VALUES (?, ?, 0, ?, ?, ?, ?, ?, NULL)');
  // 100 g a serving.
  recipe.run('soup', 'Tomato soup', 4, 'food-soup');
  ingredient.run('i1', 'soup', '400 ml crème fraîche', 'crème fraîche', 400, 'ml', null);
  // 50 g a serving.
  recipe.run('curry', 'Curry', 2, 'food-curry');
  ingredient.run('i2', 'curry', '100 g crème fraîche', 'crème fraîche', 100, 'g', 100);
  // Uses something else.
  recipe.run('salad', 'Salad', 2, 'food-salad');
  ingredient.run('i3', 'salad', '1 cucumber', 'cucumber', 1, null, null);
});

describe('leftovers', () => {
  it('reports what the packs leave after the plan', () => {
    expect(leftovers([line()])).toEqual([
      expect.objectContaining({ key: 'name:crème fraîche', needed: 150, bought: 500, left: 350, packs: 1 }),
    ]);
  });

  it('leaves out ticked lines, scrapings, and anything not bought by weight', () => {
    expect(
      leftovers([
        line({ checked: true }),
        line({ key: 'a', grams: 490 }),
        line({ key: 'b', grams: null, written: ['2'] }),
        line({ key: 'c', choice: product('s9', 'Eggs', '6 stuks') }),
      ]),
    ).toEqual([]);
  });
});

describe('best pack size', () => {
  const [current] = leftovers([line()]);

  it('finds the size that leaves least', () => {
    const better = bestPack(current, [
      product('s2', 'Crème fraîche', '200 ml', 150),
      product('s3', 'Crème fraîche', '125 ml', 99),
    ]);
    // 1 × 200 leaves 50; 2 × 125 leaves 100.
    expect(better).toEqual({ product: expect.objectContaining({ productId: 's2' }), packs: 1, left: 50 });
  });

  it('does not suggest a size that costs more than the food it saves', () => {
    // 350 g of a €2.50 500 ml tub is about €1.75 of waste; €3.98 more isn't worth it.
    expect(bestPack(current, [product('s2', 'Crème fraîche', '200 ml', 649)])).toBeNull();
    // €1.50 more is.
    expect(bestPack(current, [product('s2', 'Crème fraîche', '200 ml', 400)])).toMatchObject({ left: 50 });
  });

  it('counts a pack that comes up a little short as nothing left over', () => {
    expect(bestPack(current, [product('s2', 'Crème fraîche', '145 ml', 100)])).toMatchObject({ packs: 1, left: 0 });
  });

  it('suggests nothing when no size is clearly better', () => {
    expect(bestPack(current, [product('s4', 'Crème fraîche', '480 ml')])).toBeNull();
  });
});

describe('use it up', () => {
  it('suggests recipes, with the servings that would use the leftover', () => {
    const recipes = useItUp(db, { key: 'name:crème fraîche', left: 350 });
    // Both use it all; fewer servings first.
    expect(recipes).toEqual([
      { recipeId: 'soup', name: 'Tomato soup', servings: 4, uses: 350 },
      { recipeId: 'curry', name: 'Curry', servings: 7, uses: 350 },
    ]);
  });

  it('leaves out recipes already planned this week', () => {
    const recipes = useItUp(db, { key: 'name:crème fraîche', left: 350 }, { planned: new Set(['curry']) });
    expect(recipes.map((r) => r.recipeId)).toEqual(['soup']);
  });

  it('only suggests a recipe that uses at least half of it, without needing much more', () => {
    // A serving of soup needs 100 g, far more than the 40 g left; curry's 50 g is close.
    expect(useItUp(db, { key: 'name:crème fraîche', left: 40 }).map((r) => r.recipeId)).toEqual(['curry']);
    // Eight servings at most: 800 g of soup uses most of 1 kg, 400 g of curry doesn't.
    expect(useItUp(db, { key: 'name:crème fraîche', left: 1000 }).map((r) => r.recipeId)).toEqual(['soup']);
  });
});

describe('the report', () => {
  it('puts it together, offering only the same food in another size', async () => {
    const report = await lessWaste(
      db,
      { items: [line()] },
      {
        similar: async () => ({ brand: 'Picnic', products: [product('s2', 'Picnic crème fraîche', '200 ml', 150)] }),
        search: async () => [product('s5', 'Picnic yoghurt', '150 ml', 100)],
        planned: new Set(),
      },
    );
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ left: 350, better: { packs: 1, left: 50 } });
    expect(report[0].better.product.productId).toBe('s2');
    expect(report[0].recipes.map((r) => r.name)).toEqual(['Tomato soup', 'Curry']);
  });
});
