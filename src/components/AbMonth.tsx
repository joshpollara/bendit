import { useState } from 'react';
import { Link } from 'react-router-dom';
import { addMonths, format, getDaysInMonth, parseISO } from 'date-fns';
import { api, type AbMonth } from '../lib/api';
import { useData } from '../lib/useData';
import { useUI } from '../store/ui';

// An A/B month: a goal for how much of what you eat is graded Nutri-Score A
// or B, and how it's going. Shares are of the calories that could be graded.

const TARGETS = [0.5, 0.6, 0.7, 0.8];
const pct = (share: number | null) => (share == null ? '—' : `${Math.round(share * 100)}%`);
/** Under this much of a day graded, its share says little. */
const THIN = 0.5;

function DayBars({ data }: { data: AbMonth }) {
  const first = parseISO(`${data.month}-01`);
  const byDate = new Map(data.days.map((d) => [d.date, d]));
  const target = data.goal?.target ?? 0;
  return (
    <div className="mt-3 flex h-12 items-end gap-[2px]" aria-hidden="true">
      {Array.from({ length: getDaysInMonth(first) }, (_, i) => {
        const date = `${data.month}-${String(i + 1).padStart(2, '0')}`;
        const day = byDate.get(date);
        const share = day?.share ?? null;
        return (
          <div key={date} className="flex h-full flex-1 items-end rounded-sm bg-line/50" title={`${date}: ${pct(share)}`}>
            {share != null && (
              <div
                className={`w-full rounded-sm ${share >= target ? 'bg-good' : 'bg-warn'} ${
                  (day?.covered ?? 0) < THIN ? 'opacity-40' : ''
                }`}
                style={{ height: `${Math.max(6, share * 100)}%` }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The month's goal and progress, with day bars; or a way to start one. */
export function AbMonthCard({ className = '' }: { className?: string }) {
  const bump = useUI((s) => s.bump);
  const [month, setMonth] = useState(() => format(new Date(), 'yyyy-MM'));
  const data = useData(() => api.abMonth(month), [month]);
  const [target, setTarget] = useState(0.7);
  const [busy, setBusy] = useState(false);

  async function save(next: number | null) {
    setBusy(true);
    try {
      if (next == null) await api.clearAbGoal(month);
      else await api.setAbGoal(month, next);
      bump();
    } finally {
      setBusy(false);
    }
  }

  const shift = (n: number) => setMonth(format(addMonths(parseISO(`${month}-01`), n), 'yyyy-MM'));

  return (
    <section id="ab-month" className={`rounded-2xl border border-line bg-card p-4 shadow-sm ${className}`}>
      <div className="flex items-center gap-2">
        <h2 className="flex-1 font-semibold">A/B month</h2>
        <button type="button" aria-label="Previous month" onClick={() => shift(-1)} className="px-2 text-ink-secondary">
          ‹
        </button>
        <span className="text-sm tabular-nums text-ink-secondary">{format(parseISO(`${month}-01`), 'MMM yyyy')}</span>
        <button type="button" aria-label="Next month" onClick={() => shift(1)} className="px-2 text-ink-secondary">
          ›
        </button>
      </div>

      {!data ? (
        <p className="py-4 text-center text-sm text-ink-muted">Loading…</p>
      ) : data.goal ? (
        <>
          <p className="mt-2 text-3xl font-semibold tabular-nums">
            {pct(data.total.share)}
            <span className="ml-2 text-sm font-normal text-ink-secondary">A/B · goal {pct(data.goal.target)}</span>
          </p>
          <p className="text-xs text-ink-muted">
            {data.total.daysLogged > 0
              ? `${data.total.daysOnTarget} of ${data.total.daysLogged} days on target · ${pct(data.total.covered)} of calories graded`
              : 'Nothing logged yet this month.'}
          </p>
          <DayBars data={data} />
          <div className="mt-3 flex items-center gap-2 text-sm">
            <label className="flex flex-1 items-center gap-2 text-ink-secondary">
              Goal
              <select
                value={data.goal.target}
                disabled={busy}
                onChange={(e) => void save(Number(e.target.value))}
                className="rounded-lg border border-line bg-card px-2 py-1"
              >
                {[...new Set([...TARGETS, data.goal.target])].sort().map((t) => (
                  <option key={t} value={t}>
                    {pct(t)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => window.confirm('Stop the A/B month?') && void save(null)}
              className="text-xs text-ink-muted underline"
            >
              Stop
            </button>
          </div>
        </>
      ) : (
        <div className="mt-2">
          <p className="text-sm text-ink-secondary">
            Aim for most of what you eat this month to be graded A or B.
            {data.total.daysLogged > 0 ? ` So far: ${pct(data.total.share)}.` : ''}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <div className="grid flex-1 grid-cols-4 gap-1 rounded-xl bg-surface p-1 text-center text-xs font-semibold">
              {TARGETS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTarget(t)}
                  className={`rounded-lg py-1.5 ${target === t ? 'bg-accent text-white' : 'text-ink-secondary'}`}
                >
                  {pct(t)}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(target)}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Start
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Today's A/B share against the month's goal, when there is one. */
export function AbToday({ date }: { date: string }) {
  const month = date.slice(0, 7);
  const data = useData(() => api.abMonth(month), [month]);
  if (!data?.goal) return null;
  const today = data.days.find((d) => d.date === date);
  const share = today?.share ?? null;
  const target = data.goal.target;
  return (
    <Link
      to="/nutri-score#ab-month"
      className="mx-4 mt-3 block rounded-2xl border border-line bg-card px-4 py-3 shadow-sm lg:mx-0 lg:mt-0"
    >
      <div className="flex items-baseline justify-between text-sm">
        <h2 className="font-semibold">A/B today</h2>
        <span className="tabular-nums text-ink-secondary">
          {pct(share)} · goal {pct(target)}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-line" role="presentation">
        {share != null && (
          <div
            className={`h-full rounded-full ${share >= target ? 'bg-good' : 'bg-warn'}`}
            style={{ width: `${Math.round(share * 100)}%` }}
          />
        )}
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        {today && today.covered < THIN
          ? `Only ${pct(today.covered)} of today's calories could be graded · month ${pct(data.total.share)}`
          : `Month so far ${pct(data.total.share)}`}
      </p>
    </Link>
  );
}
