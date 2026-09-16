import { dayImpact, type Addition, type DayStanding, type TargetStatus } from '../lib/macros';
import { formatCalories } from '../lib/units';

// Where the day would stand with this entry in it: calories and each tracked
// macro, as what's already eaten, what this adds, and what that comes to
// against the target. The bar carries the day so far in full colour and this
// entry faded, so the size of the step is visible and not only the total.

export const STATUS_FILL: Record<TargetStatus, string> = {
  ok: 'bg-accent',
  good: 'bg-good',
  over: 'bg-over',
};

export const STATUS_TEXT: Record<TargetStatus, string> = {
  ok: '',
  good: 'text-good',
  over: 'text-over',
};

export default function DayImpact({
  day,
  adding,
  title = 'The day with this in it',
}: {
  day: DayStanding;
  adding: Addition;
  title?: string;
}) {
  const rows = dayImpact(day, adding);
  const show = (key: string, n: number) =>
    key === 'calories' ? formatCalories(n) : String(Math.round(n));

  return (
    <section className="mb-4 rounded-xl bg-surface p-3" aria-label={title}>
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{title}</h3>
      <ul className="mt-2 flex flex-col gap-2.5">
        {rows.map((row) => {
          const status = row.status ?? 'ok';
          return (
            <li key={row.key}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium">{row.label}</span>
                <span className="tabular-nums text-ink-secondary">
                  {show(row.key, row.before)}
                  {row.adding != null ? (
                    ` + ${show(row.key, row.adding)}`
                  ) : (
                    <span title="Not recorded for this food"> + ?</span>
                  )}
                  {' = '}
                  <strong className={row.target != null ? STATUS_TEXT[status] : ''}>
                    {show(row.key, row.after)}
                    {row.unit}
                  </strong>
                  {row.target != null && (
                    <span className="text-ink-muted">
                      {' '}
                      of {show(row.key, row.target)}
                      {row.unit}
                    </span>
                  )}
                </span>
              </div>
              {row.target != null && (
                <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-line" role="presentation">
                  <div
                    className={`h-full ${STATUS_FILL[status]}`}
                    style={{ width: `${row.beforeShare * 100}%` }}
                  />
                  <div
                    className={`h-full ${STATUS_FILL[status]} opacity-50`}
                    style={{ width: `${(row.afterShare - row.beforeShare) * 100}%` }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
