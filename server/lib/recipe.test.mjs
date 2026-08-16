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
  ['usda-macaroni', 'Macaroni, dry, enriched', 371, 13, 75, 1.5, []],
  ['usda-butter', 'Butter, salted', 717, 0.9, 0.1, 81, [['1 tablespoon (14g)', 14]]],
  ['usda-milk', 'Milk, nonfat, fluid', 34, 3.4, 5, 0.1, [['1 cup (245g)', 245]]],
  ['usda-broth', 'Chicken broth', 10, 1.2, 0.4, 0.2, [['1 cup (244g)', 244]]],
  ['usda-cheddar', 'Cheese, cheddar, reduced fat', 300, 24, 4, 18, [['1 oz (28g)', 28]]],
  // The closest name has no useful cup portion; the next candidate does.
  ['usda-baby-spinach', 'Spinach, baby', 20, 2.8, 3.5, 0.4, []],
  ['usda-spinach', 'Spinach, raw', 23, 2.9, 3.6, 0.4, [['1 cup (30g)', 30]]],
  ['usda-parmesan', 'Cheese, parmesan, grated', 431, 38, 4, 29, [['1 tablespoon (5g)', 5]]],
  ['usda-breadcrumbs', 'Bread crumbs, whole wheat, seasoned', 395, 13, 72, 5, [['0.25 cup (27g)', 27]]],
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

  it('keeps AI names and exact matches through repricing', () => {
    const imported = [
      ['12 ounces elbow macaroni (wheat, whole wheat, high protein or gluten-free)', 'dry macaroni'],
      ['2 tablespoons butter', 'butter'],
      ['1/4 cup flour (or gluten-free flour mix)', 'wheat flour'],
      ['1/4 cup minced onion', 'onion'],
      ['2 cups skim milk (use rice milk for dairy-free)', 'nonfat milk'],
      ['1 cup chicken or vegetable broth', 'chicken broth'],
      ['8 ounces reduced-fat cheddar (for best results shred yourself)', 'reduced fat cheddar'],
      ['kosher salt (and black pepper, to taste)', 'kosher salt'],
      ['4 cups baby spinach', 'baby spinach'],
      ['2 tablespoons grated Parmesan', 'parmesan'],
      ['1/4 cup seasoned whole wheat bread crumbs', 'whole wheat seasoned bread crumbs'],
      ['olive oil spray', 'olive oil cooking spray'],
    ].map(([raw, matchName]) => ({ raw, matchName }));

    const first = buildRecipe(db, { ingredients: imported, servings: 8 });
    expect(first.ingredients).toHaveLength(12);
    expect(first.unmatched).toEqual([]);
    expect(first.unweighable).toEqual([]);
    expect(first.amountMissing).toEqual([
      'kosher salt (and black pepper, to taste)',
      'olive oil spray',
    ]);
    expect(first.complete).toBe(true);
    expect(first.ingredients.find((i) => i.raw === '4 cups baby spinach')).toMatchObject({
      grams: 120,
      food: { id: 'usda-spinach' },
    });
    expect(first.ingredients.find((i) => i.raw.includes('broth'))?.food?.name).toBe('Chicken broth');

    // This is the editor's mount-time price request and subsequent save shape:
    // the server-selected food IDs must make the result stable rather than
    // reparsing the long raw prose and losing seven foods.
    const persisted = first.ingredients.map((item) => ({
      raw: item.raw,
      matchName: item.name,
      foodId: item.food?.id ?? null,
    }));
    const repriced = buildRecipe(db, { ingredients: persisted, servings: 8 });
    expect(repriced.ingredients.map((i) => i.food?.id ?? null)).toEqual(
      first.ingredients.map((i) => i.food?.id ?? null),
    );
    expect(repriced.total.calories).toBe(first.total.calories);
  });

  it('marks a partial total when a measured ingredient is unresolved', () => {
    const recipe = buildRecipe(db, {
      ingredients: ['500 g beef mince', '2 tbsp gochujang', 'Salt to taste'],
      servings: 2,
    });
    expect(recipe.complete).toBe(false);
    expect(recipe.unmatched).toEqual(['2 tbsp gochujang']);
    expect(recipe.amountMissing).toEqual(['Salt to taste']);
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
