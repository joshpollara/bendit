import { lazy, Suspense, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useSearchParams } from 'react-router-dom';
import { subMonths, subYears, format } from 'date-fns';
import { db, newId } from '../db/db';
import { DAY, shortDate, todayStr } from '../lib/dates';
import { formatWeight, kgToLb, lbToKg } from '../lib/units';
import { STRINGS } from '../lib/strings';
import type { Profile } from '../types';
import Sheet from '../components/Sheet';
import { PlusIcon, XIcon } from '../components/Icons';

// recharts is heavy; split it out of the main bundle.
const WeightChart = lazy(() => import('../components/WeightChart'));

type Range = '1M' | '3M' | '1Y' | 'All';

const RANGES: Range[] = ['1M', '3M', '1Y', 'All'];

function cutoff(range: Range): string | null {
  const now = new Date();
  if (range === '1M') return format(subMonths(now, 1), DAY);
  if (range === '3M') return format(subMonths(now, 3), DAY);
  if (range === '1Y') return format(subYears(now, 1), DAY);
  return null;
}

export default function Weight({ profile }: { profile: Profile }) {
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useState<Range>('3M');
  const [logging, setLogging] = useState(false);
  const [weightInput, setWeightInput] = useState('');
  const [dateInput, setDateInput] = useState(todayStr());

  const entries = useLiveQuery(() => db.weights.orderBy('date').toArray(), []) ?? [];

  // ?log=1 (from quick-add) opens the log sheet immediately.
  useEffect(() => {
    if (params.get('log') === '1') {
      openLog();
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const latest = entries[entries.length - 1];
  const startKg = profile.startWeightKg;
  const goalKg = profile.goalWeightKg;
  const losing = goalKg <= startKg;
  const lostKg = latest ? startKg - latest.weightKg : 0;
  const toGoKg = latest ? latest.weightKg - goalKg : startKg - goalKg;
  const goalReached = latest && (losing ? latest.weightKg <= goalKg : latest.weightKg >= goalKg);

  const from = cutoff(range);
  const visible = from ? entries.filter((e) => e.date >= from) : entries;

  function openLog() {
    const currentKg = entries.length ? entries[entries.length - 1].weightKg : profile.startWeightKg;
    const display = profile.units === 'imperial' ? kgToLb(currentKg) : currentKg;
    setWeightInput(display.toFixed(1));
    setDateInput(todayStr());
    setLogging(true);
  }

  async function saveWeight() {
    const value = Number(weightInput);
    if (!Number.isFinite(value) || value <= 0) return;
    const weightKg = profile.units === 'imperial' ? lbToKg(value) : value;
    const existing = await db.weights.where('date').equals(dateInput).first();
    await db.weights.put({ id: existing?.id ?? newId(), date: dateInput, weightKg });
    setLogging(false);
  }

  const stat = (label: string, value: string, tone = '') => (
    <div className="flex flex-col items-center">
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</span>
    </div>
  );

  return (
    <div className="pt-[env(safe-area-inset-top)]">
      <header className="flex items-center justify-between px-4 py-3">
        <h1 className="text-lg font-semibold">Weight</h1>
        <button
          type="button"
          onClick={openLog}
          className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white active:bg-accent-deep"
        >
          <PlusIcon className="h-4 w-4" /> Log Weight
        </button>
      </header>

      <section className="mx-4 rounded-2xl border border-line bg-card p-4 shadow-sm">
        <div className="flex items-center justify-around">
          {stat('Current', latest ? formatWeight(latest.weightKg, profile.units) : '—')}
          {stat('Goal', formatWeight(goalKg, profile.units))}
          {losing
            ? stat(
                lostKg >= 0 ? 'Lost' : 'Gained',
                latest ? formatWeight(Math.abs(lostKg), profile.units) : '—',
                lostKg > 0 ? 'text-good' : '',
              )
            : stat('Gained', latest ? formatWeight(Math.max(0, -lostKg), profile.units) : '—')}
          {stat('To go', goalReached ? '0' : formatWeight(Math.abs(toGoKg), profile.units))}
        </div>
        {goalReached && <p className="mt-3 text-center text-sm font-medium text-good">{STRINGS.goalReached}</p>}
      </section>

      <section className="mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Progress</h2>
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
        </div>
        {visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-muted">{STRINGS.noWeights}</p>
        ) : (
          <Suspense fallback={<div className="h-60" />}>
            <WeightChart entries={visible} goalKg={goalKg} units={profile.units} />
          </Suspense>
        )}
      </section>

      {entries.length > 0 && (
        <section className="mx-4 mt-3 mb-4 overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
          <h2 className="border-b border-line px-4 py-3 font-semibold">History</h2>
          <ul>
            {[...entries].reverse().slice(0, 60).map((e) => (
              <li
                key={e.id}
                className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
              >
                <span className="flex-1 text-sm">{shortDate(e.date)}</span>
                <span className="text-sm font-medium tabular-nums">
                  {formatWeight(e.weightKg, profile.units)}
                </span>
                <button
                  type="button"
                  aria-label={`Delete weight from ${e.date}`}
                  onClick={() => db.weights.delete(e.id)}
                  className="rounded-full p-1 text-ink-muted hover:bg-surface hover:text-over"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {logging && (
        <Sheet onClose={() => setLogging(false)}>
          <h2 className="mb-4 text-lg font-semibold">Log Weight</h2>
          <div className="mb-4 grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-secondary">
                Weight ({profile.units === 'imperial' ? 'lb' : 'kg'})
              </span>
              <input
                type="number"
                inputMode="decimal"
                step={0.1}
                value={weightInput}
                onChange={(e) => setWeightInput(e.target.value)}
                className="rounded-xl border border-line bg-surface px-3 py-2.5 text-lg font-semibold tabular-nums"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-secondary">Date</span>
              <input
                type="date"
                value={dateInput}
                max={todayStr()}
                onChange={(e) => setDateInput(e.target.value)}
                className="rounded-xl border border-line bg-surface px-3 py-2.5 text-sm"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={saveWeight}
            className="w-full rounded-xl bg-accent py-3.5 font-semibold text-white active:bg-accent-deep"
          >
            Save
          </button>
        </Sheet>
      )}
    </div>
  );
}
