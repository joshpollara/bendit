import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type JoinedEntry } from '../lib/api';
import { useData } from '../lib/useData';
import { computeBudget, remaining } from '../lib/budget';
import { dayLabel, shiftDay, todayStr } from '../lib/dates';
import { formatCalories } from '../lib/units';
import { STRINGS } from '../lib/strings';
import { useUI } from '../store/ui';
import { MEAL_LABELS, MEALS, type Meal, type Profile } from '../types';
import EntrySheet from '../components/EntrySheet';
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

// Macros come from the foods behind the entries; quick adds contribute
// calories only, so the totals are a floor, not a claim of completeness.
function MacroRow({
  entries,
  proteinTargetG,
}: {
  entries: JoinedEntry[];
  proteinTargetG?: number | null;
}) {
  const total = (get: (f: NonNullable<JoinedEntry['food']>) => number | undefined) =>
    entries.reduce((sum, e) => sum + (e.food ? (get(e.food) ?? 0) * e.servings : 0), 0);

  const protein = Math.round(total((f) => f.protein));
  const carbs = Math.round(total((f) => f.carbs));
  const fat = Math.round(total((f) => f.fat));
  if (protein + carbs + fat === 0) return null;

  const target = proteinTargetG ?? 0;
  const pct = target > 0 ? Math.min(100, (protein / target) * 100) : 0;
  const hit = target > 0 && protein >= target;

  return (
    <section className="mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Protein</h2>
        <span className="text-sm tabular-nums">
          <strong className={hit ? 'text-good' : ''}>{protein} g</strong>
          {target > 0 && <span className="text-ink-muted"> of {target} g</span>}
        </span>
      </div>
      {target > 0 && (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-line" role="presentation">
          <div
            className={`h-full rounded-full transition-all ${hit ? 'bg-good' : 'bg-accent'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <p className="mt-2 text-xs text-ink-muted">
        Carbs {carbs} g · Fat {fat} g
        {target === 0 && ' · set a protein target in More'}
      </p>
    </section>
  );
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
  const [editing, setEditing] = useState<JoinedEntry | null>(null);
  const bump = useUI((s) => s.bump);
  const subtotal = entries.reduce((sum, e) => sum + e.caloriesCached, 0);

  async function saveAsMeal() {
    const name = window.prompt('Save this meal as:', MEAL_LABELS[meal]);
    if (!name?.trim()) return;
    await api.saveMealAsTemplate(name.trim(), date, meal);
    bump();
  }

  async function copyYesterday() {
    const yesterday = shiftDay(date, -1);
    const prev = await api.getDay(yesterday, yesterday);
    await Promise.all(
      prev.entries
        .filter((e) => e.meal === meal)
        .map((e) =>
          api.addLogEntry({
            date,
            meal: e.meal,
            foodId: e.foodId,
            servings: e.servings,
            caloriesCached: e.caloriesCached,
            label: e.label,
          }),
        ),
    );
    bump();
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
          to={`/add-food?meal=${meal}&date=${date}&tab=quick`}
          className="rounded-full px-2 py-1 text-xs font-semibold text-accent hover:bg-accent-soft"
        >
          Quick
        </Link>
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
                  <button
                    type="button"
                    onClick={() => setEditing(e)}
                    aria-label={`Edit ${e.food?.name ?? e.label ?? 'entry'}`}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-sm font-medium">
                      {e.food?.name ?? e.label ?? 'Deleted food'}
                    </p>
                    <p className="truncate text-xs text-ink-muted">
                      {e.food
                        ? `${e.servings} × ${e.food.servingLabel}${e.food.brand ? ` · ${e.food.brand}` : ''}`
                        : 'Calories only'}
                    </p>
                  </button>
                  <span className="text-sm font-medium tabular-nums">{formatCalories(e.caloriesCached)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${e.food?.name ?? e.label ?? 'entry'}`}
                    onClick={() => api.deleteLogEntry(e.id).then(bump)}
                    className="rounded-full p-1 text-ink-muted hover:bg-surface hover:text-over"
                  >
                    <XIcon className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {entries.length > 0 && (
            <button
              type="button"
              onClick={saveAsMeal}
              className="w-full border-t border-line py-2 text-xs font-medium text-accent hover:bg-surface"
            >
              Save as a meal
            </button>
          )}
        </div>
      )}

      {editing && (
        <EntrySheet
          entry={editing}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setEditing(null);
            bump();
          }}
        />
      )}
    </section>
  );
}

// Marking a day as finished changes nothing in the data — it's a line you
// draw for yourself. The strip replaces the button so the day reads as closed.
function DayDone({ date, done, left }: { date: string; done: boolean; left: number }) {
  const bump = useUI((s) => s.bump);
  const toggle = (next: boolean) => api.setDayDone(date, next).then(bump);

  if (!done) {
    return (
      <button
        type="button"
        onClick={() => toggle(true)}
        className="mx-4 mt-3 mb-4 block w-[calc(100%-2rem)] rounded-2xl border border-line bg-card py-3 text-sm font-semibold text-ink-secondary hover:bg-surface"
      >
        I'm done logging for today
      </button>
    );
  }
  return (
    <div className="mx-4 mt-3 mb-4 flex items-center gap-2 rounded-2xl bg-good-soft px-4 py-3">
      <CheckIcon className="h-4 w-4 shrink-0 text-good" />
      <p className="flex-1 text-sm text-ink-secondary">
        Logging closed for today
        {left >= 0 ? ` — ${formatCalories(left)} calories under budget.` : '.'}
      </p>
      <button type="button" onClick={() => toggle(false)} className="text-xs font-medium text-accent">
        Reopen
      </button>
    </div>
  );
}

export default function Today({ profile }: { profile: Profile }) {
  const date = useUI((s) => s.date);
  const bump = useUI((s) => s.bump);

  const day = useData(() => api.getDay(date, shiftDay(date, -1)), [date]);

  const joined = day?.entries ?? [];
  const exercises = day?.exercises ?? [];
  const foodCalories = joined.reduce((sum, e) => sum + e.caloriesCached, 0);
  const exerciseCalories = exercises.reduce((sum, e) => sum + e.caloriesBurned, 0);
  const { budget } = computeBudget(profile, date, day?.latestWeightKg);
  const yesterdayByMeal = day?.yesterdayMealCounts ?? {};
  const left = remaining(budget, foodCalories, exerciseCalories);

  return (
    <div className="pt-[env(safe-area-inset-top)]">
      <DateNav />
      <BudgetSummary budget={budget} food={foodCalories} exercise={exerciseCalories} />
      <MacroRow entries={joined} proteinTargetG={profile.proteinTargetG} />

      {MEALS.map((meal) => (
        <MealSection
          key={meal}
          meal={meal}
          date={date}
          entries={joined.filter((e) => e.meal === meal)}
          yesterdayCount={yesterdayByMeal[meal] ?? 0}
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
                    onClick={() => api.deleteExercise(e.id).then(bump)}
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

      {day && <DayDone date={date} done={day.done} left={left} />}
    </div>
  );
}
