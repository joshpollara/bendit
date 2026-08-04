import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRecipeTables, deleteRecipe, listRecipes, readRecipe, saveRecipe } from './recipeStore.mjs';

let db;
let saved;

const saveFood = (food) => {
  saved.push(food);
  db.prepare(
    `INSERT OR REPLACE INTO foods
       (id, name, source, servingLabel, servingGrams, caloriesPerServing, protein, carbs, fat,
        kcal100, protein100, carbs100, fat100, ownerId)
     VALUES (@id, @name, @source, @servingLabel, @servingGrams, @caloriesPerServing, @protein,
             @carbs, @fat, @kcal100, @protein100, @carbs100, @fat100, @ownerId)`,
  ).run({ ...food, protein: food.protein ?? null, carbs: food.carbs ?? null, fat: food.fat ?? null });
};

beforeEach(() => {
  db = new Database(':memory:');
  saved = [];
  db.exec(`
    CREATE TABLE foods (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, source TEXT NOT NULL,
      servingLabel TEXT, servingGrams REAL, caloriesPerServing REAL, protein REAL, carbs REAL,
      fat REAL, kcal100 REAL, protein100 REAL, carbs100 REAL, fat100 REAL, ownerId TEXT
    );
    CREATE TABLE food_servings (
      id TEXT PRIMARY KEY, foodId TEXT NOT NULL, label TEXT NOT NULL, grams REAL NOT NULL,
      isDefault INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE food_log (
      id TEXT PRIMARY KEY, foodId TEXT, label TEXT, caloriesCached REAL, userId TEXT
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL);
    CREATE VIRTUAL TABLE foods_fts USING fts5(
      name, brand, content='foods', content_rowid='rowid', tokenize='porter unicode61'
    );
  `);
  createRecipeTables(db);
  db.prepare('INSERT INTO users VALUES (?, ?)').run('ada', 'ada');
  db.prepare('INSERT INTO users VALUES (?, ?)').run('bob', 'bob');

  // One food, so the ingredients price to something checkable.
  db.prepare(
    `INSERT INTO foods (id, name, source, servingLabel, servingGrams, kcal100, protein100, carbs100, fat100)
     VALUES ('usda-beef', 'Beef, ground, raw', 'usda', '100 g', 100, 200, 18, 0, 15)`,
  ).run();
  db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')");
});

const BOLOGNESE = {
  name: 'Bolognese',
  servings: 4,
  servingsStated: true,
  ingredients: ['500 g ground beef'],
  sourceType: 'manual',
};

describe('saveRecipe', () => {
  it('writes the recipe and the food for one serving of it', () => {
    const { id } = saveRecipe(db, BOLOGNESE, { saveFood, ownerId: 'ada' });
    const recipe = readRecipe(db, id);

    expect(recipe.name).toBe('Bolognese');
    expect(recipe.servings).toBe(4);
    expect(recipe.author).toBe('ada');
    // 500 g at 200 kcal/100g is 1000, over four servings.
    expect(recipe.food.caloriesPerServing).toBe(250);
    expect(recipe.food.servingGrams).toBe(125);
  });

  it('keeps every ingredient, resolved or not', () => {
    const { id } = saveRecipe(
      db,
      { ...BOLOGNESE, ingredients: ['500 g ground beef', 'Salt to taste'] },
      { saveFood, ownerId: 'ada' },
    );
    const recipe = readRecipe(db, id);
    expect(recipe.ingredients.map((i) => i.raw)).toEqual(['500 g ground beef', 'Salt to taste']);
    expect(recipe.ingredients[1].grams).toBeNull();
  });

  it('leaves the recipe’s food shared, so anyone here can log it', () => {
    saveRecipe(db, BOLOGNESE, { saveFood, ownerId: 'ada' });
    expect(saved[0].ownerId).toBeNull();
  });

  it('re-prices the food when the recipe is edited, keeping its id', () => {
    const { id } = saveRecipe(db, BOLOGNESE, { saveFood, ownerId: 'ada' });
    const before = readRecipe(db, id).food;

    saveRecipe(db, { ...BOLOGNESE, servings: 2 }, { saveFood, ownerId: 'ada', id });
    const after = readRecipe(db, id).food;

    expect(after.id).toBe(before.id); // entries already logged still point at it
    expect(after.caloriesPerServing).toBe(500); // same food, twice the portion
  });

  it('keeps the original author across an edit by them', () => {
    const { id } = saveRecipe(db, BOLOGNESE, { saveFood, ownerId: 'ada' });
    saveRecipe(db, { ...BOLOGNESE, name: 'Ada’s bolognese' }, { saveFood, ownerId: 'ada', id });
    expect(readRecipe(db, id).createdBy).toBe('ada');
  });

  it('records where it came from', () => {
    const { id } = saveRecipe(
      db,
      { ...BOLOGNESE, sourceType: 'url', sourceUrl: 'https://example.com/r' },
      { saveFood, ownerId: 'ada' },
    );
    expect(readRecipe(db, id)).toMatchObject({
      sourceType: 'url',
      sourceUrl: 'https://example.com/r',
    });
  });
});

describe('listRecipes', () => {
  it('shows everyone’s, because recipes are shared here', () => {
    saveRecipe(db, BOLOGNESE, { saveFood, ownerId: 'ada' });
    saveRecipe(db, { ...BOLOGNESE, name: 'Bob’s stew' }, { saveFood, ownerId: 'bob' });

    const all = listRecipes(db);
    expect(all.map((r) => r.name).sort()).toEqual(['Bob’s stew', 'Bolognese']);
    expect(all.map((r) => r.author).sort()).toEqual(['ada', 'bob']);
  });
});

describe('deleteRecipe', () => {
  it('takes the food with it', () => {
    const { id } = saveRecipe(db, BOLOGNESE, { saveFood, ownerId: 'ada' });
    const foodId = readRecipe(db, id).food.id;

    deleteRecipe(db, id);

    expect(readRecipe(db, id)).toBeNull();
    expect(db.prepare('SELECT id FROM foods WHERE id = ?').get(foodId)).toBeUndefined();
  });

  it('leaves what was already logged readable', () => {
    const { id } = saveRecipe(db, BOLOGNESE, { saveFood, ownerId: 'ada' });
    const foodId = readRecipe(db, id).food.id;
    db.prepare('INSERT INTO food_log VALUES (?, ?, NULL, ?, ?)').run('entry', foodId, 250, 'ada');

    deleteRecipe(db, id);

    const entry = db.prepare('SELECT * FROM food_log WHERE id = ?').get('entry');
    expect(entry.caloriesCached).toBe(250); // the calories stand
    expect(entry.label).toBe('Bolognese'); // and it still says what it was
    expect(entry.foodId).toBeNull();
  });

  it('says so when there is nothing to delete', () => {
    expect(deleteRecipe(db, 'nope')).toBe(false);
  });
});
