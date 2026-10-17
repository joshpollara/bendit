import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRecipeTables, recipeGrade } from './recipeStore.mjs';

let db;
beforeEach(() => {
  db = new Database(':memory:');
  createRecipeTables(db);
  db.exec(`CREATE TABLE foods (id TEXT PRIMARY KEY, name TEXT, nutriGrade TEXT, basis TEXT, kcal100 REAL,
    sugar100 REAL, satFat100 REAL, sodiumMg100 REAL, fiber100 REAL, protein100 REAL, fruitVeg REAL)`);
  const food = db.prepare('INSERT INTO foods VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)');
  // Lentils: A. Bacon: E. A recipe's own food with no detail: no grade of its own.
  food.run('lentils', 'Lentils', 'g', 116, 1.8, 0.1, 2, 7.9, 9);
  food.run('bacon', 'Bacon', 'g', 541, 0, 14, 1717, 0, 37);
  food.run('recipe-food', 'Soup, 1 serving', 'g', 120, null, null, null, null, null);
  // A page's figures, fully weighed: graded from those.
  food.run('page-food', 'Salad, 1 serving', 'g', 60, 3, 0.5, 100, 3, 3);
});

const recipe = (foodId) => ({ id: 'r', foodId });
const ing = (foodId, grams) => ({ foodId, grams });

describe("a recipe's grade", () => {
  it("is its food's own when the page's figures give one", () => {
    expect(recipeGrade(db, recipe('page-food'), [ing('bacon', 500)])).toEqual({ grade: 'A', covered: 1, from: 'page' });
  });

  it('is its ingredients weighted by weight otherwise', () => {
    expect(recipeGrade(db, recipe('recipe-food'), [ing('lentils', 400), ing('bacon', 50)])).toMatchObject({
      grade: 'A',
      from: 'ingredients',
    });
    expect(recipeGrade(db, recipe('recipe-food'), [ing('lentils', 100), ing('bacon', 300)])).toMatchObject({
      grade: 'D',
    });
  });

  it('is nothing when under half of it could be graded', () => {
    expect(recipeGrade(db, recipe('recipe-food'), [ing('lentils', 100), ing(null, 300)])).toBeNull();
  });
});
