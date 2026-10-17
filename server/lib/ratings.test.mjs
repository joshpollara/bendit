import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMealPlanTables } from './mealPlan.mjs';
import { createRatingTables, householdTaste, rate, ratingsOf, toRate } from './ratings.mjs';
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
  createRatingTables(db);
  ann = createUser(db, 'ann', 'password-ann').id;
  ben = createUser(db, 'ben', 'password-ben').id;
  const recipe = db.prepare("INSERT INTO recipes (id, name, servings, createdBy, createdAt) VALUES (?, ?, 4, 'x', '2026-01-01')");
  recipe.run('curry', 'Curry');
  recipe.run('soup', 'Soup');
  recipe.run('stew', 'Stew');
  const item = db.prepare("INSERT INTO meal_plan_items (id, date, meal, foodId, recipeId, createdBy, createdAt) VALUES (?, ?, 'dinner', 'f', ?, 'x', 'x')");
  const portion = db.prepare('INSERT INTO meal_plan_portions VALUES (?, ?, 1)');
  // Ann had curry on the 15th and soup on the 16th; stew a week ago; Ben only the soup.
  item.run('i1', '2026-10-15', 'curry');
  item.run('i2', '2026-10-16', 'soup');
  item.run('i3', '2026-10-09', 'stew');
  portion.run('i1', ann);
  portion.run('i2', ann);
  portion.run('i3', ann);
  portion.run('i2', ben);
});

describe('ratings', () => {
  it('keeps one per person per recipe, the latest standing, and can be taken back', () => {
    rate(db, ann, 'curry', 1);
    rate(db, ann, 'curry', -1);
    rate(db, ben, 'curry', 1);
    expect(ratingsOf(db, 'curry', ann)).toEqual({
      likes: 1,
      dislikes: 1,
      yours: -1,
      people: [
        { username: 'ann', rating: -1 },
        { username: 'ben', rating: 1 },
      ],
    });
    rate(db, ann, 'curry', 0);
    expect(ratingsOf(db, 'curry', ann)).toMatchObject({ dislikes: 0, yours: 0 });
  });

  it('refuses a rating that is not one, or a recipe that is not there', () => {
    expect(() => rate(db, ann, 'curry', 5)).toThrow(/rating/);
    expect(() => rate(db, ann, 'nope', 1)).toThrow(/No such recipe/);
  });

  it("asks about recipes eaten from the plan in the last few days that haven't been rated", () => {
    expect(toRate(db, ann, '2026-10-17').map((r) => r.recipeId)).toEqual(['soup', 'curry']);
    rate(db, ann, 'soup', 1);
    expect(toRate(db, ann, '2026-10-17').map((r) => r.recipeId)).toEqual(['curry']);
    // Ben only had the soup.
    expect(toRate(db, ben, '2026-10-17').map((r) => r.recipeId)).toEqual(['soup']);
    // Not before it's eaten.
    expect(toRate(db, ann, '2026-10-14')).toEqual([]);
  });

  it("sums up the household's taste for a model", () => {
    rate(db, ann, 'curry', 1);
    rate(db, ben, 'curry', 1);
    rate(db, ann, 'soup', -1);
    rate(db, ann, 'stew', 1);
    rate(db, ben, 'stew', -1);
    expect(householdTaste(db)).toEqual({ liked: ['Curry'], disliked: ['Soup', 'Stew'] });
  });
});
