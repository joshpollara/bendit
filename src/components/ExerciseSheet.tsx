import { useState } from 'react';
import { api } from '../lib/api';
import { parseMinutes } from '../lib/mets';
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
  // Text, so the box can be emptied on the way to another duration.
  const [minutes, setMinutes] = useState(String(entry.minutes));
  const mins = parseMinutes(minutes);
  const perMinute = entry.minutes > 0 ? entry.caloriesBurned / entry.minutes : 0;
  const burned = Math.round(perMinute * (mins ?? 0));

  return (
    <Sheet onClose={onClose}>
      <h2 className="mb-1 text-lg font-semibold">{entry.name}</h2>
      <p className="mb-4 text-sm text-ink-muted">Adjust how long it lasted.</p>

      <div className="mb-4 flex items-center justify-center gap-4">
        <button
          type="button"
          aria-label="Fewer minutes"
          onClick={() => setMinutes((m) => String(Math.max(1, (parseMinutes(m) ?? 0) - 5)))}
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
            onChange={(e) => setMinutes(e.target.value)}
            className="w-24 rounded-xl border border-line bg-surface py-2 text-center text-2xl font-semibold tabular-nums"
            aria-label="Minutes"
          />
          <span className="mt-1 text-xs text-ink-muted">minutes</span>
        </div>
        <button
          type="button"
          aria-label="More minutes"
          onClick={() => setMinutes((m) => String((parseMinutes(m) ?? 0) + 5))}
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
          disabled={mins === null}
          onClick={() =>
            mins !== null &&
            api.updateExercise(entry.id, { minutes: mins, caloriesBurned: burned }).then(onChanged)
          }
          className="flex-1 rounded-xl bg-accent py-3.5 font-semibold text-white disabled:opacity-40"
        >
          Save changes
        </button>
      </div>
    </Sheet>
  );
}
