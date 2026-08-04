import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { useUI } from '../store/ui';
import { useTheme, type ThemeMode } from '../store/theme';
import ReminderSetting from '../components/ReminderSetting';
import { computeBudget, suggestedProteinG } from '../lib/budget';
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

const card = 'mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm lg:mx-0 lg:mt-0';
const field = 'w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm';
const label = 'flex flex-col gap-1 text-sm text-ink-secondary';

export default function More({ profile }: { profile: Profile }) {
  const bump = useUI((s) => s.bump);
  const { mode, setMode } = useTheme();
  const weights = useData(() => api.getWeights(), []);
  const session = useData(() => api.session(), []);
  const latestKg = weights?.[weights.length - 1]?.weightKg;

  const [units, setUnits] = useState<Units>(profile.units);
  const [sex, setSex] = useState<Sex>(profile.sex);
  const [birthDate, setBirthDate] = useState(profile.birthDate);
  const [heightCm, setHeightCm] = useState(profile.heightCm);
  const [goalInput, setGoalInput] = useState(
    (profile.units === 'imperial' ? kgToLb(profile.goalWeightKg) : profile.goalWeightKg).toFixed(1),
  );
  const [activity, setActivity] = useState<ActivityLevel>(profile.activityLevel);
  const [rateKg, setRateKg] = useState(profile.weeklyRateKg);
  const [proteinTarget, setProteinTarget] = useState(
    profile.proteinTargetG == null ? '' : String(profile.proteinTargetG),
  );
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
  const preview = computeBudget(draft, todayStr(), latestKg);

  async function save() {
    const goal = Number(goalInput);
    const goalWeightKg =
      Number.isFinite(goal) && goal > 0
        ? units === 'imperial'
          ? lbToKg(goal)
          : goal
        : profile.goalWeightKg;
    await api.putProfile({
      ...profile,
      sex,
      birthDate,
      heightCm,
      goalWeightKg,
      activityLevel: activity,
      weeklyRateKg: closestRate.value,
      units,
      proteinTargetG: proteinTarget.trim() === '' ? null : Number(proteinTarget),
    });
    bump();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function reset() {
    if (window.confirm('Delete your profile and all logged data? This cannot be undone.')) {
      await api.resetAll();
      bump();
    }
  }

  return (
    <div className="pt-[env(safe-area-inset-top)] pb-4">
      <header className="px-4 py-3 lg:px-0 lg:pb-4 lg:pt-0">
        <h1 className="text-lg font-semibold lg:text-2xl lg:font-bold lg:tracking-tight">More</h1>
      </header>

      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-4">

      <section className={`${card} lg:col-span-2`}>
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
            <span className="flex items-baseline justify-between">
              Daily protein target (g)
              <button
                type="button"
                onClick={() => setProteinTarget(String(suggestedProteinG(profile.goalWeightKg)))}
                className="text-xs font-medium text-accent"
              >
                Suggest {suggestedProteinG(profile.goalWeightKg)} g
              </button>
            </span>
            <input
              type="number"
              inputMode="numeric"
              className={field}
              placeholder="Leave empty to skip protein"
              value={proteinTarget}
              onChange={(e) => setProteinTarget(e.target.value)}
            />
          </label>

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
        <ReminderSetting profile={profile} />
      </section>

      <section className={card}>
        <h2 className="mb-2 font-semibold">Appearance</h2>
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-surface p-1 text-center text-xs font-semibold">
          {(['system', 'light', 'dark'] as ThemeMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-lg py-2 capitalize ${
                mode === m ? 'bg-accent text-white' : 'text-ink-secondary'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </section>

      <section className={card}>
        <h2 className="mb-1 font-semibold">Your data</h2>
        <p className="mb-3 text-xs text-ink-muted">
          Everything lives on your own server. Keep a copy somewhere else — a backup holds the
          database and every progress photo, and opens with any SQLite tool.
        </p>
        <a
          href="/api/backup"
          download
          className="block w-full rounded-xl bg-accent py-2.5 text-center text-sm font-semibold text-white"
        >
          Download backup (.zip)
        </a>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {[
            { href: '/api/export/food-log.csv', label: 'Food log CSV' },
            { href: '/api/export/weights.csv', label: 'Weights CSV' },
            { href: '/api/export/exercise.csv', label: 'Exercise CSV' },
            { href: '/api/export/measurements.csv', label: 'Measurements CSV' },
          ].map((f) => (
            <a
              key={f.href}
              href={f.href}
              download
              className="rounded-xl border border-line py-2 text-center text-xs font-semibold text-accent"
            >
              {f.label}
            </a>
          ))}
        </div>
      </section>

      <section className={card}>
        <h2 className="mb-1 font-semibold">Food database</h2>
        <p className="mb-3 text-xs text-ink-muted">
          Browse every food the app knows about, and delete the ones you created or scanned.
        </p>
        <Link
          to="/foods"
          className="block w-full rounded-xl border border-line py-2.5 text-center text-sm font-semibold text-accent"
        >
          Manage foods
        </Link>
      </section>

      <section className={card}>
        <h2 className="mb-1 font-semibold">This device</h2>
        {session?.username && (
          <p className="mb-3 text-xs text-ink-muted">
            Signed in as <strong className="text-ink">{session.username}</strong>
          </p>
        )}
        <button
          type="button"
          onClick={async () => {
            await api.logout();
            window.location.reload();
          }}
          className="w-full rounded-xl border border-line py-2.5 text-sm font-semibold text-ink-secondary"
        >
          Sign out
        </button>
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

      </div>

      <p className="mt-6 text-center text-xs text-ink-muted">
        Bend It! — simple calorie tracking.
      </p>
    </div>
  );
}
