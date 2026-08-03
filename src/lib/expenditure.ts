import { KCAL_PER_KG_FAT } from './budget';
import { daysBetween, type DayTotals, type Point } from './report';

// Your real expenditure, measured instead of estimated.
//
// The Mifflin-St Jeor formula guesses a metabolic rate from height, weight,
// age, and a coarse activity multiplier. Energy balance measures it: whatever
// you ate, minus whatever your body stored or spent from reserves, is what you
// burned.
//
//   intake − expenditure = change in stored energy
//   expenditure = mean intake − (trend weight change × 7700 kcal/kg) / days
//
// Losing 0.5 kg over a week while eating 2000/day means expenditure was
// 2000 + (0.5 × 7700)/7 = 2550, whatever any formula says.
//
// Two things make this honest rather than a curiosity:
//   • It uses *trend* weight, not scale readings, so water swings don't
//     masquerade as metabolism.
//   • It needs enough logged days to mean anything, and says so when it
//     doesn't have them.

export interface Expenditure {
  /** Measured daily expenditure in kcal. */
  tdee: number;
  /** Days spanned by the window. */
  days: number;
  /** Days in the window with food actually logged. */
  loggedDays: number;
  /** Mean daily intake across logged days. */
  meanIntake: number;
  /** Trend weight change across the window, kg (negative = lost). */
  trendChangeKg: number;
  /** How much of the window was logged — the honest confidence signal. */
  coverage: number;
}

export const MIN_DAYS = 14;
export const MIN_COVERAGE = 0.6;

/**
 * Measures expenditure over the most recent `windowDays`. Returns undefined
 * when there isn't enough data to say anything true: too short a span, too few
 * logged days, or no weight trend across it.
 *
 * Intake is gross food calories — logged exercise is *not* added back, because
 * weight change already accounts for every calorie burned, deliberate or not.
 */
export function measureExpenditure(
  days: DayTotals[],
  trend: Point[],
  windowDays = 28,
): Expenditure | undefined {
  if (days.length === 0 || trend.length < 2) return undefined;

  const lastDate = days[days.length - 1].date;
  const window = days.filter((d) => daysBetween(d.date, lastDate) < windowDays);
  if (window.length < MIN_DAYS) return undefined;

  const logged = window.filter((d) => d.entries > 0);
  const coverage = logged.length / window.length;
  if (logged.length < MIN_DAYS || coverage < MIN_COVERAGE) return undefined;

  // Trend readings that bracket the window.
  const from = window[0].date;
  const inWindow = trend.filter((p) => p.date >= from && p.date <= lastDate);
  const start = inWindow[0] ?? [...trend].reverse().find((p) => p.date <= from);
  const end = inWindow[inWindow.length - 1];
  if (!start || !end || start.date === end.date) return undefined;

  const spanDays = daysBetween(start.date, end.date);
  if (spanDays < MIN_DAYS) return undefined;

  const meanIntake = logged.reduce((sum, d) => sum + d.food, 0) / logged.length;
  const trendChangeKg = end.value - start.value;
  const tdee = meanIntake - (trendChangeKg * KCAL_PER_KG_FAT) / spanDays;

  return {
    tdee: Math.round(tdee),
    days: spanDays,
    loggedDays: logged.length,
    meanIntake: Math.round(meanIntake),
    trendChangeKg,
    coverage,
  };
}

/**
 * The budget implied by a measured expenditure and the user's chosen rate of
 * loss, floored the same way the formula budget is.
 */
export function budgetFromExpenditure(tdee: number, dailyDeficit: number, floor: number): number {
  return Math.max(floor, Math.round(tdee - dailyDeficit));
}

/**
 * Whether an adopted measurement has drifted far enough from the live one to
 * be worth re-adopting. Small wobbles shouldn't nag.
 */
export function hasDrifted(adopted: number, measured: number, threshold = 100): boolean {
  return Math.abs(measured - adopted) >= threshold;
}
