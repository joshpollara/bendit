import { useState } from 'react';
import { api } from '../lib/api';
import { computeBudget, dailyDeficit, MIN_BUDGET } from '../lib/budget';
import { budgetFromExpenditure, hasDrifted, type Expenditure } from '../lib/expenditure';
import { todayStr } from '../lib/dates';
import { formatCalories } from '../lib/units';
import { useUI } from '../store/ui';
import type { Profile } from '../types';

// Measured expenditure, next to the formula's guess — and the option to make it
// your budget. The whole feature is arithmetic on data the app already has.

export default function ExpenditureCard({
  profile,
  measured,
  latestTrendKg,
  className,
}: {
  profile: Profile;
  measured: Expenditure | undefined;
  latestTrendKg?: number;
  className?: string;
}) {
  const bump = useUI((s) => s.bump);
  const [saving, setSaving] = useState(false);

  // formulaTdee, not tdee: once a measurement is adopted, computeBudget returns
  // the measured figure — this card must keep showing what the formula alone says.
  const formulaTdee = Math.round(computeBudget(profile, todayStr(), latestTrendKg).formulaTdee);
  const usingMeasured = profile.budgetSource === 'measured' && profile.measuredTdee != null;

  async function adopt(source: 'measured' | 'formula') {
    setSaving(true);
    await api.putProfile({
      ...profile,
      budgetSource: source,
      measuredTdee: source === 'measured' ? (measured?.tdee ?? null) : null,
    });
    bump();
    setSaving(false);
  }

  if (!measured) {
    return (
      <section className={className}>
        <h2 className="mb-1 font-semibold">Your real expenditure</h2>
        <p className="text-sm text-ink-secondary">
          Once you've logged food on most days for a couple of weeks and weighed in across them,
          this works out what you actually burn — from your own intake and weight trend, not a
          formula.
        </p>
      </section>
    );
  }

  const suggested = budgetFromExpenditure(
    measured.tdee,
    dailyDeficit(profile.weeklyRateKg),
    MIN_BUDGET[profile.sex],
  );
  const gap = measured.tdee - formulaTdee;
  const drifted =
    usingMeasured && hasDrifted(profile.measuredTdee as number, measured.tdee);

  return (
    <section className={className}>
      <h2 className="mb-1 font-semibold">Your real expenditure</h2>
      <p className="mb-3 text-xs text-ink-muted">
        From {measured.loggedDays} logged days over {measured.days}: what you ate, adjusted for
        what your trend weight did. Exercise is already inside this number.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-surface px-3 py-2.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Measured
          </span>
          <p className="text-lg font-semibold tabular-nums text-accent-deep">
            {formatCalories(measured.tdee)}
          </p>
        </div>
        <div className="rounded-xl bg-surface px-3 py-2.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Formula says
          </span>
          <p className="text-lg font-semibold tabular-nums">{formatCalories(formulaTdee)}</p>
        </div>
      </div>

      <p className="mt-3 text-sm text-ink-secondary">
        {Math.abs(gap) < 75 ? (
          <>The formula has you about right — within {formatCalories(Math.abs(gap))} calories a day.</>
        ) : (
          <>
            You burn{' '}
            <strong className="tabular-nums">{formatCalories(Math.abs(gap))}</strong> calories a day{' '}
            {gap > 0 ? 'more' : 'less'} than the formula assumes.
          </>
        )}{' '}
        A {profile.weeklyRateKg.toFixed(2)} kg/week loss from here means a budget of{' '}
        <strong className="tabular-nums">{formatCalories(suggested)}</strong>.
      </p>

      {usingMeasured ? (
        <div className="mt-3 flex items-center gap-2">
          <p className="flex-1 text-xs text-ink-muted">
            {drifted
              ? 'Your measured expenditure has moved since you adopted it.'
              : 'Your budget is measured from your own data.'}
          </p>
          {drifted && (
            <button
              type="button"
              disabled={saving}
              onClick={() => adopt('measured')}
              className="rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              Update
            </button>
          )}
          <button
            type="button"
            disabled={saving}
            onClick={() => adopt('formula')}
            className="rounded-xl border border-line px-3 py-2 text-xs font-semibold text-ink-secondary"
          >
            Back to formula
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={saving || measured.coverage < 0.7}
          onClick={() => adopt('measured')}
          className="mt-3 w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {measured.coverage < 0.7
            ? 'Log a few more days to use this'
            : `Use ${formatCalories(suggested)} as my budget`}
        </button>
      )}
    </section>
  );
}
