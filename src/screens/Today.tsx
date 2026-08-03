import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { db, latestWeight, newId } from '../db/db';
import { computeBudget, remaining } from '../lib/budget';
import { dayLabel, shiftDay, todayStr } from '../lib/dates';
import { formatCalories } from '../lib/units';
import { STRINGS } from '../lib/strings';
import { useUI } from '../store/ui';
import { MEAL_LABELS, MEALS, type Food, type FoodLogEntry, type Meal, type Profile } from '../types';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  WarnIcon,
  XIcon,
} from '../components/Icons';

function DateNav() {
  const { date, setDate } = useUI();
  return (
    <div className="flex items-center justify-between px-2 py-3">
      <button
        type="button"
        aria-label="Previous day"
        onClick={() => setDate(shiftDay(date, -1))}
        className="rounded-full p-2 text-ink-secondary hover:bg-card"
      >
        <ChevronLeftIcon className="h-5 w-5" />
      </button>
      <button
        type="button"
        onClick={() => setDate(todayStr())}
        className="text-base font-semibold"
      >
        {dayLabel(date)}
      </button>
      <button
        type="button"
        aria-label="Next day"
        onClick={() => setDate(shiftDay(date, 1))}
        className="rounded-full p-2 text-ink-secondary hover:bg-card"
      >
        <ChevronRightIcon className="h-5 w-5" />
      </button>
    </div>
  );
}

function BudgetSummary({
  budget,
  food,
  exercise,
}: {
  budget: number;
  food: number;
  exercise: number;
}) {
  const left = remaining(budget, food, exercise);
  const over = left < 0;
  const consumedPct = budget > 0 ? Math.min(100, (Math.max(0, food - exercise) / budget) * 100) : 0;

  const stat = (label: string, value: number) => (
    <div className="flex flex-col items-center">
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{formatCalories(value)}</span>
    </div>
  );

  return (
    <section className="mx-4 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        {stat('Budget', budget)}
        <span className="text-ink-muted">−</span>
        {stat('Food', food)}
        <span className="text-ink-muted">+</span>
        {stat('Exercise', exercise)}
        <span className="text-ink-muted">=</span>
        <div className="flex flex-col items-center">
          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Remaining
          </span>
          <span className={`text-lg font-bold tabular-nums ${over ? 'text-over' : 'text-good'}`}>
            {formatCalories(left)}
          </span>
        </div>
      </div>

      <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-line" role="presentation">
        <div
          className={`h-full rounded-full transition-all ${over ? 'bg-over' : 'bg-good'}`}
          style={{ width: `${over ? 100 : consumedPct}%` }}
        />
      </div>

      <p
        className={`mt-3 flex items-center gap-1.5 text-sm ${over ? 'text-over' : 'text-ink-secondary'}`}
      >
        {over ? <WarnIcon className="h-4 w-4 shrink-0" /> : <CheckIcon className="h-4 w-4 shrink-0 text-good" />}
        {over
          ? STRINGS.overBudget(formatCalories(-left))
          : left === 0
            ? STRINGS.onBudget
            : STRINGS.underBudget(formatCalories(left))}
      </p>
    </section>
  );
}

interface JoinedEntry extends FoodLogEntry {
  food?: Food;
}

function MealSection({
  meal,
  date,
  entries,
  yesterdayCount,
}: {
  meal: Meal;
  date: string;
  entries: JoinedEntry[];
  yesterdayCount: number;
}) {
  const [open, setOpen] = useState(true);
  const subtotal = entries.reduce((sum, e) => sum + e.caloriesCached, 0);

  async function copyYesterday() {
    const yesterday = shiftDay(date, -1);
    const prev = await db.foodLog.where('date').equals(yesterday).toArray();
    const clones = prev
      .filter((e) => e.meal === meal)
      .map((e) => ({ ...e, id: newId(), date }));
    await db.foodLog.bulkAdd(clones);
  }

  return (
    <section className="mx-4 mt-3 rounded-2xl border border-line bg-card shadow-sm">
      <header className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          aria-label={open ? `Collapse ${MEAL_LABELS[meal]}` : `Expand ${MEAL_LABELS[meal]}`}
          onClick={() => setOpen(!open)}
          className="text-ink-muted"
        >
          <ChevronDownIcon className={`h-4 w-4 transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>
        <h2 className="flex-1 font-semibold">{MEAL_LABELS[meal]}</h2>
        {subtotal > 0 && (
          <span className="text-sm font-medium tabular-nums text-ink-secondary">
            {formatCalories(subtotal)}
          </span>
        )}
        <Link
          to={`/add-food?meal=${meal}&date=${date}`}
          aria-label={`Add food to ${MEAL_LABELS[meal]}`}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-accent"
        >
          <PlusIcon className="h-4 w-4" />
        </Link>
      </header>

      {open && (
        <div className="border-t border-line">
          {entries.length === 0 ? (
            <div className="flex items-center justify-between gap-2 px-4 py-3">
              <p className="text-sm text-ink-muted">{STRINGS.emptyMeal}</p>
              {yesterdayCount > 0 && (
                <button
                  type="button"
                  onClick={copyYesterday}
                  className="shrink-0 text-sm font-medium text-accent"
                >
                  Copy yesterday's
                </button>
              )}
            </div>
          ) : (
            <ul>
              {entries.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{e.food?.name ?? 'Deleted food'}</p>
                    <p className="truncate text-xs text-ink-muted">
                      {e.servings} × {e.food?.servingLabel ?? 'serving'}
                      {e.food?.brand ? ` · ${e.food.brand}` : ''}
                    </p>
                  </div>
                  <span className="text-sm font-medium tabular-nums">{formatCalories(e.caloriesCached)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${e.food?.name ?? 'entry'}`}
                    onClick={() => db.foodLog.delete(e.id)}
                    className="rounded-full p-1 text-ink-muted hover:bg-surface hover:text-over"
                  >
                    <XIcon className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export default function Today({ profile }: { profile: Profile }) {
  const date = useUI((s) => s.date);

  const day = useLiveQuery(
    async () => {
      const [entries, exercises, yesterdayEntries, weight] = await Promise.all([
        db.foodLog.where('date').equals(date).toArray(),
        db.exerciseLog.where('date').equals(date).toArray(),
        db.foodLog.where('date').equals(shiftDay(date, -1)).toArray(),
        latestWeight(),
      ]);
      const foods = await db.foods.bulkGet([...new Set(entries.map((e) => e.foodId))]);
      const foodMap = new Map(foods.filter((f): f is Food => !!f).map((f) => [f.id, f]));
      const joined: JoinedEntry[] = entries.map((e) => ({ ...e, food: foodMap.get(e.foodId) }));
      return { joined, exercises, yesterdayEntries, weightKg: weight?.weightKg };
    },
    [date],
  );

  const joined = day?.joined ?? [];
  const exercises = day?.exercises ?? [];
  const foodCalories = joined.reduce((sum, e) => sum + e.caloriesCached, 0);
  const exerciseCalories = exercises.reduce((sum, e) => sum + e.caloriesBurned, 0);
  const { budget } = computeBudget(profile, date, day?.weightKg);

  const yesterdayByMeal = new Map<Meal, number>();
  for (const e of day?.yesterdayEntries ?? []) {
    yesterdayByMeal.set(e.meal, (yesterdayByMeal.get(e.meal) ?? 0) + 1);
  }

  return (
    <div className="pt-[env(safe-area-inset-top)]">
      <DateNav />
      <BudgetSummary budget={budget} food={foodCalories} exercise={exerciseCalories} />

      {MEALS.map((meal) => (
        <MealSection
          key={meal}
          meal={meal}
          date={date}
          entries={joined.filter((e) => e.meal === meal)}
          yesterdayCount={yesterdayByMeal.get(meal) ?? 0}
        />
      ))}

      <section className="mx-4 mt-3 mb-4 rounded-2xl border border-line bg-card shadow-sm">
        <header className="flex items-center gap-2 px-4 py-3">
          <h2 className="flex-1 font-semibold">Exercise</h2>
          {exerciseCalories > 0 && (
            <span className="text-sm font-medium tabular-nums text-good">
              +{formatCalories(exerciseCalories)}
            </span>
          )}
          <Link
            to={`/add-exercise?date=${date}`}
            aria-label="Add exercise"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-accent"
          >
            <PlusIcon className="h-4 w-4" />
          </Link>
        </header>
        <div className="border-t border-line">
          {exercises.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-muted">{STRINGS.emptyExercise}</p>
          ) : (
            <ul>
              {exercises.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{e.name}</p>
                    <p className="text-xs text-ink-muted">{e.minutes} min</p>
                  </div>
                  <span className="text-sm font-medium tabular-nums text-good">
                    +{formatCalories(e.caloriesBurned)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${e.name}`}
                    onClick={() => db.exerciseLog.delete(e.id)}
                    className="rounded-full p-1 text-ink-muted hover:bg-surface hover:text-over"
                  >
                    <XIcon className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
