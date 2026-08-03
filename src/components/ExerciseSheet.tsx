import { useState } from 'react';
import { api } from '../lib/api';
import { formatCalories } from '../lib/units';
import type { ExerciseEntry } from '../types';
import Sheet from './Sheet';

// Editing a logged workout, matching how food entries behave. Calories scale
// with the minutes, since that's how they were worked out in the first place.
export default function ExerciseSheet({
  entry,
  onClose,
  onChanged,
}: {
  entry: ExerciseEntry;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [minutes, setMinutes] = useState(entry.minutes);
  const perMinute = entry.minutes > 0 ? entry.caloriesBurned / entry.minutes : 0;
  const burned = Math.round(perMinute * minutes);

  return (
    <Sheet onClose={onClose}>
      <h2 className="mb-1 text-lg font-semibold">{entry.name}</h2>
      <p className="mb-4 text-sm text-ink-muted">Adjust how long it lasted.</p>

      <div className="mb-4 flex items-center justify-center gap-4">
        <button
          type="button"
          aria-label="Fewer minutes"
          onClick={() => setMinutes((m) => Math.max(1, m - 5))}
          className="h-11 w-11 rounded-full border border-line text-xl font-medium text-ink-secondary active:bg-surface"
        >
          −
        </button>
        <div className="flex flex-col items-center">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={minutes}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) setMinutes(v);
            }}
            className="w-24 rounded-xl border border-line bg-surface py-2 text-center text-2xl font-semibold tabular-nums"
            aria-label="Minutes"
          />
          <span className="mt-1 text-xs text-ink-muted">minutes</span>
        </div>
        <button
          type="button"
          aria-label="More minutes"
          onClick={() => setMinutes((m) => m + 5)}
          className="h-11 w-11 rounded-full border border-line text-xl font-medium text-ink-secondary active:bg-surface"
        >
          +
        </button>
      </div>

      <p className="mb-4 text-center text-2xl font-bold tabular-nums text-good">
        +{formatCalories(burned)}
        <span className="ml-1 text-xs font-medium uppercase tracking-wide text-ink-muted">cal</span>
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => api.deleteExercise(entry.id).then(onChanged)}
          className="rounded-xl border border-over px-4 py-3.5 text-sm font-semibold text-over"
        >
          Remove
        </button>
        <button
          type="button"
          onClick={() =>
            api.updateExercise(entry.id, { minutes, caloriesBurned: burned }).then(onChanged)
          }
          className="flex-1 rounded-xl bg-accent py-3.5 font-semibold text-white"
        >
          Save changes
        </button>
      </div>
    </Sheet>
  );
}
