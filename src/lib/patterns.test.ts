import { describe, expect, it } from 'vitest';
import { findPatterns } from './patterns';
import type { DayTotals } from './report';

// 2026-01-05 is a Monday, so index 0 of any run starting there is a Monday.
const MONDAY = '2026-01-05';

function dates(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

interface DayOptions {
  exercise?: number;
  protein?: number;
  breakfast?: number;
}

function makeDays(
  count: number,
  intakeFor: (index: number, date: string) => number,
  options: (index: number) => DayOptions = () => ({}),
): DayTotals[] {
  return dates(MONDAY, count).map((date, i) => {
    const o = options(i);
    const food = intakeFor(i, date);
    return {
      date,
      food,
      exercise: o.exercise ?? 0,
      entries: food > 0 ? 1 : 0,
      protein: o.protein ?? 0,
      meals: o.breakfast === undefined ? {} : { breakfast: o.breakfast },
    };
  });
}

const isWeekend = (i: number) => i % 7 >= 5; // run starts on a Monday

describe('findPatterns — refuses to speak without evidence', () => {
  it('says nothing on a short log', () => {
    expect(findPatterns(makeDays(6, () => 2000))).toEqual([]);
  });

  it('says nothing when every day is the same', () => {
    expect(findPatterns(makeDays(60, () => 2000))).toEqual([]);
  });

  it('ignores a difference too small to act on', () => {
    // Weekends 40 calories higher: real, but not worth a sentence.
    const days = makeDays(56, (i) => (isWeekend(i) ? 2040 : 2000));
    expect(findPatterns(days).find((p) => p.id === 'weekend')).toBeUndefined();
  });

  it('ignores a large gap that is drowned in day-to-day scatter', () => {
    // Weekends average ~150 higher, but days swing by ±900 either way, so the
    // effect is well inside the noise.
    const swing = [900, -850, 800, -900, 870, -880, 830];
    const days = makeDays(56, (i) => (isWeekend(i) ? 2150 : 2000) + swing[i % 7]);
    expect(findPatterns(days).find((p) => p.id === 'weekend')).toBeUndefined();
  });

  it('needs both sides of a split to be populated', () => {
    // Every single day has exercise, so there is nothing to compare against.
    const days = makeDays(40, () => 2000, () => ({ exercise: 300 }));
    expect(findPatterns(days).find((p) => p.id === 'exercise')).toBeUndefined();
  });
});

describe('findPatterns — reports what is really there', () => {
  it('finds a consistent weekend effect', () => {
    const days = makeDays(56, (i) => (isWeekend(i) ? 2800 : 1900));
    const weekend = findPatterns(days).find((p) => p.id === 'weekend');
    expect(weekend).toBeDefined();
    expect(weekend!.text).toContain('900 calories higher');
    expect(weekend!.good).toBe(false);
  });

  it('names the single heaviest weekday', () => {
    // Fridays (index 4) are the blowout.
    const days = makeDays(70, (i) => (i % 7 === 4 ? 3200 : 2000));
    const worst = findPatterns(days).find((p) => p.id === 'weekday-high');
    expect(worst).toBeDefined();
    expect(worst!.text).toContain('Fridays');
  });

  it('compares training days against rest days', () => {
    const days = makeDays(40, (i) => (i % 2 === 0 ? 2600 : 2000), (i) =>
      i % 2 === 0 ? { exercise: 400 } : {},
    );
    const exercise = findPatterns(days).find((p) => p.id === 'exercise');
    expect(exercise).toBeDefined();
    expect(exercise!.text).toContain('more');
    expect(exercise!.good).toBe(false);
  });

  it('relates protein to total intake, splitting at the target', () => {
    const days = makeDays(40, (i) => (i % 2 === 0 ? 1800 : 2500), (i) => ({
      protein: i % 2 === 0 ? 160 : 90,
    }));
    const protein = findPatterns(days, 150).find((p) => p.id === 'protein');
    expect(protein).toBeDefined();
    expect(protein!.text).toContain('150 g');
    expect(protein!.text).toContain('lower');
    expect(protein!.good).toBe(true);
  });

  it('falls back to the median when no protein target is set', () => {
    const days = makeDays(40, (i) => (i % 2 === 0 ? 1800 : 2500), (i) => ({
      protein: i % 2 === 0 ? 160 : 90,
    }));
    expect(findPatterns(days).find((p) => p.id === 'protein')).toBeDefined();
  });

  it('spots skipped breakfasts', () => {
    const days = makeDays(40, (i) => (i % 2 === 0 ? 1900 : 2700), (i) =>
      i % 2 === 0 ? { breakfast: 400 } : {},
    );
    const breakfast = findPatterns(days).find((p) => p.id === 'breakfast');
    expect(breakfast).toBeDefined();
    expect(breakfast!.good).toBe(true);
  });

  it('quantifies the cost of the occasional blowout', () => {
    const days = makeDays(40, (i) => (i % 10 === 0 ? 4200 : 1900));
    const spikes = findPatterns(days).find((p) => p.id === 'spikes');
    expect(spikes).toBeDefined();
    expect(spikes!.text).toContain('one day in ten');
  });

  it('carries the sample size behind every claim', () => {
    const days = makeDays(56, (i) => (isWeekend(i) ? 2800 : 1900));
    const patterns = findPatterns(days);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      // Never fewer than the minimum group size — a single weekday legitimately
      // has fewer samples than a weekend-vs-weekday split.
      expect(pattern.sampleSize).toBeGreaterThanOrEqual(5);
    }
  });

  it('skips unlogged days rather than counting them as zero-calorie', () => {
    // Every third day unlogged. Averaging over the calendar would drag both
    // means down by a third; the reported figures must be the logged ones.
    const days = makeDays(60, (i) => (i % 3 === 0 ? 0 : isWeekend(i) ? 2800 : 1900));
    const weekend = findPatterns(days).find((p) => p.id === 'weekend');
    expect(weekend).toBeDefined();
    expect(weekend!.text).toContain('2800');
    expect(weekend!.text).toContain('1900');
  });
});
