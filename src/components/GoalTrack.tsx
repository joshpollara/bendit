import { formatWeight } from '../lib/units';
import type { Units } from '../types';
import { FlagIcon, PersonIcon } from './Icons';

// Where you stand between start weight and goal, as a walk along a track:
// you at your current trend weight, the flag at the goal. Works in either
// direction (losing or gaining).

export default function GoalTrack({
  startKg,
  goalKg,
  currentKg,
  units,
}: {
  startKg: number;
  goalKg: number;
  currentKg: number;
  units: Units;
}) {
  const span = goalKg - startKg;
  if (span === 0) return null;

  const raw = (currentKg - startKg) / span; // 0 at start, 1 at goal
  const progress = Math.max(0, Math.min(1, raw));
  const pct = Math.round(progress * 100);
  // Keep the figure clear of the edge labels.
  const markerPct = 8 + progress * 84;

  const toGoKg = Math.abs(goalKg - currentKg);
  const done = progress >= 1;

  return (
    <div>
      <div className="relative mt-10 mb-1">
        {/* The walker, above the current spot on the track. */}
        <div
          className="absolute -top-9 flex -translate-x-1/2 flex-col items-center"
          style={{ left: `${markerPct}%` }}
        >
          <PersonIcon className="h-7 w-7 text-accent" />
          <span className="text-[11px] font-semibold tabular-nums text-accent-deep">
            {formatWeight(currentKg, units, 1)}
          </span>
        </div>

        <div className="h-2.5 overflow-hidden rounded-full bg-line">
          <div
            className={`h-full rounded-full ${done ? 'bg-good' : 'bg-accent'}`}
            style={{ width: `${Math.max(2, progress * 100)}%` }}
          />
        </div>

        <FlagIcon
          className={`absolute -top-7 right-0 h-6 w-6 ${done ? 'text-good' : 'text-ink-muted'}`}
        />
      </div>

      <div className="flex justify-between text-[11px] text-ink-muted">
        <span className="tabular-nums">{formatWeight(startKg, units, 0)}</span>
        <span className="tabular-nums">{formatWeight(goalKg, units, 0)}</span>
      </div>

      <p className="mt-2 text-center text-sm text-ink-secondary">
        {done ? (
          <strong className="text-good">You're at your goal.</strong>
        ) : (
          <>
            <strong className="tabular-nums">{pct}%</strong> of the way —{' '}
            <span className="tabular-nums">{formatWeight(toGoKg, units)}</span> to go.
          </>
        )}
      </p>
    </div>
  );
}
