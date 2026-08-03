import { lazy, Suspense, useState } from 'react';
import { format, parseISO, subMonths, subYears } from 'date-fns';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { computeBudget, KCAL_PER_KG_FAT } from '../lib/budget';
import { DAY, shortDate, todayStr } from '../lib/dates';
import { formatCalories, formatWeight, kgToLb } from '../lib/units';
import {
  daysToGoal,
  fillDays,
  mealAverages,
  ratePerWeek,
  summarize,
  trendSeries,
  weeklyRollups,
  type Point,
} from '../lib/report';
import { MEAL_LABELS, type Profile } from '../types';
import GoalTrack from '../components/GoalTrack';

// recharts is heavy; keep it out of the main bundle.
const TrendChart = lazy(() =>
  import('../components/ReportCharts').then((m) => ({ default: m.TrendChart })),
);
const CalorieChart = lazy(() =>
  import('../components/ReportCharts').then((m) => ({ default: m.CalorieChart })),
);
const MealChart = lazy(() =>
  import('../components/ReportCharts').then((m) => ({ default: m.MealChart })),
);

type Range = '1M' | '3M' | '1Y' | 'All';
const RANGES: Range[] = ['1M', '3M', '1Y', 'All'];

function rangeStart(range: Range): string | undefined {
  const now = new Date();
  if (range === '1M') return format(subMonths(now, 1), DAY);
  if (range === '3M') return format(subMonths(now, 3), DAY);
  if (range === '1Y') return format(subYears(now, 1), DAY);
  return undefined;
}

const card = 'mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm';

function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-surface px-3 py-2.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${tone ?? ''}`}>{value}</span>
      {note && <span className="text-[11px] text-ink-muted">{note}</span>}
    </div>
  );
}

export default function Reports({ profile }: { profile: Profile }) {
  const [range, setRange] = useState<Range>('3M');
  const from = rangeStart(range);
  const report = useData(() => api.getReport(from), [from]);

  if (report === undefined) {
    return (
      <div className="pt-[env(safe-area-inset-top)]">
        <header className="px-4 py-3">
          <h1 className="text-lg font-semibold">Reports</h1>
        </header>
        <p className={`${card} text-center text-sm text-ink-muted`}>Loading…</p>
      </div>
    );
  }

  const hasData = report.from != null && report.to != null && (report.days.length > 0 || report.weights.length > 0);

  // Trend weight, and the budget that applied on each day (which drifts with
  // weight, so history is measured against the budget the user actually had).
  const weighIns: Point[] = report.weights.map((w) => ({ date: w.date, value: w.weightKg }));
  const trend = trendSeries(weighIns);
  const trendAt = (date: string) => [...trend].reverse().find((p) => p.date <= date)?.value;
  const latestTrend = trend[trend.length - 1]?.value;
  const budgetFor = (date: string) =>
    computeBudget(profile, date, trendAt(date) ?? latestTrend).budget;

  const days = hasData ? fillDays(report.days, report.from!, report.to!) : [];
  const summary = summarize(days, budgetFor);
  const meals = mealAverages(days);

  // Weeks where nothing happened at all are noise, not a row.
  const weighDates = new Set(report.weights.map((w) => w.date));
  const weeks = weeklyRollups(days, budgetFor, trend)
    .filter((w) => w.loggedDays > 0 || w.days.some((d) => weighDates.has(d.date)))
    .reverse();

  // Weight change over the range, read off the trend rather than the scale, so
  // a puffy weigh-in on either end doesn't rewrite the story.
  const trendRateKg = ratePerWeek(trend);
  const trendChangeKg =
    trend.length > 1 ? trend[trend.length - 1].value - trend[0].value : undefined;
  const toGoalDays =
    latestTrend != null ? daysToGoal(latestTrend, profile.goalWeightKg, trendRateKg) : undefined;
  const goalDate =
    toGoalDays != null && toGoalDays > 0
      ? format(new Date(Date.now() + toGoalDays * 86_400_000), 'MMM d, yyyy')
      : undefined;

  // What the logged calories imply per week, for comparison with the scale.
  const impliedRateKg =
    summary.loggedDays > 0 ? (summary.avgVsBudget * 7) / KCAL_PER_KG_FAT : undefined;

  const losing = profile.goalWeightKg <= profile.startWeightKg;
  const towardGoal = trendRateKg != null && trendRateKg !== 0 && trendRateKg < 0 === losing;

  const displayRate = (kg: number) => {
    const magnitude = profile.units === 'imperial' ? Math.abs(kgToLb(kg)) : Math.abs(kg);
    const sign = kg > 0 ? '+' : kg < 0 ? '−' : '';
    return `${sign}${magnitude.toFixed(2)} ${profile.units === 'imperial' ? 'lb' : 'kg'}/wk`;
  };

  const chartDays = days.map((d) => ({
    date: d.date,
    net: d.entries > 0 ? Math.round(d.food - d.exercise) : null,
    average: null as number | null,
  }));
  // Weighted average of net calories, same smoothing idea as trend weight but
  // over a shorter half-life — intake moves faster than body weight.
  const netPoints = chartDays
    .filter((d) => d.net != null)
    .map((d) => ({ date: d.date, value: d.net as number }));
  const netTrend = new Map(trendSeries(netPoints, 5).map((p) => [p.date, p.value]));
  for (const d of chartDays) {
    const v = netTrend.get(d.date);
    if (v != null) d.average = Math.round(v);
  }

  const weightPoints = days.length
    ? days.map((d) => {
        const scale = report.weights.find((w) => w.date === d.date)?.weightKg;
        const t = trendAt(d.date);
        const toDisplay = (kg: number) => +(profile.units === 'imperial' ? kgToLb(kg) : kg).toFixed(1);
        return {
          date: d.date,
          scale: scale != null ? toDisplay(scale) : undefined,
          trend: t != null ? toDisplay(t) : undefined,
        };
      })
    : [];

  const avgBudget = summary.avgBudget || computeBudget(profile, todayStr(), latestTrend).budget;

  return (
    <div className="pt-[env(safe-area-inset-top)] pb-4">
      <header className="flex items-center justify-between px-4 py-3">
        <h1 className="text-lg font-semibold">Reports</h1>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                range === r ? 'bg-accent text-white' : 'text-ink-secondary hover:bg-surface'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </header>

      {!hasData ? (
        <p className={`${card} text-center text-sm text-ink-muted`}>
          Log a few days of food and weight and your trends will show up here.
        </p>
      ) : (
        <>
          <section className={card}>
            <h2 className="mb-3 font-semibold">At a glance</h2>
            <div className="grid grid-cols-2 gap-2">
              <Tile
                label="Avg net calories"
                value={summary.loggedDays ? formatCalories(summary.avgNet) : '—'}
                note={`Budget ${formatCalories(avgBudget)}`}
              />
              <Tile
                label="Vs budget"
                value={
                  summary.loggedDays
                    ? `${summary.avgVsBudget > 0 ? '+' : '−'}${formatCalories(Math.abs(summary.avgVsBudget))}`
                    : '—'
                }
                note="per day"
                tone={summary.avgVsBudget > 0 ? 'text-over' : 'text-good'}
              />
              <Tile
                label="Trend weight"
                value={latestTrend != null ? formatWeight(latestTrend, profile.units) : '—'}
                note={trendRateKg != null ? displayRate(trendRateKg) : 'not enough weigh-ins'}
                tone={towardGoal ? 'text-good' : ''}
              />
              <Tile
                label="Days logged"
                value={`${summary.loggedDays} of ${summary.totalDays}`}
                note={`${summary.daysUnder} under · ${summary.daysOver} over`}
              />
            </div>

            <ul className="mt-3 flex flex-col gap-1 text-sm text-ink-secondary">
              {trendChangeKg != null && (
                <li>
                  Trend weight {trendChangeKg <= 0 ? 'down' : 'up'}{' '}
                  <strong className="tabular-nums">
                    {formatWeight(Math.abs(trendChangeKg), profile.units)}
                  </strong>{' '}
                  since {shortDate(trend[0].date)}.
                </li>
              )}
              {goalDate && (
                <li>
                  At this rate you reach {formatWeight(profile.goalWeightKg, profile.units)} around{' '}
                  <strong>{goalDate}</strong>.
                </li>
              )}
              {summary.loggedDays > 0 && (
                <li>
                  Your logged calories imply{' '}
                  <strong className="tabular-nums">{displayRate(impliedRateKg ?? 0)}</strong>
                  {trendRateKg != null && (
                    <>
                      ; the scale says{' '}
                      <strong className="tabular-nums">{displayRate(trendRateKg)}</strong>
                    </>
                  )}
                  .
                </li>
              )}
            </ul>
          </section>

          {latestTrend != null && (
            <section className={card}>
              <h2 className="mb-1 font-semibold">Goal</h2>
              <GoalTrack
                startKg={profile.startWeightKg}
                goalKg={profile.goalWeightKg}
                currentKg={latestTrend}
                units={profile.units}
              />
            </section>
          )}

          <Suspense fallback={<div className={`${card} h-72`} />}>
            <section className={card}>
              <h2 className="font-semibold">Weight trend</h2>
              <p className="mb-2 text-xs text-ink-muted">
                Weight swings day to day with water and food in transit. The trend line is a
                weighted average — recent weigh-ins count most — so it shows the direction
                underneath the noise.
              </p>
              {weighIns.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-muted">No weigh-ins in this range.</p>
              ) : (
                <TrendChart
                  data={weightPoints}
                  goalKg={profile.goalWeightKg}
                  units={profile.units}
                />
              )}
            </section>

            <section className={card}>
              <h2 className="font-semibold">Calories</h2>
              <p className="mb-2 text-xs text-ink-muted">
                Net calories per day (food minus exercise) against your budget.
              </p>
              {summary.loggedDays === 0 ? (
                <p className="py-8 text-center text-sm text-ink-muted">Nothing logged in this range.</p>
              ) : (
                <CalorieChart data={chartDays} budget={Math.round(avgBudget)} />
              )}
            </section>

            {summary.loggedDays > 0 && (
              <section className={card}>
                <h2 className="font-semibold">Average day</h2>
                <p className="mb-2 text-xs text-ink-muted">
                  Mean calories per meal across the {summary.loggedDays} day
                  {summary.loggedDays === 1 ? '' : 's'} you logged.
                </p>
                <MealChart
                  data={meals.map((m) => ({ meal: MEAL_LABELS[m.meal], average: Math.round(m.average) }))}
                />
                {summary.avgExercise > 0 && (
                  <p className="mt-1 text-center text-xs text-ink-muted">
                    Plus {formatCalories(summary.avgExercise)} cal burned per day.
                  </p>
                )}
              </section>
            )}
          </Suspense>

          {weeks.length > 0 && (
            <section className="mx-4 mt-3 overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
              <h2 className="border-b border-line px-4 py-3 font-semibold">By week</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] whitespace-nowrap uppercase tracking-wide text-ink-muted">
                      <th className="px-4 py-2 font-medium">Week of</th>
                      <th className="px-2 py-2 text-right font-medium">Avg net</th>
                      <th className="px-2 py-2 text-right font-medium">Vs budget</th>
                      <th className="px-4 py-2 text-right font-medium">Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weeks.map((w) => {
                      const diff = w.loggedDays > 0 ? w.avgNet - w.avgBudget : undefined;
                      return (
                        <tr
                          key={w.weekStart}
                          className="whitespace-nowrap border-b border-line last:border-b-0"
                        >
                          <td className="px-4 py-2.5">{format(parseISO(w.weekStart), 'MMM d')}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">
                            {w.loggedDays > 0 ? formatCalories(w.avgNet) : '—'}
                            <span className="block text-[11px] text-ink-muted">
                              {w.loggedDays}/{w.days.length} days
                            </span>
                          </td>
                          <td
                            className={`px-2 py-2.5 text-right tabular-nums ${
                              diff == null ? '' : diff > 0 ? 'text-over' : 'text-good'
                            }`}
                          >
                            {diff == null
                              ? '—'
                              : `${diff > 0 ? '+' : '−'}${formatCalories(Math.abs(diff))}`}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            {w.trendWeight != null
                              ? formatWeight(w.trendWeight, profile.units)
                              : '—'}
                            {w.trendChange != null && (
                              <span
                                className={`block text-[11px] ${w.trendChange <= 0 ? 'text-good' : 'text-over'}`}
                              >
                                {w.trendChange > 0 ? '+' : '−'}
                                {formatWeight(Math.abs(w.trendChange), profile.units)}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
