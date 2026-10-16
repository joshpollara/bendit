import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addItem,
  createMealPlanTables,
  listPlan,
  logItem,
  plannedFor,
  removeItem,
  setChecked,
  shoppingList,
  updateItem,
} from './mealPlan.mjs';
import { createRecipeTables } from './recipeStore.mjs';
import { createUser, createUsersTable } from './users.mjs';

let db;
let ann;
let ben;

beforeEach(() => {
  db = new Database(':memory:');
  createUsersTable(db);
  createRecipeTables(db);
  createMealPlanTables(db);
  db.exec(`
    CREATE TABLE foods (id TEXT PRIMARY KEY, name TEXT, servingLabel TEXT, servingGrams REAL,
      caloriesPerServing REAL, protein REAL, carbs REAL, fat REAL);
    CREATE TABLE food_log (id TEXT PRIMARY KEY, date TEXT, meal TEXT, foodId TEXT, servings REAL,
      caloriesCached REAL, estimated INTEGER, planItemId TEXT, userId TEXT);
    INSERT INTO foods VALUES ('oats', 'Oats', '40 g', 40, 150, 5, 27, 3);
    INSERT INTO foods VALUES ('chili-1', 'Chili, 1 serving', '1 serving', 350, 500, 35, 40, 18);
    INSERT INTO foods VALUES ('beef', 'Ground beef', '100 g', 100, 250, 26, 0, 15);
    INSERT INTO foods VALUES ('beans', 'Kidney beans', '100 g', 100, 127, 9, 23, 0.5);
    INSERT INTO recipes (id, name, servings, foodId, createdBy, createdAt)
      VALUES ('chili', 'Chili', 4, 'chili-1', 'x', '2026-01-01');
    INSERT INTO recipe_ingredients (id, recipeId, position, raw, name, grams, foodId)
      VALUES ('i1', 'chili', 0, '500 g ground beef', 'ground beef', 500, 'beef'),
             ('i2', 'chili', 1, '400 g kidney beans', 'kidney beans', 400, 'beans'),
             ('i3', 'chili', 2, '1 tsp cumin', 'cumin', NULL, NULL),
             ('i4', 'chili', 3, '1 onion', 'onion', NULL, NULL),
             ('i5', 'chili', 4, '400 ml stock', 'stock', NULL, NULL);
    UPDATE recipe_ingredients SET quantity = 1, unit = 'tsp' WHERE id = 'i3';
    UPDATE recipe_ingredients SET quantity = 1 WHERE id = 'i4';
    UPDATE recipe_ingredients SET quantity = 400, unit = 'ml' WHERE id = 'i5';
  `);
  ann = createUser(db, 'ann', 'password-ann').id;
  ben = createUser(db, 'ben', 'password-ben').id;
});

const chiliFor = (portions, date = '2026-10-19') =>
  addItem(db, { date, meal: 'dinner', recipeId: 'chili', portions }, { userId: ann });

describe('the household meal plan', () => {
  it('is one plan, with each person’s servings', () => {
    chiliFor([
      { userId: ann, servings: 1 },
      { userId: ben, servings: 1.5 },
    ]);
    const [item] = listPlan(db, '2026-10-19', '2026-10-25');
    expect(item).toMatchObject({ name: 'Chili', meal: 'dinner', perServing: { calories: 500 } });
    expect(item.portions.map((p) => [p.username, p.servings])).toEqual([
      ['ann', 1],
      ['ben', 1.5],
    ]);
  });

  it('refuses a meal nobody is eating, and ignores people who do not exist', () => {
    expect(() => chiliFor([{ userId: 'nobody', servings: 1 }])).toThrow(/at least one person/);
    expect(() => chiliFor([{ userId: ann, servings: 0 }])).toThrow(/at least one person/);
  });

  it('shows each person only their own unlogged portions for the day', () => {
    chiliFor([
      { userId: ann, servings: 1 },
      { userId: ben, servings: 2 },
    ]);
    expect(plannedFor(db, ben, '2026-10-19')).toEqual([
      expect.objectContaining({ name: 'Chili', meal: 'dinner', servings: 2, calories: 1000 }),
    ]);
    expect(plannedFor(db, ann, '2026-10-20')).toEqual([]);
  });

  it('logs a portion into that person’s log once, and only theirs', () => {
    const item = chiliFor([
      { userId: ann, servings: 1 },
      { userId: ben, servings: 2 },
    ]);
    const entry = logItem(db, item.id, ben);
    expect(entry).toMatchObject({ userId: ben, foodId: 'chili-1', servings: 2, caloriesCached: 1000 });
    expect(logItem(db, item.id, ben).id).toBe(entry.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM food_log').get().n).toBe(1);

    expect(plannedFor(db, ben, '2026-10-19')).toEqual([]);
    expect(plannedFor(db, ann, '2026-10-19')).toHaveLength(1);
    expect(listPlan(db, '2026-10-19', '2026-10-19')[0].portions.find((p) => p.userId === ben).logged).toBe(true);
  });

  it('will not log for someone who has no portion', () => {
    const item = chiliFor([{ userId: ann, servings: 1 }]);
    expect(() => logItem(db, item.id, ben)).toThrow(/nothing planned/);
  });

  it('moves a meal and changes who eats it', () => {
    const item = chiliFor([{ userId: ann, servings: 1 }]);
    const moved = updateItem(db, item.id, { date: '2026-10-21', portions: [{ userId: ben, servings: 1 }] });
    expect(moved).toMatchObject({ date: '2026-10-21', meal: 'dinner' });
    expect(moved.portions.map((p) => p.username)).toEqual(['ben']);
  });

  it('removing a planned meal leaves what was already logged', () => {
    const item = chiliFor([{ userId: ann, servings: 1 }]);
    logItem(db, item.id, ann);
    removeItem(db, item.id);
    expect(listPlan(db, '2026-10-19', '2026-10-19')).toEqual([]);
    expect(db.prepare('SELECT planItemId FROM food_log').get().planItemId).toBeNull();
  });
});

describe('the shopping list', () => {
  it('scales a recipe’s ingredients by the servings planned against what it makes', () => {
    // 1 + 1 servings of a recipe that makes 4: half the ingredients.
    chiliFor([
      { userId: ann, servings: 1 },
      { userId: ben, servings: 1 },
    ]);
    const { items } = shoppingList(db, '2026-10-19', '2026-10-25');
    expect(items.map((i) => [i.name, i.grams, i.written])).toEqual([
      ['cumin', null, ['0.5 tsp']],
      ['ground beef', 250, []],
      ['kidney beans', 200, []],
      ['onion', null, ['1']],
      ['stock', 200, []],
    ]);
  });

  it('adds up the same food across meals, and lists plain foods by weight', () => {
    chiliFor([{ userId: ann, servings: 2 }], '2026-10-19');
    chiliFor([{ userId: ann, servings: 2 }], '2026-10-22');
    addItem(
      db,
      { date: '2026-10-20', meal: 'breakfast', foodId: 'oats', portions: [{ userId: ann, servings: 2 }] },
      { userId: ann },
    );
    const { items } = shoppingList(db, '2026-10-19', '2026-10-25');
    expect(items.find((i) => i.name === 'ground beef').grams).toBe(500);
    expect(items.find((i) => i.name === 'Oats')).toMatchObject({ grams: 80, usedIn: ['Oats'] });
  });

  it('leaves out what falls outside the dates', () => {
    chiliFor([{ userId: ann, servings: 1 }], '2026-10-30');
    expect(shoppingList(db, '2026-10-19', '2026-10-25').items).toEqual([]);
  });

  it('remembers what has been ticked off, for that list', () => {
    chiliFor([{ userId: ann, servings: 1 }]);
    const list = shoppingList(db, '2026-10-19', '2026-10-25');
    const beef = list.items.find((i) => i.name === 'ground beef');
    setChecked(db, { listKey: list.listKey, itemKey: beef.key, checked: true }, { userId: ben });
    expect(shoppingList(db, '2026-10-19', '2026-10-25').items.find((i) => i.key === beef.key).checked).toBe(true);
    expect(shoppingList(db, '2026-10-19', '2026-10-26').items.find((i) => i.key === beef.key).checked).toBe(false);
  });
});
