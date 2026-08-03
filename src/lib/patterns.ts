import type { DayTotals } from './report';

// Patterns in your own logging — plain statistics, no model, no guessing.
//
// The engineering problem here is not finding correlations; it's refusing to
// report the ones that aren't real. With a few dozen days and half a dozen
// comparisons, noise alone will hand you a "finding" most of the time. So every
// comparison has to clear three bars before it is allowed to speak:
//
//   1. enough days on both sides of the split,
//   2. a difference big enough to act on, and
//   3. a difference large relative to how much these days scatter — the effect
//      has to stand out from the day-to-day noise, not just exist.
//
// Anything that fails stays silent rather than padding the screen.

export interface Pattern {
  /** Stable identifier, handy for tests. */
  id: string;
  /** One plain sentence. */
  text: string;
  /** Positive when the pattern favours the user's goal. */
  good: boolean;
  /** Days behind the claim, shown so the reader can judge it. */
  sampleSize: number;
}

const MIN_GROUP = 5; // days on each side
const MIN_DIFFERENCE = 100; // kcal — smaller than this isn't worth a sentence
const MIN_EFFECT = 0.5; // difference in standard deviations (a "medium" effect)

const net = (d: DayTotals) => d.food - d.exercise;
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Compares two groups of days and returns the difference in mean net calories,
 * or undefined when the comparison can't be trusted.
 */
function compare(
  a: number[],
  b: number[],
): { difference: number; meanA: number; meanB: number } | undefined {
  if (a.length < MIN_GROUP || b.length < MIN_GROUP) return undefined;

  const meanA = mean(a);
  const meanB = mean(b);
  const difference = meanA - meanB;
  if (Math.abs(difference) < MIN_DIFFERENCE) return undefined;

  // Pooled spread: how much these days vary anyway.
  const spread = Math.sqrt((stdDev(a) ** 2 + stdDev(b) ** 2) / 2);
  if (spread > 0 && Math.abs(difference) / spread < MIN_EFFECT) return undefined;

  return { difference, meanA, meanB };
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** 0 = Monday. UTC so a timezone can't shift which day a date belongs to. */
function weekdayIndex(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

const round = (n: number) => Math.round(Math.abs(n));

export function findPatterns(days: DayTotals[], proteinTargetG?: number | null): Pattern[] {
  const logged = days.filter((d) => d.entries > 0);
  if (logged.length < MIN_GROUP * 2) return [];

  const patterns: Pattern[] = [];
  const all = logged.map(net);
  const overall = mean(all);

  // Weekends against weekdays.
  const weekend = logged.filter((d) => weekdayIndex(d.date) >= 5);
  const weekday = logged.filter((d) => weekdayIndex(d.date) < 5);
  const weekendResult = compare(weekend.map(net), weekday.map(net));
  if (weekendResult) {
    patterns.push({
      id: 'weekend',
      text: `Weekends run ${round(weekendResult.difference)} calories ${
        weekendResult.difference > 0 ? 'higher' : 'lower'
      } than weekdays — ${Math.round(weekendResult.meanA)} against ${Math.round(weekendResult.meanB)}.`,
      good: weekendResult.difference < 0,
      sampleSize: weekend.length + weekday.length,
    });
  }

  // The single day of the week that stands out most.
  const byWeekday = WEEKDAY_NAMES.map((name, index) => ({
    name,
    days: logged.filter((d) => weekdayIndex(d.date) === index),
  })).filter((group) => group.days.length >= MIN_GROUP);
  if (byWeekday.length >= 3) {
    const scored = byWeekday
      .map((group) => ({ ...group, average: mean(group.days.map(net)) }))
      .sort((a, b) => b.average - a.average);
    const highest = scored[0];
    const rest = logged.filter((d) => weekdayIndex(d.date) !== WEEKDAY_NAMES.indexOf(highest.name));
    const result = compare(highest.days.map(net), rest.map(net));
    if (result) {
      patterns.push({
        id: 'weekday-high',
        text: `${highest.name}s are your heaviest day, averaging ${Math.round(
          result.meanA,
        )} calories against ${Math.round(result.meanB)} on other days.`,
        good: false,
        sampleSize: highest.days.length,
      });
    }
  }

  // Days you exercised against days you didn't.
  const withExercise = logged.filter((d) => d.exercise > 0);
  const withoutExercise = logged.filter((d) => d.exercise === 0);
  const exerciseResult = compare(
    withExercise.map((d) => d.food),
    withoutExercise.map((d) => d.food),
  );
  if (exerciseResult) {
    patterns.push({
      id: 'exercise',
      text: `On days you train you eat ${round(exerciseResult.difference)} calories ${
        exerciseResult.difference > 0 ? 'more' : 'less'
      } — ${Math.round(exerciseResult.meanA)} against ${Math.round(exerciseResult.meanB)}.`,
      good: exerciseResult.difference < 0,
      sampleSize: withExercise.length + withoutExercise.length,
    });
  }

  // Protein against total intake, once there's protein data to compare.
  const withProtein = logged.filter((d) => d.protein > 0);
  if (withProtein.length >= MIN_GROUP * 2) {
    const threshold =
      proteinTargetG ??
      [...withProtein].map((d) => d.protein).sort((a, b) => a - b)[Math.floor(withProtein.length / 2)];
    const high = withProtein.filter((d) => d.protein >= threshold);
    const low = withProtein.filter((d) => d.protein < threshold);
    const proteinResult = compare(high.map(net), low.map(net));
    if (proteinResult) {
      patterns.push({
        id: 'protein',
        text: `Days above ${Math.round(threshold)} g of protein come in ${round(
          proteinResult.difference,
        )} calories ${proteinResult.difference > 0 ? 'higher' : 'lower'} overall.`,
        good: proteinResult.difference < 0,
        sampleSize: withProtein.length,
      });
    }
  }

  // Breakfast, or the lack of it.
  const withBreakfast = logged.filter((d) => (d.meals.breakfast ?? 0) > 0);
  const withoutBreakfast = logged.filter((d) => (d.meals.breakfast ?? 0) === 0);
  const breakfastResult = compare(withBreakfast.map(net), withoutBreakfast.map(net));
  if (breakfastResult) {
    patterns.push({
      id: 'breakfast',
      text: `Days that start with breakfast end ${round(breakfastResult.difference)} calories ${
        breakfastResult.difference > 0 ? 'higher' : 'lower'
      } than days that don't.`,
      good: breakfastResult.difference < 0,
      sampleSize: withBreakfast.length + withoutBreakfast.length,
    });
  }

  // How much a single heavy day costs, relative to a typical one.
  const sorted = [...all].sort((a, b) => b - a);
  const heaviest = sorted.slice(0, Math.max(1, Math.round(all.length * 0.1)));
  if (all.length >= 20 && mean(heaviest) - overall >= MIN_DIFFERENCE * 3) {
    patterns.push({
      id: 'spikes',
      text: `Your heaviest one day in ten averages ${Math.round(mean(heaviest))} calories — ${round(
        mean(heaviest) - overall,
      )} above a typical day.`,
      good: false,
      sampleSize: all.length,
    });
  }

  return patterns;
}
