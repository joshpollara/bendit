import { useState } from 'react';
import { db, newId, PROFILE_ID } from '../db/db';
import { computeBudget } from '../lib/budget';
import { todayStr } from '../lib/dates';
import { cmToFtIn, formatCalories, ftInToCm, kgToLb, lbToKg } from '../lib/units';
import { STRINGS } from '../lib/strings';
import type { ActivityLevel, Sex, Units } from '../types';
import { WarnIcon } from '../components/Icons';

const ACTIVITY_OPTIONS: { value: ActivityLevel; title: string; sub: string }[] = [
  { value: 'sedentary', title: 'Sedentary', sub: 'Desk job, little exercise' },
  { value: 'light', title: 'Lightly active', sub: '1–3 workouts a week' },
  { value: 'moderate', title: 'Moderately active', sub: '3–5 workouts a week' },
  { value: 'active', title: 'Very active', sub: '6–7 workouts a week' },
  { value: 'very_active', title: 'Extra active', sub: 'Physical job plus training' },
];

const STEPS = ['welcome', 'sex', 'birth', 'height', 'weight', 'goal', 'rate', 'activity', 'reveal'] as const;
type Step = (typeof STEPS)[number];

const bigButton =
  'w-full rounded-xl bg-accent py-3.5 font-semibold text-white active:bg-accent-deep disabled:opacity-40';
const choice = (active: boolean) =>
  `w-full rounded-xl border px-4 py-3.5 text-left ${active ? 'border-accent bg-accent-soft' : 'border-line bg-card'}`;
const field = 'rounded-xl border border-line bg-card px-3 py-3 text-center text-xl font-semibold tabular-nums';

export default function Onboarding() {
  const [stepIndex, setStepIndex] = useState(0);
  const [units, setUnits] = useState<Units>('imperial');
  const [sex, setSex] = useState<Sex | null>(null);
  const [birthDate, setBirthDate] = useState('1990-01-01');
  const [heightCm, setHeightCm] = useState(ftInToCm(5, 8));
  const [weightInput, setWeightInput] = useState('180');
  const [goalInput, setGoalInput] = useState('165');
  const [rateIndex, setRateIndex] = useState(1);
  const [activity, setActivity] = useState<ActivityLevel | null>(null);

  const step: Step = STEPS[stepIndex];
  const next = () => setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  const back = () => setStepIndex((i) => Math.max(i - 1, 0));

  const toKg = (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return units === 'imperial' ? lbToKg(n) : n;
  };

  const rates =
    units === 'imperial'
      ? [0.5, 1, 1.5, 2].map((lb) => ({ kg: lbToKg(lb), label: `${lb} lb per week` }))
      : [0.25, 0.5, 0.75, 1].map((kg) => ({ kg, label: `${kg} kg per week` }));

  const { ft, inch } = cmToFtIn(heightCm);
  const startWeightKg = toKg(weightInput);
  const goalWeightKg = toKg(goalInput);

  const draft =
    sex && activity && startWeightKg
      ? {
          sex,
          birthDate,
          heightCm,
          startWeightKg,
          activityLevel: activity,
          weeklyRateKg: rates[rateIndex].kg,
        }
      : null;
  const result = draft ? computeBudget(draft, todayStr()) : null;

  function switchUnits(nextUnits: Units) {
    if (nextUnits === units) return;
    const convert = (v: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return v;
      const kg = units === 'imperial' ? lbToKg(n) : n;
      return (nextUnits === 'imperial' ? kgToLb(kg) : kg).toFixed(0);
    };
    setWeightInput(convert(weightInput));
    setGoalInput(convert(goalInput));
    setUnits(nextUnits);
  }

  async function finish() {
    if (!draft || !goalWeightKg) return;
    const today = todayStr();
    await db.transaction('rw', [db.profile, db.weights], async () => {
      await db.profile.put({
        id: PROFILE_ID,
        ...draft,
        goalWeightKg,
        units,
        createdAt: new Date().toISOString(),
      });
      await db.weights.put({ id: newId(), date: today, weightKg: draft.startWeightKg });
    });
  }

  const unitToggle = (
    <div className="mx-auto grid w-56 grid-cols-2 rounded-xl bg-card p-1 text-center text-xs font-semibold">
      {(['imperial', 'metric'] as Units[]).map((u) => (
        <button
          key={u}
          type="button"
          onClick={() => switchUnits(u)}
          className={`rounded-lg py-1.5 capitalize ${units === u ? 'bg-accent text-white' : 'text-ink-secondary'}`}
        >
          {u}
        </button>
      ))}
    </div>
  );

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pt-[calc(2rem+env(safe-area-inset-top))] pb-8">
      <div className="mb-8 flex justify-center gap-1.5">
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={`h-1.5 rounded-full transition-all ${
              i === stepIndex ? 'w-6 bg-accent' : 'w-1.5 bg-line'
            }`}
          />
        ))}
      </div>

      {step === 'welcome' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <h1 className="text-5xl font-bold tracking-tight">
            Bend It<span className="text-amber">!</span>
          </h1>
          <p className="text-ink-secondary">{STRINGS.splash}</p>
          <p className="text-sm text-ink-muted">
            Set a daily calorie budget, log what you eat and the exercise you do, and watch what's
            left. That's the whole app.
          </p>
          <button type="button" onClick={next} className={`${bigButton} mt-6`}>
            Get Started
          </button>
        </div>
      )}

      {step === 'sex' && (
        <div className="flex flex-1 flex-col gap-3">
          <h2 className="mb-2 text-2xl font-bold">Which formula should we use?</h2>
          <p className="mb-2 text-sm text-ink-muted">
            The calorie math (Mifflin-St Jeor) differs by sex.
          </p>
          {(['female', 'male'] as Sex[]).map((s) => (
            <button key={s} type="button" onClick={() => { setSex(s); next(); }} className={choice(sex === s)}>
              <span className="font-semibold capitalize">{s}</span>
            </button>
          ))}
        </div>
      )}

      {step === 'birth' && (
        <div className="flex flex-1 flex-col gap-4">
          <h2 className="text-2xl font-bold">When were you born?</h2>
          <input
            type="date"
            value={birthDate}
            max={todayStr()}
            onChange={(e) => setBirthDate(e.target.value)}
            className={`${field} text-base`}
          />
          <button type="button" onClick={next} disabled={!birthDate} className={bigButton}>
            Next
          </button>
        </div>
      )}

      {step === 'height' && (
        <div className="flex flex-1 flex-col gap-4">
          <h2 className="text-2xl font-bold">How tall are you?</h2>
          {unitToggle}
          {units === 'imperial' ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-center text-xs text-ink-muted">
                feet
                <input type="number" min={3} max={8} value={ft} onChange={(e) => setHeightCm(ftInToCm(Number(e.target.value) || 0, inch))} className={field} />
              </label>
              <label className="flex flex-col gap-1 text-center text-xs text-ink-muted">
                inches
                <input type="number" min={0} max={11} value={inch} onChange={(e) => setHeightCm(ftInToCm(ft, Number(e.target.value) || 0))} className={field} />
              </label>
            </div>
          ) : (
            <label className="flex flex-col gap-1 text-center text-xs text-ink-muted">
              centimeters
              <input type="number" min={90} max={250} value={Math.round(heightCm)} onChange={(e) => setHeightCm(Number(e.target.value) || 0)} className={field} />
            </label>
          )}
          <button type="button" onClick={next} disabled={heightCm < 90} className={bigButton}>
            Next
          </button>
        </div>
      )}

      {step === 'weight' && (
        <div className="flex flex-1 flex-col gap-4">
          <h2 className="text-2xl font-bold">What do you weigh now?</h2>
          {unitToggle}
          <label className="flex flex-col gap-1 text-center text-xs text-ink-muted">
            {units === 'imperial' ? 'pounds' : 'kilograms'}
            <input type="number" inputMode="decimal" value={weightInput} onChange={(e) => setWeightInput(e.target.value)} className={field} />
          </label>
          <button type="button" onClick={next} disabled={!startWeightKg} className={bigButton}>
            Next
          </button>
        </div>
      )}

      {step === 'goal' && (
        <div className="flex flex-1 flex-col gap-4">
          <h2 className="text-2xl font-bold">What's your goal weight?</h2>
          <label className="flex flex-col gap-1 text-center text-xs text-ink-muted">
            {units === 'imperial' ? 'pounds' : 'kilograms'}
            <input type="number" inputMode="decimal" value={goalInput} onChange={(e) => setGoalInput(e.target.value)} className={field} />
          </label>
          <button type="button" onClick={next} disabled={!goalWeightKg} className={bigButton}>
            Next
          </button>
        </div>
      )}

      {step === 'rate' && (
        <div className="flex flex-1 flex-col gap-3">
          <h2 className="mb-2 text-2xl font-bold">How fast do you want to get there?</h2>
          {rates.map((r, i) => (
            <button key={r.label} type="button" onClick={() => { setRateIndex(i); next(); }} className={choice(rateIndex === i)}>
              <span className="font-semibold">{r.label}</span>
            </button>
          ))}
        </div>
      )}

      {step === 'activity' && (
        <div className="flex flex-1 flex-col gap-3">
          <h2 className="mb-2 text-2xl font-bold">How active are you?</h2>
          {ACTIVITY_OPTIONS.map((o) => (
            <button key={o.value} type="button" onClick={() => { setActivity(o.value); next(); }} className={choice(activity === o.value)}>
              <span className="block font-semibold">{o.title}</span>
              <span className="block text-xs text-ink-muted">{o.sub}</span>
            </button>
          ))}
        </div>
      )}

      {step === 'reveal' && result && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <p className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Your daily budget
          </p>
          <p className="text-6xl font-bold tabular-nums text-accent">
            {formatCalories(result.budget)}
          </p>
          <p className="text-ink-secondary">{STRINGS.budgetReveal(formatCalories(result.budget))}</p>
          {result.floored && (
            <p className="flex items-start gap-2 rounded-xl bg-over-soft p-3 text-left text-sm text-over">
              <WarnIcon className="mt-0.5 h-4 w-4 shrink-0" />
              {STRINGS.aggressiveRate}
            </p>
          )}
          <button type="button" onClick={finish} className={`${bigButton} mt-4`}>
            Start Tracking
          </button>
        </div>
      )}

      {stepIndex > 0 && step !== 'reveal' && (
        <button type="button" onClick={back} className="mt-4 text-sm font-medium text-ink-muted">
          Back
        </button>
      )}
      {step === 'reveal' && (
        <button type="button" onClick={back} className="mt-4 text-sm font-medium text-ink-muted">
          Adjust my answers
        </button>
      )}
    </div>
  );
}
