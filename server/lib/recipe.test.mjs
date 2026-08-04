import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildRecipe, recipeFood, resolveIngredient } from './recipe.mjs';
import { parseIngredient } from './recipeParse.mjs';

// Real foods with published figures, and the portions the USDA import gives
// them, so a bolognese can be checked with a calculator.
const FOODS = [
  ['usda-oil', 'Oil, olive, salad or cooking', 884, 0, 0, 100, [['1 tablespoon (14g)', 14]]],
  ['usda-onion', 'Onions, raw', 40, 1.1, 9.3, 0.1, [['1 cup, chopped (160g)', 160], ['1 medium (110g)', 110]]],
  ['usda-garlic', 'Garlic, raw', 149, 6.4, 33, 0.5, [['1 clove (3g)', 3]]],
  ['usda-beef', 'Beef, ground, 85% lean meat, raw', 215, 18.6, 0, 15, []],
  ['usda-tomato', 'Tomatoes, red, ripe, canned', 32, 1.6, 7.3, 0.3, []],
  ['usda-flour', 'Wheat flour, white, all-purpose, enriched', 364, 10.3, 76.3, 1, [['1 cup (125g)', 125]]],
];

let db;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE foods (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, source TEXT NOT NULL,
      servingLabel TEXT, servingGrams REAL, ownerId TEXT,
      kcal100 REAL, protein100 REAL, carbs100 REAL, fat100 REAL
    );
    CREATE TABLE food_servings (
      id TEXT PRIMARY KEY, foodId TEXT NOT NULL, label TEXT NOT NULL,
      grams REAL NOT NULL, isDefault INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE foods_fts USING fts5(
      name, brand, content='foods', content_rowid='rowid', tokenize='porter unicode61'
    );
  `);
  const food = db.prepare(
    `INSERT INTO foods (id, name, source, servingLabel, servingGrams, kcal100, protein100, carbs100, fat100)
     VALUES (?, ?, 'usda', '100 g', 100, ?, ?, ?, ?)`,
  );
  const serving = db.prepare('INSERT INTO food_servings VALUES (?, ?, ?, ?, 1)');
  for (const [id, name, kcal, protein, carbs, fat, portions] of FOODS) {
    food.run(id, name, kcal, protein, carbs, fat);
    portions.forEach(([label, grams], i) => serving.run(`${id}:${i}`, id, label, grams));
  }
  db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')");
});

const resolve = (line) => resolveIngredient(db, parseIngredient(line));

describe('resolveIngredient', () => {
  it('matches the food and prices the amount', () => {
    const oil = resolve('2 tbsp olive oil');
    expect(oil.food.id).toBe('usda-oil');
    expect(oil.grams).toBe(28); // the food's own tablespoon
    expect(oil.nutrition.calories).toBe(248); // 884 × 0.28
  });

  it('uses a count when the food has a portion for it', () => {
    const onion = resolve('1 onion');
    expect(onion.grams).toBe(110); // one medium
    expect(onion.nutrition.calories).toBe(44);
  });

  it('takes a stated weight over any portion', () => {
    expect(resolve('500 g beef mince').grams).toBe(500);
  });

  it('says when it could not match the food', () => {
    const nothing = resolve('2 tbsp gochujang');
    expect(nothing.food).toBeNull();
    expect(nothing.nutrition).toBeNull();
  });

  it('says when it could not weigh the line', () => {
    const salt = resolve('Salt and pepper to taste');
    expect(salt.grams).toBeNull();
    expect(salt.reason).toBe('no amount given');
  });
});

describe('buildRecipe', () => {
  const BOLOGNESE = [
    '2 tbsp olive oil',
    '1 onion, finely chopped',
    '2 cloves garlic, crushed',
    '500 g beef mince',
    '400 g canned tomatoes',
    'Salt and pepper to taste',
  ];

  it('adds a recipe up and divides it into servings', () => {
    const recipe = buildRecipe(db, { ingredients: BOLOGNESE, servings: 4 });
    // 248 (oil) + 44 (onion) + 9 (garlic) + 1075 (beef) + 128 (tomatoes)
    expect(recipe.total.calories).toBe(1504);
    expect(recipe.perServing.calories).toBe(376);
    expect(recipe.servings).toBe(4);
  });

  it('gives one serving a weight, so it can be logged in grams', () => {
    const recipe = buildRecipe(db, { ingredients: BOLOGNESE, servings: 4 });
    expect(recipe.total.grams).toBe(1044); // 28 + 110 + 6 + 500 + 400
    expect(recipe.perServing.grams).toBe(261);
  });

  it('lists what it could not resolve rather than dropping it silently', () => {
    const recipe = buildRecipe(db, { ingredients: BOLOGNESE, servings: 4 });
    expect(recipe.unresolved).toEqual(['Salt and pepper to taste']);
  });

  it('flags amounts weighed by a standard measure rather than the food’s own', () => {
    // Tinned tomatoes match, but the food has no "cup" portion, so the weight
    // comes from a standard cup rather than from this food.
    const recipe = buildRecipe(db, { ingredients: ['1 cup canned tomatoes'], servings: 1 });
    expect(recipe.approximate).toEqual(['1 cup canned tomatoes']);
  });

  it('does not weigh a food it could not identify', () => {
    // Grams without a food buy nothing, and pretending otherwise would put a
    // confident number on a line nobody could price.
    const recipe = buildRecipe(db, { ingredients: ['2 tbsp gochujang'], servings: 1 });
    expect(recipe.ingredients[0].grams).toBeNull();
    expect(recipe.unresolved).toEqual(['2 tbsp gochujang']);
  });

  it('treats a missing serving count as one serving, not as none', () => {
    const recipe = buildRecipe(db, { ingredients: ['500 g beef mince'] });
    expect(recipe.servings).toBe(1);
    expect(recipe.perServing.calories).toBe(recipe.total.calories);
  });

  it('takes already-parsed ingredients as readily as lines', () => {
    const parsed = BOLOGNESE.map((line) => parseIngredient(line));
    expect(buildRecipe(db, { ingredients: parsed, servings: 4 }).total.calories).toBe(1504);
  });
});

describe('recipeFood', () => {
  const recipe = () => buildRecipe(db, { ingredients: ['500 g beef mince', '1 cup flour'], servings: 2 });

  it('is one serving of the recipe, in the shape the app logs', () => {
    const food = recipeFood(recipe(), { id: 'recipe-food-1', name: 'Test bake' });
    expect(food.name).toBe('Test bake');
    expect(food.source).toBe('custom');
    // (1075 + 455) / 2
    expect(food.caloriesPerServing).toBe(765);
    expect(food.servingLabel).toBe('1 serving (313g)');
  });

  it('carries a per-100g form, so a portion can be rescaled', () => {
    const food = recipeFood(recipe(), { id: 'recipe-food-1', name: 'Test bake' });
    expect(food.kcal100).toBeCloseTo(244.9, 0);
  });

  it('offers the whole recipe as a serving, for when you eat the lot', () => {
    const food = recipeFood(recipe(), { id: 'recipe-food-1', name: 'Test bake' });
    expect(food.servings.map((s) => s.label)).toContain('whole recipe');
  });

  it('leaves per-100g unknown when nothing could be weighed', () => {
    const nothing = buildRecipe(db, { ingredients: ['Salt to taste'], servings: 1 });
    const food = recipeFood(nothing, { id: 'x', name: 'Nothing' });
    expect(food.kcal100).toBeNull();
    expect(food.servingGrams).toBeNull();
  });
});
