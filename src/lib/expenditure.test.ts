import { describe, expect, it } from 'vitest';
import { budgetFromExpenditure, hasDrifted, measureExpenditure } from './expenditure';
import type { DayTotals, Point } from './report';

const dates = (from: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

/** A run of days at a fixed intake, with `skip` days left unlogged. */
function days(from: string, count: number, intake: number, skip: number[] = []): DayTotals[] {
  return dates(from, count).map((date, i) => ({
    date,
    food: skip.includes(i) ? 0 : intake,
    exercise: 0,
    entries: skip.includes(i) ? 0 : 1,
    protein: 0,
    meals: {},
  }));
}

/** A trend line falling (or rising) at a constant kg per day. */
function trend(from: string, count: number, startKg: number, perDay: number): Point[] {
  return dates(from, count).map((date, i) => ({ date, value: startKg + i * perDay }));
}

describe('measureExpenditure', () => {
  it('recovers a known expenditure from intake and weight change', () => {
    // Eat 2000/day for 28 days, lose exactly 2kg of trend weight.
    // Deficit = 2 × 7700 / 27 days = 570/day, so expenditure = 2570.
    const result = measureExpenditure(
      days('2026-01-01', 28, 2000),
      trend('2026-01-01', 28, 90, -2 / 27),
    );
    expect(result?.tdee).toBe(2570);
    expect(result?.loggedDays).toBe(28);
    expect(result?.coverage).toBe(1);
  });

  it('reads maintenance as intake when weight holds', () => {
    const result = measureExpenditure(
      days('2026-01-01', 28, 2400),
      trend('2026-01-01', 28, 80, 0),
    );
    expect(result?.tdee).toBe(2400);
  });

  it('reads a surplus when weight rises', () => {
    // Gaining 1kg over 27 days on 3000/day means burning less than eaten.
    const result = measureExpenditure(
      days('2026-01-01', 28, 3000),
      trend('2026-01-01', 28, 70, 1 / 27),
    );
    expect(result!.tdee).toBeLessThan(3000);
    expect(result!.tdee).toBeCloseTo(3000 - 7700 / 27, 0);
  });

  it('ignores logged exercise — weight change already counts it', () => {
    const withExercise = days('2026-01-01', 28, 2000).map((d) => ({ ...d, exercise: 500 }));
    const result = measureExpenditure(withExercise, trend('2026-01-01', 28, 90, -2 / 27));
    expect(result?.tdee).toBe(2570); // same as the no-exercise case
  });

  it('averages intake over logged days only, not the calendar', () => {
    // A quarter of the days unlogged; the logged ones all say 2000. Averaging
    // over the calendar would give 1500 and invent a deficit that never was.
    const skipped = [3, 7, 11, 15, 19, 23, 27];
    const result = measureExpenditure(
      days('2026-01-01', 28, 2000, skipped),
      trend('2026-01-01', 28, 90, 0),
    );
    expect(result?.meanIntake).toBe(2000);
    expect(result?.loggedDays).toBe(21);
    expect(result?.tdee).toBe(2000);
  });

  it('refuses at half coverage — unlogged days are unknown, not zero', () => {
    const everyOtherDay = Array.from({ length: 14 }, (_, i) => i * 2);
    expect(
      measureExpenditure(days('2026-01-01', 28, 2000, everyOtherDay), trend('2026-01-01', 28, 90, 0)),
    ).toBeUndefined();
  });

  it('refuses to answer without enough logged days', () => {
    expect(measureExpenditure(days('2026-01-01', 10, 2000), trend('2026-01-01', 10, 90, -0.05)))
      .toBeUndefined();
  });

  it('refuses when coverage is too thin to trust', () => {
    // 28 days but only 8 logged.
    const skipped = Array.from({ length: 20 }, (_, i) => i);
    expect(
      measureExpenditure(days('2026-01-01', 28, 2000, skipped), trend('2026-01-01', 28, 90, -0.05)),
    ).toBeUndefined();
  });

  it('refuses without a weight trend spanning the window', () => {
    expect(measureExpenditure(days('2026-01-01', 28, 2000), [])).toBeUndefined();
    expect(
      measureExpenditure(days('2026-01-01', 28, 2000), [{ date: '2026-01-01', value: 90 }]),
    ).toBeUndefined();
  });

  it('only looks at the recent window', () => {
    // Two months: the first at 3000/day, the last 28 days at 2000/day, weight
    // flat throughout the recent window.
    const older = days('2026-01-01', 30, 3000);
    const recent = days('2026-01-31', 28, 2000);
    const result = measureExpenditure(
      [...older, ...recent],
      trend('2026-01-01', 58, 90, 0),
    );
    expect(result?.meanIntake).toBe(2000);
    expect(result?.tdee).toBe(2000);
  });
});

describe('budgetFromExpenditure', () => {
  it('subtracts the daily deficit', () => {
    expect(budgetFromExpenditure(2570, 550, 1500)).toBe(2020);
  });

  it('never goes below the safety floor', () => {
    expect(budgetFromExpenditure(1800, 1000, 1500)).toBe(1500);
  });
});

describe('hasDrifted', () => {
  it('ignores small wobbles', () => {
    expect(hasDrifted(2500, 2560)).toBe(false);
  });

  it('flags a meaningful change in either direction', () => {
    expect(hasDrifted(2500, 2650)).toBe(true);
    expect(hasDrifted(2500, 2340)).toBe(true);
  });
});
