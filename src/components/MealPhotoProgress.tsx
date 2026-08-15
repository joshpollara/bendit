import { useEffect, useState } from 'react';
import type { MealPhotoStage } from '../lib/mealPhoto';
import { ClockIcon } from './Icons';

const LONG_WAIT_SECONDS = 8;

export default function MealPhotoProgress({ stage }: { stage: MealPhotoStage }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const preparing = stage === 'preparing';
  const label = preparing ? 'Preparing your photo…' : 'Analyzing your meal…';
  const detail = preparing
    ? 'Optimizing the image before it is sent.'
    : elapsedSeconds >= LONG_WAIT_SECONDS
      ? 'Detailed meals can take a little longer. Analysis is still running.'
      : 'Identifying foods, estimating portions, and cross-checking nutrition.';

  return (
    <div className="mx-4 mt-3 rounded-xl bg-accent-soft px-3 py-3 text-accent-deep lg:mx-0">
      <div className="flex items-start gap-3">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-card text-accent"
          aria-hidden="true"
        >
          <ClockIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div role="status" aria-live="polite" aria-atomic="true" className="min-h-11 min-w-0">
              <p className="text-sm font-semibold">{label}</p>
              <p className="mt-0.5 text-xs leading-4 text-ink-secondary">{detail}</p>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-ink-muted" aria-hidden="true">
              {elapsedSeconds}s
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Meal photo analysis in progress"
            aria-valuetext={label}
            className="mt-2 h-1 overflow-hidden rounded-full bg-card"
          >
            <span className="meal-photo-progress block h-full w-1/3 rounded-full bg-accent" />
          </div>
        </div>
      </div>
    </div>
  );
}
