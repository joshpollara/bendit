import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, latestWeight, resetAllData } from '../db/db';
import { computeBudget } from '../lib/budget';
import { todayStr } from '../lib/dates';
import { cmToFtIn, ftInToCm, formatCalories, kgToLb, lbToKg } from '../lib/units';
import type { ActivityLevel, Profile, Sex, Units } from '../types';

const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary: 'Sedentary — desk job, little exercise',
  light: 'Lightly active — 1–3 workouts / week',
  moderate: 'Moderately active — 3–5 workouts / week',
  active: 'Very active — 6–7 workouts / week',
  very_active: 'Extra active — physical job + training',
};

function rateOptions(units: Units): { value: number; label: string }[] {
  return units === 'imperial'
    ? [0.5, 1, 1.5, 2].map((lb) => ({ value: lbToKg(lb), label: `${lb} lb / week` }))
    : [0.25, 0.5, 0.75, 1].map((kg) => ({ value: kg, label: `${kg} kg / week` }));
}

const card = 'mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm';
const field = 'w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm';
const label = 'flex flex-col gap-1 text-sm text-ink-secondary';

export default function More({ profile }: { profile: Profile }) {
  const weight = useLiveQuery(latestWeight, []);

  const [units, setUnits] = useState<Units>(profile.units);
  const [sex, setSex] = useState<Sex>(profile.sex);
  const [birthDate, setBirthDate] = useState(profile.birthDate);
  const [heightCm, setHeightCm] = useState(profile.heightCm);
  const [goalInput, setGoalInput] = useState(
    (profile.units === 'imperial' ? kgToLb(profile.goalWeightKg) : profile.goalWeightKg).toFixed(1),
  );
  const [activity, setActivity] = useState<ActivityLevel>(profile.activityLevel);
  const [rateKg, setRateKg] = useState(profile.weeklyRateKg);
  const [saved, setSaved] = useState(false);

  const { ft, inch } = cmToFtIn(heightCm);
  const options = rateOptions(units);
  const closestRate = options.reduce((a, b) =>
    Math.abs(b.value - rateKg) < Math.abs(a.value - rateKg) ? b : a,
  );

  function switchUnits(next: Units) {
    if (next === units) return;
    const goal = Number(goalInput);
    if (Number.isFinite(goal) && goal > 0) {
      const goalKg = units === 'imperial' ? lbToKg(goal) : goal;
      setGoalInput((next === 'imperial' ? kgToLb(goalKg) : goalKg).toFixed(1));
    }
    setUnits(next);
  }

  const draft = {
    sex,
    birthDate,
    heightCm,
    startWeightKg: profile.startWeightKg,
    activityLevel: activity,
    weeklyRateKg: closestRate.value,
  };
  const preview = computeBudget(draft, todayStr(), weight?.weightKg);

  async function save() {
    const goal = Number(goalInput);
    const goalWeightKg =
      Number.isFinite(goal) && goal > 0
        ? units === 'imperial'
          ? lbToKg(goal)
          : goal
        : profile.goalWeightKg;
    await db.profile.put({
      ...profile,
      sex,
      birthDate,
      heightCm,
      goalWeightKg,
      activityLevel: activity,
      weeklyRateKg: closestRate.value,
      units,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function reset() {
    if (window.confirm('Delete your profile and all logged data? This cannot be undone.')) {
      await resetAllData();
    }
  }

  return (
    <div className="pt-[env(safe-area-inset-top)] pb-4">
      <header className="px-4 py-3">
        <h1 className="text-lg font-semibold">More</h1>
      </header>

      <section className={card}>
        <h2 className="mb-3 font-semibold">Profile & goals</h2>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className={label}>
              Units
              <select className={field} value={units} onChange={(e) => switchUnits(e.target.value as Units)}>
                <option value="imperial">Imperial (lb, ft)</option>
                <option value="metric">Metric (kg, cm)</option>
              </select>
            </label>
            <label className={label}>
              Sex
              <select className={field} value={sex} onChange={(e) => setSex(e.target.value as Sex)}>
                <option value="female">Female</option>
                <option value="male">Male</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className={label}>
              Birth date
              <input type="date" className={field} value={birthDate} max={todayStr()} onChange={(e) => setBirthDate(e.target.value)} />
            </label>
            {units === 'imperial' ? (
              <div className="grid grid-cols-2 gap-2">
                <label className={label}>
                  Height (ft)
                  <input
                    type="number"
                    className={field}
                    value={ft}
                    min={3}
                    max={8}
                    onChange={(e) => setHeightCm(ftInToCm(Number(e.target.value) || 0, inch))}
                  />
                </label>
                <label className={label}>
                  (in)
                  <input
                    type="number"
                    className={field}
                    value={inch}
                    min={0}
                    max={11}
                    onChange={(e) => setHeightCm(ftInToCm(ft, Number(e.target.value) || 0))}
                  />
                </label>
              </div>
            ) : (
              <label className={label}>
                Height (cm)
                <input
                  type="number"
                  className={field}
                  value={Math.round(heightCm)}
                  onChange={(e) => setHeightCm(Number(e.target.value) || 0)}
                />
              </label>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className={label}>
              Goal weight ({units === 'imperial' ? 'lb' : 'kg'})
              <input
                type="number"
                inputMode="decimal"
                className={field}
                value={goalInput}
                onChange={(e) => setGoalInput(e.target.value)}
              />
            </label>
            <label className={label}>
              Weekly goal
              <select
                className={field}
                value={String(closestRate.value)}
                onChange={(e) => setRateKg(Number(e.target.value))}
              >
                {options.map((o) => (
                  <option key={o.label} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className={label}>
            Activity level
            <select className={field} value={activity} onChange={(e) => setActivity(e.target.value as ActivityLevel)}>
              {(Object.keys(ACTIVITY_LABELS) as ActivityLevel[]).map((a) => (
                <option key={a} value={a}>
                  {ACTIVITY_LABELS[a]}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center justify-between rounded-xl bg-accent-soft px-3 py-2.5">
            <span className="text-sm font-medium text-accent-deep">New daily budget</span>
            <span className="text-lg font-bold tabular-nums text-accent-deep">
              {formatCalories(preview.budget)} cal
            </span>
          </div>
          {preview.floored && (
            <p className="text-xs text-over">
              This rate would put your budget below a safe minimum, so it's been raised to the floor.
            </p>
          )}

          <button
            type="button"
            onClick={save}
            className="rounded-xl bg-accent py-3 font-semibold text-white active:bg-accent-deep"
          >
            {saved ? 'Saved ✓' : 'Save changes'}
          </button>
        </div>
      </section>

      <section className={card}>
        <h2 className="mb-1 font-semibold">Start over</h2>
        <p className="mb-3 text-xs text-ink-muted">
          Deletes your profile, food log, exercise, and weights. Seed foods stay.
        </p>
        <button
          type="button"
          onClick={reset}
          className="w-full rounded-xl border border-over py-2.5 text-sm font-semibold text-over"
        >
          Delete all data
        </button>
      </section>

      <p className="mt-6 text-center text-xs text-ink-muted">
        Bend It! — simple calorie tracking.
      </p>
    </div>
  );
}
