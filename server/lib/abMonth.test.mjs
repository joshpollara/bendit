import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { abMonth, clearGoal, createAbTables, setGoal } from './abMonth.mjs';

let db;
beforeEach(() => {
  db = new Database(':memory:');
  createAbTables(db);
});

const GRADES = { apple: 'A', yoghurt: 'B', bread: 'C', biscuit: 'E' };
const gradeOf = (row) => GRADES[row.foodId] ?? null;
const row = (date, foodId, caloriesCached) => ({ date, foodId, caloriesCached });

describe('an A/B month', () => {
  it('is the share of graded calories from A and B foods, with how much was graded', () => {
    setGoal(db, 'ann', { month: '2026-10', target: 0.7 });
    const rows = [
      // 1 Oct: 300 of 400 graded calories are A/B; 100 more were ungraded.
      row('2026-10-01', 'apple', 100),
      row('2026-10-01', 'yoghurt', 200),
      row('2026-10-01', 'biscuit', 100),
      row('2026-10-01', 'estimate', 100),
      // 2 Oct: all A/B.
      row('2026-10-02', 'apple', 200),
    ];
    const month = abMonth(db, 'ann', '2026-10', { rows, gradeOf });
    expect(month.goal).toEqual({ target: 0.7 });
    expect(month.days).toEqual([
      { date: '2026-10-01', share: 0.75, covered: 0.8, calories: 500 },
      { date: '2026-10-02', share: 1, covered: 1, calories: 200 },
    ]);
    expect(month.total).toEqual({ share: 500 / 600, covered: 600 / 700, daysOnTarget: 2, daysLogged: 2 });
  });

  it('has no share for a day with nothing graded', () => {
    const month = abMonth(db, 'ann', '2026-10', { rows: [row('2026-10-03', 'estimate', 500)], gradeOf });
    expect(month.days[0]).toMatchObject({ share: null, covered: 0 });
    expect(month.goal).toBeNull();
    expect(month.total.daysOnTarget).toBeNull();
  });

  it('keeps one goal per person and month, and can drop it', () => {
    setGoal(db, 'ann', { month: '2026-10', target: 0.6 });
    setGoal(db, 'ann', { month: '2026-10', target: 0.8 });
    setGoal(db, 'ben', { month: '2026-10', target: 0.5 });
    expect(abMonth(db, 'ann', '2026-10', { rows: [], gradeOf }).goal).toEqual({ target: 0.8 });
    clearGoal(db, 'ann', '2026-10');
    expect(abMonth(db, 'ann', '2026-10', { rows: [], gradeOf }).goal).toBeNull();
    expect(abMonth(db, 'ben', '2026-10', { rows: [], gradeOf }).goal).toEqual({ target: 0.5 });
  });

  it('refuses a nonsense month or target', () => {
    expect(() => setGoal(db, 'ann', { month: '2026-13', target: 0.7 })).toThrow(/month/);
    expect(() => setGoal(db, 'ann', { month: '2026-10', target: 7 })).toThrow(/target/);
  });
});
