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
import { foodGrade, gradeMeal } from './nutriScore.mjs';

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
  const columns = new Set(db.prepare('PRAGMA table_info(recipes)').all().map((c) => c.name));
  // What the recipe's page says one serving comes to, as JSON, and whether the
  // recipe's food takes its nutrition from that ('page') or its ingredients.
  if (!columns.has('sourceNutrition')) db.exec('ALTER TABLE recipes ADD COLUMN sourceNutrition TEXT');
  if (!columns.has('nutritionFrom')) db.exec('ALTER TABLE recipes ADD COLUMN nutritionFrom TEXT');
  // The recipe page's photo, linked rather than copied.
  if (!columns.has('imageUrl')) db.exec('ALTER TABLE recipes ADD COLUMN imageUrl TEXT');
}

const cleanImage = (url) => (typeof url === 'string' && /^https?:\/\//.test(url) ? url.slice(0, 2000) : null);

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** A page's stated nutrition as sent back by the client, kept only if it has calories. */
function cleanSourceNutrition(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const key of ['servings', 'calories', 'protein', 'carbs', 'fat', 'satFat', 'sugar', 'fiber', 'sodiumMg']) {
    out[key] = num(input[key]);
  }
  return out.calories ? out : null;
}

/**
 * One serving's nutrition by the page's figures, for a recipe that makes
 * `makes`: the page's serving is of its own yield, so making more per batch
 * means smaller servings.
 */
export function pageServing(source, makes) {
  const scale = source.servings > 0 && makes > 0 ? source.servings / makes : 1;
  const per = (value) => (value == null ? null : Math.round(value * scale * 10) / 10);
  return {
    calories: Math.round(source.calories * scale),
    protein: per(source.protein),
    carbs: per(source.carbs),
    fat: per(source.fat),
    satFat: per(source.satFat),
    sugar: per(source.sugar),
    fiber: per(source.fiber),
    sodiumMg: source.sodiumMg == null ? null : Math.round(source.sodiumMg * scale),
  };
}

const newId = () => crypto.randomUUID();

/** Under this share of a recipe's weight graded, its grade would say little. */
const MIN_GRADED = 0.5;

/**
 * A recipe's Nutri-Score: from its own food when that has full figures (a
 * page's nutrition, fully weighed), else from its ingredients weighted by
 * weight, as a meal is — when at least half the weight could be graded.
 */
export function recipeGrade(db, recipe, ingredients) {
  const food = recipe.foodId ? db.prepare('SELECT * FROM foods WHERE id = ?').get(recipe.foodId) : null;
  const own = foodGrade(food);
  if (own) return { grade: own, covered: 1, from: 'page' };
  const foodOf = db.prepare('SELECT * FROM foods WHERE id = ?');
  const items = ingredients
    .filter((i) => i.grams > 0)
    .map((i) => ({ grams: i.grams, grade: i.foodId ? foodGrade(foodOf.get(i.foodId)) : null }));
  const graded = gradeMeal(items);
  return graded && graded.covered >= MIN_GRADED ? { grade: graded.grade, covered: graded.covered, from: 'ingredients' } : null;
}

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

  let sourceNutrition = null;
  try {
    sourceNutrition = recipe.sourceNutrition ? JSON.parse(recipe.sourceNutrition) : null;
  } catch {
    // An unreadable value is as good as none.
  }
  return {
    ...recipe,
    sourceNutrition,
    nutritionFrom: recipe.nutritionFrom ?? 'ingredients',
    servingsStated: recipe.servingsStated === 1,
    author: author?.username ?? null,
    ingredients,
    food,
    total: { grams: Math.round(total.grams), calories: Math.round(total.calories) },
    grade: recipeGrade(db, recipe, ingredients),
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
  const sourceNutrition = cleanSourceNutrition(input.sourceNutrition);
  const nutritionFrom = input.nutritionFrom === 'page' && sourceNutrition ? 'page' : 'ingredients';
  const food = recipeFood(built, {
    id: foodId,
    name: input.name,
    ownerId: null,
    declared: nutritionFrom === 'page' ? pageServing(sourceNutrition, built.servings) : null,
  });

  db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO recipes
         (id, name, servings, servingsStated, sourceType, sourceUrl, instructions, notes,
          foodId, createdBy, createdAt, updatedAt, sourceNutrition, nutritionFrom, imageUrl)
       VALUES (@id, @name, @servings, @servingsStated, @sourceType, @sourceUrl, @instructions,
               @notes, @foodId, @createdBy, @createdAt, @updatedAt, @sourceNutrition, @nutritionFrom, @imageUrl)`,
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
      sourceNutrition: sourceNutrition ? JSON.stringify(sourceNutrition) : null,
      nutritionFrom,
      // An edit that doesn't mention the photo keeps it.
      imageUrl: input.imageUrl !== undefined ? cleanImage(input.imageUrl) : (existing?.imageUrl ?? null),
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
