// The household's meal plan.
//
// One plan for the whole installation: a planned meal is a food (often a
// recipe's one-serving food) on a date and at a meal, shared by everyone. Who
// eats it, and how much, is per person — each portion belongs to a user, so
// each person's planned day can be measured against their own targets, and
// the shopping list covers everyone's portions together.
//
// Planning is not eating. A portion reaches someone's food log only when they
// log it, and the log entry remembers which planned meal it came from.

import crypto from 'node:crypto';
import { foodGrade } from './nutriScore.mjs';
import { recipeGrade } from './recipeStore.mjs';

export function createMealPlanTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meal_plan_items (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      meal TEXT NOT NULL,
      foodId TEXT NOT NULL,
      -- Set when the food is a recipe's, so shopping can list its ingredients.
      recipeId TEXT,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meal_plan_date ON meal_plan_items(date);
    CREATE TABLE IF NOT EXISTS meal_plan_portions (
      itemId TEXT NOT NULL,
      userId TEXT NOT NULL,
      servings REAL NOT NULL,
      PRIMARY KEY (itemId, userId)
    );
    CREATE TABLE IF NOT EXISTS shopping_checks (
      listKey TEXT NOT NULL,
      itemKey TEXT NOT NULL,
      checkedBy TEXT NOT NULL,
      checkedAt TEXT NOT NULL,
      PRIMARY KEY (listKey, itemKey)
    );
  `);
}

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export class PlanError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Portions as sent: [{ userId, servings }], keeping only real users and positive amounts. */
function cleanPortions(db, portions) {
  if (!Array.isArray(portions)) throw new PlanError('portions must be a list');
  const known = new Set(db.prepare('SELECT id FROM users').all().map((u) => u.id));
  const out = new Map();
  for (const p of portions) {
    const servings = Number(p?.servings);
    if (known.has(p?.userId) && Number.isFinite(servings) && servings > 0 && servings <= 50) {
      out.set(p.userId, Math.round(servings * 100) / 100);
    }
  }
  if (out.size === 0) throw new PlanError('at least one person must be eating it');
  return out;
}

function writePortions(db, itemId, portions) {
  db.prepare('DELETE FROM meal_plan_portions WHERE itemId = ?').run(itemId);
  const insert = db.prepare('INSERT INTO meal_plan_portions (itemId, userId, servings) VALUES (?, ?, ?)');
  for (const [userId, servings] of portions) insert.run(itemId, userId, servings);
}

/** What a planned meal is, from the food behind it. Macros are per serving. */
const ITEM_SELECT = `
  SELECT i.*, f.name, f.servingLabel, f.servingGrams, f.caloriesPerServing,
         f.protein, f.carbs, f.fat, r.name AS recipeName
  FROM meal_plan_items i
  JOIN foods f ON f.id = i.foodId
  LEFT JOIN recipes r ON r.id = i.recipeId`;

/** A planned meal's Nutri-Score: its recipe's, or its food's. */
function gradeOfItem(db, row) {
  if (row.recipeId) {
    const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(row.recipeId);
    const ingredients = db.prepare('SELECT * FROM recipe_ingredients WHERE recipeId = ?').all(row.recipeId);
    return recipe ? (recipeGrade(db, recipe, ingredients)?.grade ?? null) : null;
  }
  return foodGrade(db.prepare('SELECT * FROM foods WHERE id = ?').get(row.foodId));
}

function shapeItem(db, row) {
  const portions = db
    .prepare(
      `SELECT p.userId, p.servings, u.username,
              EXISTS (SELECT 1 FROM food_log l WHERE l.planItemId = p.itemId AND l.userId = p.userId) AS logged
       FROM meal_plan_portions p JOIN users u ON u.id = p.userId
       WHERE p.itemId = ? ORDER BY u.createdAt`,
    )
    .all(row.id)
    .map((p) => ({ ...p, logged: p.logged === 1 }));
  return {
    id: row.id,
    date: row.date,
    meal: row.meal,
    foodId: row.foodId,
    recipeId: row.recipeId,
    name: row.recipeName ?? row.name,
    servingLabel: row.servingLabel,
    grade: gradeOfItem(db, row),
    perServing: {
      calories: row.caloriesPerServing,
      protein: row.protein,
      carbs: row.carbs,
      fat: row.fat,
    },
    portions,
  };
}

export function listPlan(db, from, to) {
  if (!isDate(from) || !isDate(to)) throw new PlanError('from and to must be dates');
  return db
    .prepare(`${ITEM_SELECT} WHERE i.date BETWEEN ? AND ? ORDER BY i.date, i.createdAt`)
    .all(from, to)
    .map((row) => shapeItem(db, row));
}

export function readItem(db, id) {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id);
  return row ? shapeItem(db, row) : null;
}

/** Plans a food or a recipe. A recipe is planned as its one-serving food. */
export function addItem(db, { date, meal, foodId, recipeId, portions }, { userId }) {
  if (!isDate(date)) throw new PlanError('date must be YYYY-MM-DD');
  if (!MEALS.includes(meal)) throw new PlanError('meal must be breakfast, lunch, dinner or snacks');
  let food = foodId;
  if (recipeId) {
    const recipe = db.prepare('SELECT foodId FROM recipes WHERE id = ?').get(recipeId);
    if (!recipe?.foodId) throw new PlanError('no such recipe', 404);
    food = recipe.foodId;
  }
  if (!food || !db.prepare('SELECT 1 FROM foods WHERE id = ?').get(food)) {
    throw new PlanError('no such food', 404);
  }
  const cleaned = cleanPortions(db, portions);
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO meal_plan_items (id, date, meal, foodId, recipeId, createdBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, date, meal, food, recipeId ?? null, userId, new Date().toISOString());
    writePortions(db, id, cleaned);
  })();
  return readItem(db, id);
}

/** Moves a planned meal, or changes who is eating how much. Anyone in the household can. */
export function updateItem(db, id, { date, meal, portions }) {
  const item = db.prepare('SELECT * FROM meal_plan_items WHERE id = ?').get(id);
  if (!item) throw new PlanError('not found', 404);
  if (date !== undefined && !isDate(date)) throw new PlanError('date must be YYYY-MM-DD');
  if (meal !== undefined && !MEALS.includes(meal)) throw new PlanError('unknown meal');
  const cleaned = portions === undefined ? null : cleanPortions(db, portions);
  db.transaction(() => {
    db.prepare('UPDATE meal_plan_items SET date = ?, meal = ? WHERE id = ?').run(
      date ?? item.date,
      meal ?? item.meal,
      id,
    );
    if (cleaned) writePortions(db, id, cleaned);
  })();
  return readItem(db, id);
}

export function removeItem(db, id) {
  db.transaction(() => {
    db.prepare('DELETE FROM meal_plan_portions WHERE itemId = ?').run(id);
    db.prepare('DELETE FROM meal_plan_items WHERE id = ?').run(id);
    // Entries already logged from it stay logged; they just stop pointing here.
    db.prepare('UPDATE food_log SET planItemId = NULL WHERE planItemId = ?').run(id);
  })();
}

/** This person's planned portions for a day that they haven't logged yet. */
export function plannedFor(db, userId, date) {
  return db
    .prepare(
      `${ITEM_SELECT} JOIN meal_plan_portions p ON p.itemId = i.id AND p.userId = ?
       WHERE i.date = ?
         AND NOT EXISTS (SELECT 1 FROM food_log l WHERE l.planItemId = i.id AND l.userId = ?)
       ORDER BY i.createdAt`,
    )
    .all(userId, date, userId)
    .map((row) => {
      const servings = db
        .prepare('SELECT servings FROM meal_plan_portions WHERE itemId = ? AND userId = ?')
        .get(row.id, userId).servings;
      return {
        itemId: row.id,
        meal: row.meal,
        name: row.recipeName ?? row.name,
        foodId: row.foodId,
        servings,
        servingLabel: row.servingLabel,
        calories: Math.round((row.caloriesPerServing ?? 0) * servings),
      };
    });
}

/**
 * Logs this person's portion of a planned meal, once. Returns the entry, or
 * the existing one when it was already logged.
 */
export function logItem(db, id, userId) {
  const existing = db.prepare('SELECT * FROM food_log WHERE planItemId = ? AND userId = ?').get(id, userId);
  if (existing) return existing;
  const row = db
    .prepare(
      `SELECT i.date, i.meal, i.foodId, p.servings, f.caloriesPerServing
       FROM meal_plan_items i
       JOIN meal_plan_portions p ON p.itemId = i.id AND p.userId = ?
       JOIN foods f ON f.id = i.foodId
       WHERE i.id = ?`,
    )
    .get(userId, id);
  if (!row) throw new PlanError('nothing planned for you there', 404);
  const entry = {
    id: crypto.randomUUID(),
    date: row.date,
    meal: row.meal,
    foodId: row.foodId,
    servings: row.servings,
    caloriesCached: Math.round(row.caloriesPerServing * row.servings),
    planItemId: id,
    userId,
  };
  db.prepare(
    `INSERT INTO food_log (id, date, meal, foodId, servings, caloriesCached, estimated, planItemId, userId)
     VALUES (@id, @date, @meal, @foodId, @servings, @caloriesCached, 0, @planItemId, @userId)`,
  ).run(entry);
  return entry;
}

const round = (n) => Math.round(n);

/** Units that are already a weight (or a volume, counted like one): grams per unit. */
const METRIC = { g: 1, gr: 1, gram: 1, grams: 1, kg: 1000, ml: 1, l: 1000, liter: 1000, litre: 1000 };
/** An ingredient's weight: resolved grams, or a quantity written in a metric unit. */
export const gramsOf = (ing) =>
  ing.grams ?? (ing.quantity != null && METRIC[String(ing.unit ?? '').toLowerCase()] ? ing.quantity * METRIC[ing.unit.toLowerCase()] : null);
export const keyFor = (foodId, name) => (foodId ? `food:${foodId}` : `name:${String(name).trim().toLowerCase()}`);

/** Adds amounts to the lines of a list, one line per food, in grams where known. */
const lineAdder = (lines) => (key, name, { grams = null, written = null, usedIn }) => {
  const line = lines.get(key) ?? { key, name, grams: 0, written: [], usedIn: [] };
  if (grams != null) line.grams += grams;
  if (written) line.written.push(written);
  if (!line.usedIn.includes(usedIn)) line.usedIn.push(usedIn);
  lines.set(key, line);
};

/** A recipe's ingredients, scaled by `factor`, onto a list. */
function addRecipe(db, add, recipeId, factor, usedIn) {
  const ingredients = db.prepare('SELECT * FROM recipe_ingredients WHERE recipeId = ? ORDER BY position').all(recipeId);
  for (const ing of ingredients) {
    const name = ing.name ?? ing.raw;
    const grams = gramsOf(ing);
    const written =
      grams == null
        ? ing.quantity != null
          ? ing.unit
            ? `${Math.round(ing.quantity * factor * 10) / 10} ${ing.unit}`
            : // A count of whole things: nobody buys 0.6 of an onion.
              `${Math.ceil(ing.quantity * factor - 1e-9)}`
          : ing.raw
        : null;
    add(keyFor(ing.foodId, name), name, { grams: grams != null ? grams * factor : null, written, usedIn });
  }
}

const finished = (line) => ({ ...line, grams: line.grams > 0 ? round(line.grams) : null });

/**
 * What one recipe needs bought for some number of servings: the same lines,
 * with the same keys, as the plan's list, so a product picked for a line in
 * one is picked in the other.
 */
export function recipeShoppingList(db, recipeId, servings) {
  const recipe = db.prepare('SELECT id, name, servings FROM recipes WHERE id = ?').get(recipeId);
  if (!recipe) throw new PlanError('No such recipe.', 404);
  const makes = Number(servings) > 0 && Number(servings) <= 100 ? Number(servings) : recipe.servings;
  const lines = new Map();
  addRecipe(db, lineAdder(lines), recipe.id, recipe.servings > 0 ? makes / recipe.servings : 1, recipe.name);
  const staples = staplesOf(db, recipe.id);
  return {
    listKey: `recipe:${recipe.id}`,
    recipe: { id: recipe.id, name: recipe.name, servings: makes },
    items: [...lines.values()].map((line) => ({ ...finished(line), checked: false, staple: staples.has(line.key) })),
  };
}

const SPOONS = /^(tsp|tbsp|teaspoons?|tablespoons?|pinch(es)?|dash(es)?|sprigs?)$/i;
const ALWAYS_IN = /^(water|salt|pepper|black pepper|salt and pepper|kosher salt|sea salt|ice|cooking spray)$/i;

/**
 * Lines that are probably already in the cupboard: only ever a spoonful or a
 * pinch, "to taste", or water and salt. They start as "have it"; a tap buys them.
 */
function staplesOf(db, recipeId) {
  const units = new Map();
  for (const ing of db.prepare('SELECT * FROM recipe_ingredients WHERE recipeId = ?').all(recipeId)) {
    const name = ing.name ?? ing.raw;
    const key = keyFor(ing.foodId, name);
    const staple =
      ALWAYS_IN.test(String(name).trim()) ||
      /\b(to taste|spray)\b/i.test(ing.raw) ||
      (ing.unit != null && SPOONS.test(String(ing.unit).trim()));
    units.set(key, (units.get(key) ?? true) && staple);
  }
  return new Set([...units].filter(([, staple]) => staple).map(([key]) => key));
}

/**
 * Everything the plan needs bought between two dates, for everyone eating.
 *
 * A recipe contributes its ingredients, scaled by how many servings of it are
 * planned against how many it makes. A plain food contributes itself. Lines
 * for the same food are added up in grams where both are known in grams;
 * anything that couldn't be weighed is listed as written.
 */
export function shoppingList(db, from, to) {
  if (!isDate(from) || !isDate(to)) throw new PlanError('from and to must be dates');
  const items = db
    .prepare(
      `SELECT i.id, i.foodId, i.recipeId, f.name, f.servingGrams, f.servingLabel,
              r.name AS recipeName, r.servings AS recipeServings,
              (SELECT SUM(servings) FROM meal_plan_portions p WHERE p.itemId = i.id) AS planned
       FROM meal_plan_items i JOIN foods f ON f.id = i.foodId LEFT JOIN recipes r ON r.id = i.recipeId
       WHERE i.date BETWEEN ? AND ?`,
    )
    .all(from, to);

  const lines = new Map();
  const add = lineAdder(lines);

  for (const item of items) {
    const planned = item.planned ?? 0;
    if (planned <= 0) continue;
    if (item.recipeId && item.recipeServings > 0) {
      addRecipe(db, add, item.recipeId, planned / item.recipeServings, item.recipeName);
    } else {
      add(keyFor(item.foodId, item.name), item.name, {
        grams: item.servingGrams ? item.servingGrams * planned : null,
        written: item.servingGrams ? null : `${planned} × ${item.servingLabel}`,
        usedIn: item.name,
      });
    }
  }

  const listKey = `${from}..${to}`;
  const checked = new Set(
    db.prepare('SELECT itemKey FROM shopping_checks WHERE listKey = ?').all(listKey).map((r) => r.itemKey),
  );
  return {
    listKey,
    items: [...lines.values()]
      .map((line) => ({ ...finished(line), checked: checked.has(line.key) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function setChecked(db, { listKey, itemKey, checked }, { userId }) {
  if (!listKey || !itemKey) throw new PlanError('listKey and itemKey are required');
  if (checked) {
    db.prepare(
      `INSERT OR REPLACE INTO shopping_checks (listKey, itemKey, checkedBy, checkedAt) VALUES (?, ?, ?, ?)`,
    ).run(listKey, itemKey, userId, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM shopping_checks WHERE listKey = ? AND itemKey = ?').run(listKey, itemKey);
  }
}
