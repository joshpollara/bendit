import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAssistantTools } from './assistantTools.mjs';

let tools;
beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE foods (id TEXT PRIMARY KEY, name TEXT, brand TEXT, basis TEXT, kcal100 REAL, sugar100 REAL,
      satFat100 REAL, sodiumMg100 REAL, fiber100 REAL, protein100 REAL, fruitVeg INTEGER, nutriGrade TEXT, nova INTEGER);
    INSERT INTO foods VALUES ('cheddar', 'Cheddar', NULL, 'g', 403, 0.5, 19, 650, 0, 25, NULL, NULL, 3);
    INSERT INTO foods VALUES ('muesli', 'Muesli', 'Brand', 'g', 380, 12, 1, 10, 9, 10, NULL, 'A', NULL);
    INSERT INTO foods VALUES ('mystery', 'Mystery', NULL, 'g', 200, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  `);
  tools = createAssistantTools({ db, picnic: { status: () => ({ connected: false }) }, userId: 'u1' }).tools;
});

describe('food_score', () => {
  it('works a grade out from the nutrients, with the points that make it', () => {
    const score = tools.food_score.run({ foodId: 'cheddar' });
    expect(score).toMatchObject({
      nutriScore: 'E',
      from: 'worked out from its nutrients',
      processing: 'NOVA 3, processed',
    });
    expect(score.pointsAgainst.saturatedFat).toBe(10);
    expect(score.pointsFor.protein).toBe(0);
    expect(score.per100g.saltG).toBe(1.6);
  });

  it("gives the maker's own grade where there is one", () => {
    expect(tools.food_score.run({ foodId: 'muesli' })).toMatchObject({
      nutriScore: 'A',
      from: 'published by the maker',
    });
  });

  it('says why there is no grade, and when there is no such food', () => {
    expect(tools.food_score.run({ foodId: 'mystery' })).toMatchObject({ nutriScore: null, why: expect.any(String) });
    expect(() => tools.food_score.run({ foodId: 'nope' })).toThrow(/search_foods/);
  });
});
