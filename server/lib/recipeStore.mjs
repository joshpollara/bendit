// Recipes in the database, and the food each one produces.
//
// A recipe is a list of written lines plus how many servings it makes. Saving
// one also creates a food for a single serving, which is what the rest of the
// app logs against — so a recipe you added is a food you can eat, and editing
// the recipe moves that food with it.
//
// Recipes are visible to everyone on the server, like the food database.
// Editing and deleting stay with whoever added it.

import crypto from 'node:crypto';
import { buildRecipe, recipeFood } from './recipe.mjs';

export function createRecipeTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      servings REAL NOT NULL,
      -- Whether the source said how many it makes, or it was worked out.
      servingsStated INTEGER NOT NULL DEFAULT 0,
      -- 'url' | 'photo' | 'manual', and where from.
      sourceType TEXT,
      sourceUrl TEXT,
      instructions TEXT,
      notes TEXT,
      -- The food this recipe makes, one serving of it.
      foodId TEXT,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id TEXT PRIMARY KEY,
      recipeId TEXT NOT NULL,
      position INTEGER NOT NULL,
      -- The line as written, which is the thing a person recognises.
      raw TEXT NOT NULL,
      -- What it resolved to, cached so a list doesn't re-resolve everything.
      name TEXT, quantity REAL, unit TEXT, grams REAL, weighedBy TEXT,
      foodId TEXT, calories REAL, protein REAL, carbs REAL, fat REAL
    );
    CREATE INDEX IF NOT EXISTS idx_recipe_ingredients ON recipe_ingredients(recipeId);
    CREATE INDEX IF NOT EXISTS idx_recipes_created ON recipes(createdBy);
  `);
}

const newId = () => crypto.randomUUID();

/** A recipe with its ingredients, as the client reads it. */
export function readRecipe(db, id) {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  if (!recipe) return null;
  const ingredients = db
    .prepare('SELECT * FROM recipe_ingredients WHERE recipeId = ? ORDER BY position')
    .all(id);
  const author = db.prepare('SELECT username FROM users WHERE id = ?').get(recipe.createdBy);
  const food = recipe.foodId
    ? db.prepare('SELECT * FROM foods WHERE id = ?').get(recipe.foodId)
    : null;

  const total = ingredients.reduce(
    (sum, i) => ({
      grams: sum.grams + (i.grams ?? 0),
      calories: sum.calories + (i.calories ?? 0),
    }),
    { grams: 0, calories: 0 },
  );

  return {
    ...recipe,
    servingsStated: recipe.servingsStated === 1,
    author: author?.username ?? null,
    ingredients,
    food,
    total: { grams: Math.round(total.grams), calories: Math.round(total.calories) },
    perServing: food
      ? { calories: food.caloriesPerServing, grams: food.servingGrams }
      : { calories: null, grams: null },
  };
}

export const listRecipes = (db) =>
  db
    .prepare('SELECT id FROM recipes ORDER BY name COLLATE NOCASE')
    .all()
    .map((row) => readRecipe(db, row.id));

/**
 * Writes a recipe and the food for one serving of it, together.
 *
 * `saveFood` is passed in rather than imported: the food-writing code lives in
 * the server and knows about the search index, and this stays testable without
 * either.
 */
export function saveRecipe(db, input, { saveFood, ownerId, id = newId() }) {
  const existing = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  const built = buildRecipe(db, {
    ingredients: input.ingredients,
    servings: input.servings,
    ownerId,
  });

  // The food keeps its id across an edit, so entries already logged against it
  // still point at something, and the Recent list doesn't sprout duplicates.
  const foodId = existing?.foodId ?? `recipe-${id}`;
  const food = recipeFood(built, { id: foodId, name: input.name, ownerId: null });

  db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO recipes
         (id, name, servings, servingsStated, sourceType, sourceUrl, instructions, notes,
          foodId, createdBy, createdAt, updatedAt)
       VALUES (@id, @name, @servings, @servingsStated, @sourceType, @sourceUrl, @instructions,
               @notes, @foodId, @createdBy, @createdAt, @updatedAt)`,
    ).run({
      id,
      name: input.name,
      servings: built.servings,
      servingsStated: input.servingsStated ? 1 : 0,
      sourceType: input.sourceType ?? 'manual',
      sourceUrl: input.sourceUrl ?? null,
      instructions: input.instructions ?? null,
      notes: input.notes ?? null,
      foodId,
      // Whoever added it keeps it, however many times it is edited.
      createdBy: existing?.createdBy ?? ownerId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    db.prepare('DELETE FROM recipe_ingredients WHERE recipeId = ?').run(id);
    const insert = db.prepare(
      `INSERT INTO recipe_ingredients
         (id, recipeId, position, raw, name, quantity, unit, grams, weighedBy, foodId,
          calories, protein, carbs, fat)
       VALUES (@id, @recipeId, @position, @raw, @name, @quantity, @unit, @grams, @weighedBy,
               @foodId, @calories, @protein, @carbs, @fat)`,
    );
    built.ingredients.forEach((item, position) =>
      insert.run({
        id: newId(),
        recipeId: id,
        position,
        raw: item.raw,
        name: item.name ?? null,
        quantity: item.quantity ?? null,
        unit: item.unit ?? null,
        grams: item.grams ?? null,
        weighedBy: item.weighedBy ?? null,
        foodId: item.food?.id ?? null,
        calories: item.nutrition?.calories ?? null,
        protein: item.nutrition?.protein ?? null,
        carbs: item.nutrition?.carbs ?? null,
        fat: item.nutrition?.fat ?? null,
      }),
    );

    saveFood(food);
  })();

  return { id, built };
}

/** Removes a recipe and the food it made. Past log entries keep their calories. */
export function deleteRecipe(db, id) {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  if (!recipe) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM recipe_ingredients WHERE recipeId = ?').run(id);
    if (recipe.foodId) {
      db.prepare(
        'UPDATE food_log SET label = COALESCE(label, ?), foodId = NULL WHERE foodId = ?',
      ).run(recipe.name, recipe.foodId);
      db.prepare('DELETE FROM food_servings WHERE foodId = ?').run(recipe.foodId);
      db.prepare('DELETE FROM foods WHERE id = ?').run(recipe.foodId);
    }
    db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
  })();
  return true;
}
