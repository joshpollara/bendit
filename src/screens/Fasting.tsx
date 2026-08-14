import { useState } from 'react';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { useNow } from '../lib/useNow';
import {
  atDayTime,
  atTime,
  clock,
  duration,
  fastMs,
  fromLocalInput,
  goalPct,
  metGoal,
  summarize,
  toLocalInput,
} from '../lib/fasting';
import { useUI } from '../store/ui';
import { FAST_GOALS, type Fast, type Profile } from '../types';
import Sheet from '../components/Sheet';
import { CheckIcon, ClockIcon, PlusIcon, StopIcon, TrashIcon } from '../components/Icons';

function GoalChips({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (hours: number | null) => void;
}) {
  const chip = (hours: number | null, label: string) => (
    <button
      key={label}
      type="button"
      onClick={() => onChange(hours)}
      aria-pressed={value === hours}
      className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
        value === hours ? 'bg-accent text-white' : 'border border-line text-ink-secondary hover:bg-surface'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-wrap gap-1.5">
      {FAST_GOALS.map((hours) => chip(hours, `${hours}h`))}
      {chip(null, 'None')}
    </div>
  );
}

// One sheet for all three corrections: a fast that began earlier than you got
// round to saying, one whose start was off, and one whose end was.
function FastSheet({
  fast,
  defaultGoal,
  onClose,
  onSaved,
}: {
  fast: Fast | null;
  defaultGoal: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [started, setStarted] = useState(() =>
    toLocalInput(fast?.startedAt ?? new Date().toISOString()),
  );
  const [ended, setEnded] = useState(() => (fast?.endedAt ? toLocalInput(fast.endedAt) : ''));
  const [goal, setGoal] = useState<number | null>(fast ? (fast.goalHours ?? null) : defaultGoal);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    const startedAt = fromLocalInput(started);
    if (!startedAt) return setError("That start time isn't a time.");
    const endedAt = ended ? fromLocalInput(ended) : null;
    if (ended && !endedAt) return setError("That end time isn't a time.");

    setSaving(true);
    setError(null);
    try {
      if (fast) await api.updateFast(fast.id, { startedAt, endedAt, goalHours: goal });
      else await api.startFast({ startedAt, endedAt, goalHours: goal });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  const field = 'rounded-xl border border-line bg-surface px-3 py-2.5 text-sm';

  return (
    <Sheet onClose={onClose}>
      <h2 className="mb-4 text-lg font-semibold">{fast ? 'Edit fast' : 'Add a fast'}</h2>

      {/* An empty end is a fast still on the clock, which is what makes this
          one form serve a fast you are starting, one you started earlier and
          one you finished without ever saying you'd begun. */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-secondary">Started</span>
          <input
            type="datetime-local"
            value={started}
            onChange={(e) => setStarted(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-secondary">Ended</span>
          <input
            type="datetime-local"
            value={ended}
            onChange={(e) => setEnded(e.target.value)}
            className={field}
          />
        </label>
      </div>

      <div className="mb-4">
        <p className="mb-2 text-sm text-ink-secondary">Goal</p>
        <GoalChips value={goal} onChange={setGoal} />
      </div>

      {error && <p className="mb-3 text-sm text-over">{error}</p>}

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="w-full rounded-xl bg-accent py-3.5 font-semibold text-white active:bg-accent-deep disabled:opacity-50"
      >
        {fast ? 'Save' : ended ? 'Add' : 'Start'}
      </button>
    </Sheet>
  );
}

function Ring({ pct, children }: { pct: number; children: React.ReactNode }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="relative mx-auto h-40 w-40">
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
        <circle cx="64" cy="64" r={radius} fill="none" stroke="var(--color-line)" strokeWidth="8" />
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          stroke={pct >= 100 ? 'var(--color-good)' : 'var(--color-accent)'}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

export default function Fasting({ profile }: { profile: Profile }) {
  const data = useData(() => api.fasts(), []);
  const bump = useUI((s) => s.bump);

  const current = data?.current ?? null;
  const recent = data?.recent ?? [];

  const now = useNow(!!current);
  const [goal, setGoal] = useState<number | null>(profile.fastGoalHours ?? 16);
  const [editing, setEditing] = useState<Fast | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const elapsed = current ? fastMs(current, now) : 0;
  const pct = current ? goalPct(elapsed, current.goalHours) : 0;
  const summary = summarize(recent.slice(0, 7));

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      bump();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // The goal you pick before starting is the one the next fast gets too.
  async function start() {
    await run(async () => {
      await api.startFast({ goalHours: goal });
      if ((profile.fastGoalHours ?? null) !== goal) {
        await api.putProfile({ ...profile, fastGoalHours: goal });
      }
    });
  }

  const stat = (label: string, value: string) => (
    <div className="flex flex-col items-center">
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  );

  return (
    <div className="pt-[env(safe-area-inset-top)]">
      <header className="flex items-center justify-between px-4 py-3 lg:px-0 lg:pb-4 lg:pt-0">
        <h1 className="text-lg font-semibold lg:text-2xl lg:font-bold lg:tracking-tight">Fasting</h1>
      </header>

      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-4">
        <section className="mx-4 rounded-2xl border border-line bg-card p-5 shadow-sm lg:mx-0">
          {current ? (
            <>
              <Ring pct={pct}>
                <span className="text-2xl font-bold tabular-nums">{clock(elapsed)}</span>
                <span className="mt-1 text-xs text-ink-muted">
                  {current.goalHours ? `of ${current.goalHours}h` : 'elapsed'}
                </span>
              </Ring>

              <div className="mt-4 flex items-center justify-center gap-2 text-sm text-ink-secondary">
                <ClockIcon className="h-4 w-4" />
                <span>Started {atDayTime(current.startedAt)}</span>
                <button
                  type="button"
                  onClick={() => setEditing(current)}
                  className="font-medium text-accent"
                >
                  Edit
                </button>
              </div>

              <button
                type="button"
                onClick={() => run(() => api.updateFast(current.id, { endedAt: new Date().toISOString() }))}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3.5 font-semibold text-white active:bg-accent-deep"
              >
                <StopIcon className="h-4 w-4" /> End fast
              </button>
            </>
          ) : (
            <>
              <Ring pct={0}>
                <span className="text-2xl font-bold tabular-nums text-ink-muted">0:00:00</span>
                <span className="mt-1 text-xs text-ink-muted">{goal ? `of ${goal}h` : 'no goal'}</span>
              </Ring>

              <div className="mt-4">
                <p className="mb-2 text-sm text-ink-secondary">Goal</p>
                <GoalChips value={goal} onChange={setGoal} />
              </div>

              <button
                type="button"
                onClick={start}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3.5 font-semibold text-white active:bg-accent-deep"
              >
                <PlusIcon className="h-4 w-4" /> Start fasting
              </button>
            </>
          )}

          {/* Also reachable mid-fast: the one you forgot to write down is
              usually remembered while a later one is already running. */}
          <button
            type="button"
            onClick={() => setStarting(true)}
            className="mt-2 w-full py-1 text-sm font-medium text-accent"
          >
            Add a fast
          </button>

          {error && <p className="mt-3 text-center text-sm text-over">{error}</p>}
        </section>

        <div className="lg:space-y-4">
          {summary.count > 0 && (
            <section className="mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm lg:mx-0 lg:mt-0">
              <h2 className="mb-3 text-sm font-semibold">
                {summary.count === 1 ? 'Last fast' : `Last ${summary.count} fasts`}
              </h2>
              <div className="flex items-center justify-around">
                {stat('Average', duration(summary.averageMs))}
                {stat('Longest', duration(summary.longestMs))}
                {stat('Goals met', `${summary.metCount}`)}
              </div>
            </section>
          )}

          <section className="mx-4 mt-3 mb-4 overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:mx-0 lg:mb-0 lg:mt-0">
            <h2 className="border-b border-line px-4 py-3 font-semibold">History</h2>
            {recent.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-muted">No fasts recorded yet.</p>
            ) : (
              <ul className="lg:max-h-96 lg:overflow-y-auto">
                {recent.map((fast) => (
                  <li
                    key={fast.id}
                    className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => setEditing(fast)}
                      aria-label={`Edit the fast started ${atDayTime(fast.startedAt)}`}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-sm font-medium">
                        {atDayTime(fast.startedAt)} → {atTime(fast.endedAt!)}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {fast.goalHours ? `${fast.goalHours}h goal` : 'No goal'}
                      </p>
                    </button>
                    {metGoal(fast) && <CheckIcon className="h-4 w-4 shrink-0 text-good" />}
                    <span className="text-sm font-medium tabular-nums">{duration(fastMs(fast))}</span>
                    <button
                      type="button"
                      aria-label={`Delete the fast started ${atDayTime(fast.startedAt)}`}
                      onClick={() => run(() => api.deleteFast(fast.id))}
                      className="rounded-full p-1 text-ink-muted hover:bg-surface hover:text-over"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {(editing || starting) && (
        <FastSheet
          fast={editing}
          defaultGoal={goal}
          onClose={() => {
            setEditing(null);
            setStarting(false);
          }}
          onSaved={() => {
            setEditing(null);
            setStarting(false);
            bump();
          }}
        />
      )}
    </div>
  );
}
