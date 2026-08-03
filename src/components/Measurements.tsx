import { useState } from 'react';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { shortDate, todayStr } from '../lib/dates';
import { cmToIn, inToCm } from '../lib/units';
import { useUI } from '../store/ui';
import { MEASUREMENT_SITES, type MeasurementSite, type Units } from '../types';
import { PlusIcon } from './Icons';
import Sheet from './Sheet';

// The tape measure, which tells the truth on weeks when the scale doesn't:
// recomposition shows up here first.

const SITE_LABELS: Record<MeasurementSite, string> = {
  waist: 'Waist',
  hips: 'Hips',
  chest: 'Chest',
  thigh: 'Thigh',
  arm: 'Arm',
  neck: 'Neck',
};

export default function Measurements({ units }: { units: Units }) {
  const bump = useUI((s) => s.bump);
  const all = useData(() => api.listMeasurements(), []) ?? [];
  const [logging, setLogging] = useState(false);
  const [site, setSite] = useState<MeasurementSite>('waist');
  const [value, setValue] = useState('');
  const [date, setDate] = useState(todayStr());

  const metric = units === 'metric';
  const unitLabel = metric ? 'cm' : 'in';
  const show = (cm: number) => (metric ? cm : cmToIn(cm)).toFixed(1);

  // Latest and first reading per site, for the "since you started" column.
  const bySite = MEASUREMENT_SITES.map((s) => {
    const entries = all.filter((m) => m.site === s);
    return { site: s, first: entries[0], latest: entries[entries.length - 1], count: entries.length };
  }).filter((row) => row.count > 0);

  function openLogger(preset: MeasurementSite) {
    const existing = all.filter((m) => m.site === preset).at(-1);
    setSite(preset);
    setValue(existing ? show(existing.valueCm) : '');
    setDate(todayStr());
    setLogging(true);
  }

  async function save() {
    const entered = Number(value);
    if (!Number.isFinite(entered) || entered <= 0) return;
    await api.putMeasurement({ date, site, valueCm: metric ? entered : inToCm(entered) });
    setLogging(false);
    bump();
  }

  return (
    <section className="mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm lg:mx-0 lg:mt-0">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold">Measurements</h2>
        <button
          type="button"
          onClick={() => openLogger('waist')}
          className="flex items-center gap-1.5 rounded-full border border-accent px-3 py-1.5 text-xs font-semibold text-accent"
        >
          <PlusIcon className="h-4 w-4" /> Log
        </button>
      </div>

      {bySite.length === 0 ? (
        <p className="py-3 text-sm text-ink-muted">
          A waist measurement once a week catches progress the scale hides on a bad water day.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {bySite.map((row) => {
            const change = row.latest.valueCm - row.first.valueCm;
            const changed = row.count > 1 && Math.abs(change) >= 0.05;
            return (
              <li key={row.site}>
                <button
                  type="button"
                  onClick={() => openLogger(row.site)}
                  className="flex w-full items-center gap-3 py-2.5 text-left"
                >
                  <span className="flex-1 text-sm">{SITE_LABELS[row.site]}</span>
                  <span className="text-sm font-medium tabular-nums">
                    {show(row.latest.valueCm)} {unitLabel}
                  </span>
                  <span
                    className={`w-20 text-right text-xs tabular-nums ${
                      changed ? (change < 0 ? 'text-good' : 'text-ink-secondary') : 'text-ink-muted'
                    }`}
                  >
                    {changed
                      ? `${change > 0 ? '+' : '−'}${show(Math.abs(change))} ${unitLabel}`
                      : shortDate(row.latest.date)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {logging && (
        <Sheet onClose={() => setLogging(false)}>
          <h2 className="mb-3 text-lg font-semibold">Log a measurement</h2>
          <div className="mb-3 grid grid-cols-3 gap-2">
            {MEASUREMENT_SITES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSite(s);
                  const existing = all.filter((m) => m.site === s).at(-1);
                  setValue(existing ? show(existing.valueCm) : '');
                }}
                className={`rounded-full py-2 text-xs font-semibold ${
                  site === s ? 'bg-accent text-white' : 'bg-surface text-ink-secondary'
                }`}
              >
                {SITE_LABELS[s]}
              </button>
            ))}
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-secondary">{SITE_LABELS[site]} ({unitLabel})</span>
              <input
                type="number"
                inputMode="decimal"
                step={0.1}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="rounded-xl border border-line bg-surface px-3 py-2.5 text-lg font-semibold tabular-nums"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-secondary">Date</span>
              <input
                type="date"
                value={date}
                max={todayStr()}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-xl border border-line bg-surface px-3 py-2.5 text-sm"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={save}
            className="w-full rounded-xl bg-accent py-3.5 font-semibold text-white active:bg-accent-deep"
          >
            Save
          </button>
        </Sheet>
      )}
    </section>
  );
}
