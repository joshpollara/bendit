import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  daysToGoal,
  fillDays,
  mealAverages,
  ratePerWeek,
  summarize,
  trendSeries,
  weekStart,
  weeklyRollups,
  type DayTotals,
} from './report';

// Consecutive real dates, so gap maths in the code under test sees true gaps.
const dates = (from: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

const day = (date: string, food: number, exercise = 0, meals: DayTotals['meals'] = {}): DayTotals => ({
  date,
  food,
  exercise,
  entries: food > 0 ? 1 : 0,
  meals,
});

describe('daysBetween', () => {
  it('counts calendar days', () => {
    expect(daysBetween('2026-01-01', '2026-01-08')).toBe(7);
    expect(daysBetween('2026-01-08', '2026-01-01')).toBe(-7);
  });

  it('is unaffected by daylight saving shifts', () => {
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });
});

describe('trendSeries', () => {
  it('starts at the first reading', () => {
    expect(trendSeries([{ date: '2026-01-01', value: 90 }])[0].value).toBe(90);
  });

  it('smooths a one-day spike far more than the reading itself moved', () => {
    const flat = dates('2026-01-01', 10).map((date) => ({ date, value: 90 }));
    const spiked = [...flat, { date: '2026-01-11', value: 92 }];
    const trend = trendSeries(spiked);
    const last = trend[trend.length - 1].value;
    expect(last).toBeGreaterThan(90);
    expect(last).toBeLessThan(90.2); // 2kg jump moves the trend under 200g
  });

  it('converges toward a sustained new weight', () => {
    const points = dates('2026-01-01', 60).map((date) => ({ date, value: 85 }));
    const trend = trendSeries([{ date: '2025-12-31', value: 90 }, ...points]);
    // 60 days is 6 half-lives, so the initial 5kg gap is down to 5/2^6.
    expect(trend[trend.length - 1].value).toBeCloseTo(85 + 5 / 64, 4);
  });

  it('compounds smoothing across gaps so it does not lag after a break', () => {
    const daily = trendSeries(
      dates('2026-01-01', 15).map((date, i) => ({ date, value: i === 0 ? 90 : 88 })),
    );
    const gapped = trendSeries([
      { date: '2026-01-01', value: 90 },
      { date: '2026-01-15', value: 88 },
    ]);
    const end = (s: { value: number }[]) => s[s.length - 1].value;
    expect(end(gapped)).toBeCloseTo(end(daily), 1);
  });
});

describe('ratePerWeek', () => {
  it('reads a steady loss as a weekly rate', () => {
    const points = dates('2026-01-01', 15).map((date, i) => ({ date, value: 90 - i * 0.1 })); // 0.7 kg/week
    expect(ratePerWeek(points)).toBeCloseTo(-0.7, 5);
  });

  it('only fits the recent window', () => {
    const older = dates('2026-01-01', 30).map((date) => ({ date, value: 90 })); // flat January
    const recent = dates('2026-02-01', 14).map((date, i) => ({ date, value: 90 - i * 0.1 }));
    expect(ratePerWeek([...older, ...recent], 13)).toBeCloseTo(-0.7, 5);
  });

  it('returns undefined without enough points', () => {
    expect(ratePerWeek([{ date: '2026-01-01', value: 90 }])).toBeUndefined();
    expect(ratePerWeek([])).toBeUndefined();
  });
});

describe('daysToGoal', () => {
  it('projects a reachable goal', () => {
    expect(daysToGoal(90, 88, -0.5)).toBe(28);
  });

  it('is undefined when moving away from the goal or standing still', () => {
    expect(daysToGoal(90, 88, 0.5)).toBeUndefined();
    expect(daysToGoal(90, 88, 0)).toBeUndefined();
    expect(daysToGoal(90, 88, undefined)).toBeUndefined();
  });

  it('is zero when already there', () => {
    expect(daysToGoal(88, 88, -0.5)).toBe(0);
  });
});

describe('summarize', () => {
  const budget = () => 2000;

  it('averages over logged days only', () => {
    const days = [day('2026-01-01', 1800), day('2026-01-02', 0), day('2026-01-03', 2200)];
    const s = summarize(days, budget);
    expect(s.loggedDays).toBe(2);
    expect(s.totalDays).toBe(3);
    expect(s.avgFood).toBe(2000);
    expect(s.avgVsBudget).toBe(0);
  });

  it('nets exercise out of intake', () => {
    const s = summarize([day('2026-01-01', 2300, 300)], budget);
    expect(s.avgNet).toBe(2000);
    expect(s.avgVsBudget).toBe(0);
    expect(s.daysUnder).toBe(1);
  });

  it('counts days over budget and totals the surplus', () => {
    const s = summarize([day('2026-01-01', 2500), day('2026-01-02', 1700)], budget);
    expect(s.daysOver).toBe(1);
    expect(s.daysUnder).toBe(1);
    expect(s.totalVsBudget).toBe(200);
  });

  it('handles an empty range without dividing by zero', () => {
    const s = summarize([], budget);
    expect(s.avgFood).toBe(0);
    expect(s.avgVsBudget).toBe(0);
  });
});

describe('weekStart', () => {
  it('snaps to Monday', () => {
    expect(weekStart('2026-08-03')).toBe('2026-08-03'); // a Monday
    expect(weekStart('2026-08-09')).toBe('2026-08-03'); // the Sunday after
    expect(weekStart('2026-08-10')).toBe('2026-08-10'); // next Monday
  });
});

describe('weeklyRollups', () => {
  it('groups by week and reports the trend change between weeks', () => {
    const days = [
      day('2026-08-03', 2000),
      day('2026-08-04', 2200),
      day('2026-08-10', 1800),
    ];
    const trend = [
      { date: '2026-08-04', value: 90 },
      { date: '2026-08-10', value: 89.4 },
    ];
    const weeks = weeklyRollups(days, () => 2000, trend);
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-08-03', '2026-08-10']);
    expect(weeks[0].avgFood).toBe(2100);
    expect(weeks[0].trendChange).toBeUndefined();
    expect(weeks[1].trendWeight).toBe(89.4);
    expect(weeks[1].trendChange).toBeCloseTo(-0.6, 5);
  });
});

describe('mealAverages', () => {
  it('averages each meal across logged days', () => {
    const days = [
      day('2026-01-01', 700, 0, { breakfast: 300, lunch: 400 }),
      day('2026-01-02', 500, 0, { lunch: 500 }),
      day('2026-01-03', 0),
    ];
    const avgs = Object.fromEntries(mealAverages(days).map((m) => [m.meal, m.average]));
    expect(avgs.breakfast).toBe(150);
    expect(avgs.lunch).toBe(450);
    expect(avgs.dinner).toBe(0);
  });
});

describe('fillDays', () => {
  it('inserts empty days for dates with no data', () => {
    const filled = fillDays([day('2026-01-03', 1800)], '2026-01-01', '2026-01-04');
    expect(filled).toHaveLength(4);
    expect(filled.map((d) => d.food)).toEqual([0, 0, 1800, 0]);
    expect(filled[0].entries).toBe(0);
  });
});
