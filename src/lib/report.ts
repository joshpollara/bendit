import type { Meal } from "../types";

// Pure reporting math: trend weight, weekly rollups, and the projections built
// on them. No I/O, no dates from the environment.

export interface DayTotals {
  date: string;
  food: number;
  exercise: number;
  entries: number;
  /** Grams of protein from entries whose food records it; 0 when unknown. */
  protein: number;
  meals: Partial<Record<Meal, number>>;
}

export interface Point {
  date: string;
  value: number;
}

// Day-count between two 'YYYY-MM-DD' strings. UTC so DST never shifts a day.
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * Trend weight: an exponentially weighted moving average, where each day's
 * reading pulls the trend a fraction of the way toward it. Day-to-day scale
 * noise (water, food in transit, time of day) averages out; real change still
 * comes through.
 *
 * Gaps are handled by compounding the smoothing over the days missed, so a
 * reading after a two-week break moves the trend as much as fourteen daily
 * readings would have — otherwise the trend would lag behind reality after any
 * break in weighing.
 *
 * `halfLifeDays` is how long it takes the trend to close half the distance to a
 * new, stable weight. 10 days is the Hacker's Diet default and holds up well.
 */
export function trendSeries(points: Point[], halfLifeDays = 10): Point[] {
  if (points.length === 0) return [];
  const daily = 1 - Math.pow(0.5, 1 / halfLifeDays); // per-day smoothing factor
  const out: Point[] = [{ date: points[0].date, value: points[0].value }];
  let trend = points[0].value;
  for (let i = 1; i < points.length; i++) {
    const gap = Math.max(1, daysBetween(points[i - 1].date, points[i].date));
    const alpha = 1 - Math.pow(1 - daily, gap);
    trend += alpha * (points[i].value - trend);
    out.push({ date: points[i].date, value: trend });
  }
  return out;
}

/**
 * Least-squares slope over the last `windowDays` of a series, expressed per
 * week. Regression rather than first-vs-last so one odd endpoint can't set the
 * whole rate. Returns undefined when there isn't enough spread to fit a line.
 */
export function ratePerWeek(
  points: Point[],
  windowDays = 28,
): number | undefined {
  if (points.length < 2) return undefined;
  const last = points[points.length - 1].date;
  const window = points.filter((p) => daysBetween(p.date, last) <= windowDays);
  if (window.length < 2) return undefined;

  const xs = window.map((p) => daysBetween(window[0].date, p.date));
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = window.reduce((a, p) => a + p.value, 0) / window.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < window.length; i++) {
    num += (xs[i] - meanX) * (window[i].value - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return undefined;
  return (num / den) * 7;
}

/**
 * Days until `current` reaches `goal` at `ratePerWeekValue`. Undefined when the
 * rate is flat, or pointed away from the goal — no honest date exists then.
 */
export function daysToGoal(
  current: number,
  goal: number,
  ratePerWeekValue: number | undefined,
): number | undefined {
  if (!ratePerWeekValue) return undefined;
  const delta = goal - current;
  if (Math.abs(delta) < 1e-9) return 0;
  if (Math.sign(delta) !== Math.sign(ratePerWeekValue)) return undefined;
  return Math.ceil((delta / ratePerWeekValue) * 7);
}

export interface CalorieSummary {
  loggedDays: number; // days with at least one food entry
  totalDays: number; // days in the range
  avgFood: number; // mean intake across logged days
  avgExercise: number;
  avgBudget: number;
  avgVsBudget: number; // negative = under budget
  totalVsBudget: number; // cumulative surplus/deficit across logged days
  daysUnder: number;
  daysOver: number;
  avgProtein: number;
}

// budgetFor lets each day be measured against the budget that applied then,
// which drifts as weight does.
export function summarize(
  days: DayTotals[],
  budgetFor: (date: string) => number,
): CalorieSummary {
  const logged = days.filter((d) => d.entries > 0);
  const sum = (f: (d: DayTotals) => number) =>
    logged.reduce((a, d) => a + f(d), 0);
  const mean = (total: number) => (logged.length ? total / logged.length : 0);

  // Intake stands on its own: exercise is reported, never subtracted.
  const intake = (d: DayTotals) => d.food;
  const budgets = logged.map((d) => budgetFor(d.date));
  const totalBudget = budgets.reduce((a, b) => a + b, 0);
  const totalIntake = sum(intake);

  return {
    loggedDays: logged.length,
    totalDays: days.length,
    avgFood: mean(sum((d) => d.food)),
    avgExercise: mean(sum((d) => d.exercise)),
    avgBudget: mean(totalBudget),
    avgVsBudget: mean(totalIntake - totalBudget),
    totalVsBudget: totalIntake - totalBudget,
    daysUnder: logged.filter((d, i) => intake(d) <= budgets[i]).length,
    daysOver: logged.filter((d, i) => intake(d) > budgets[i]).length,
    avgProtein: mean(sum((d) => d.protein ?? 0)),
  };
}

export interface WeekRollup {
  weekStart: string; // Monday
  days: DayTotals[];
  loggedDays: number;
  avgFood: number;
  avgExercise: number;
  avgBudget: number;
  trendWeight?: number; // trend at the end of the week
  trendChange?: number; // vs the previous week's end
}

// Monday of the week containing `date`.
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export function weeklyRollups(
  days: DayTotals[],
  budgetFor: (date: string) => number,
  trend: Point[] = [],
): WeekRollup[] {
  const byWeek = new Map<string, DayTotals[]>();
  for (const d of days) {
    const key = weekStart(d.date);
    const list = byWeek.get(key);
    if (list) list.push(d);
    else byWeek.set(key, [d]);
  }

  const weeks = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([start, weekDays]) => {
      const summary = summarize(weekDays, budgetFor);
      const end = weekDays[weekDays.length - 1].date;
      // Latest trend reading on or before the week's last day.
      const at = [...trend].reverse().find((p) => p.date <= end);
      return {
        weekStart: start,
        days: weekDays,
        loggedDays: summary.loggedDays,
        avgFood: summary.avgFood,
        avgExercise: summary.avgExercise,
        avgBudget: summary.avgBudget,
        trendWeight: at?.value,
      } as WeekRollup;
    });

  for (let i = 1; i < weeks.length; i++) {
    const prev = weeks[i - 1].trendWeight;
    const now = weeks[i].trendWeight;
    if (prev != null && now != null) weeks[i].trendChange = now - prev;
  }
  return weeks;
}

// Average calories per meal across the days that have any food logged.
export function mealAverages(
  days: DayTotals[],
): { meal: Meal; average: number }[] {
  const logged = days.filter((d) => d.entries > 0);
  const meals: Meal[] = ["breakfast", "lunch", "dinner", "snacks"];
  return meals.map((meal) => ({
    meal,
    average: logged.length
      ? logged.reduce((a, d) => a + (d.meals[meal] ?? 0), 0) / logged.length
      : 0,
  }));
}

// Fills every date from..to so charts show gaps as gaps, not as a straight line
// between the days that happen to have data.
export function fillDays(
  days: DayTotals[],
  from: string,
  to: string,
): DayTotals[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out: DayTotals[] = [];
  const total = daysBetween(from, to);
  for (let i = 0; i <= total; i++) {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    out.push(
      byDate.get(date) ?? {
        date,
        food: 0,
        exercise: 0,
        entries: 0,
        protein: 0,
        meals: {},
      },
    );
  }
  return out;
}
