import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { useNow } from '../lib/useNow';
import { atTime, clock, fastMs, goalPct } from '../lib/fasting';
import { useUI } from '../store/ui';
import type { Profile } from '../types';
import { ClockIcon } from './Icons';

// The fasting clock on the day screen: the running total and the two things
// you do with it. The rest — history, corrections, the goal — is on /fasting.
export default function FastingCard({ profile }: { profile: Profile }) {
  const data = useData(() => api.fasts(), []);
  const bump = useUI((s) => s.bump);
  const [error, setError] = useState<string | null>(null);

  const current = data?.current ?? null;
  const now = useNow(!!current);

  if (!data) return null;

  const elapsed = current ? fastMs(current, now) : 0;
  const pct = current ? goalPct(elapsed, current.goalHours) : 0;

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      bump();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="mx-4 mt-3 rounded-2xl border border-line bg-card px-4 py-3 shadow-sm lg:mx-0 lg:mt-0">
      <div className="flex items-center gap-2">
        <ClockIcon className="h-4 w-4 text-ink-muted" />
        <Link to="/fasting" className="text-sm font-semibold">
          Fasting
        </Link>
        <span className="flex-1" />
        {current ? (
          <>
            <span className="text-sm font-semibold tabular-nums">{clock(elapsed)}</span>
            {current.goalHours && (
              <span className="text-xs text-ink-muted">of {current.goalHours}h</span>
            )}
            <button
              type="button"
              onClick={() => run(() => api.updateFast(current.id, { endedAt: new Date().toISOString() }))}
              className="rounded-full px-2 py-1 text-xs font-semibold text-accent hover:bg-accent-soft"
            >
              End
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => run(() => api.startFast({ goalHours: profile.fastGoalHours ?? 16 }))}
            className="rounded-full px-2 py-1 text-xs font-semibold text-accent hover:bg-accent-soft"
          >
            Start
          </button>
        )}
      </div>

      {/* No goal, no bar: a track that can never fill reads as a broken one. */}
      {current?.goalHours ? (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-line" role="presentation">
          <div
            className={`h-full rounded-full transition-all ${pct >= 100 ? 'bg-good' : 'bg-accent'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}

      {current && <p className="mt-2 text-xs text-ink-muted">Since {atTime(current.startedAt)}</p>}

      {error && <p className="mt-2 text-xs text-over">{error}</p>}
    </section>
  );
}
