import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import type { DayTotals } from '../lib/report';
import { formatCalories } from '../lib/units';

// A month at a glance: which days you logged, which you closed. Consistency
// made visible without turning it into a streak to protect.

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function monthKey(date: string): string {
  return date.slice(0, 7);
}

/** Every date in the month of `key` (YYYY-MM), plus the blanks before day 1. */
function monthGrid(key: string): (string | null)[] {
  const first = new Date(`${key}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Monday-first
  const days: (string | null)[] = Array.from({ length: lead }, () => null);
  const cursor = new Date(first);
  while (cursor.getUTCMonth() === first.getUTCMonth()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export default function LoggingCalendar({
  days,
  done,
  today,
  className,
}: {
  days: DayTotals[];
  done: string[];
  today: string;
  className?: string;
}) {
  const months = [...new Set(days.map((d) => monthKey(d.date)))].sort();
  const [index, setIndex] = useState(Math.max(0, months.length - 1));
  const key = months[Math.min(index, months.length - 1)] ?? monthKey(today);

  const byDate = new Map(days.map((d) => [d.date, d]));
  const closed = new Set(done);

  const inMonth = days.filter((d) => monthKey(d.date) === key);
  const loggedCount = inMonth.filter((d) => d.entries > 0).length;

  return (
    <section className={className}>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold">Logging calendar</h2>
        <div className="flex items-center gap-1 text-sm">
          <button
            type="button"
            aria-label="Previous month"
            disabled={index <= 0}
            onClick={() => setIndex((i) => i - 1)}
            className="rounded-full px-2 py-1 text-ink-secondary disabled:opacity-30"
          >
            ‹
          </button>
          <span className="w-24 text-center text-xs font-medium tabular-nums">
            {format(parseISO(`${key}-01`), 'MMMM yyyy')}
          </span>
          <button
            type="button"
            aria-label="Next month"
            disabled={index >= months.length - 1}
            onClick={() => setIndex((i) => i + 1)}
            className="rounded-full px-2 py-1 text-ink-secondary disabled:opacity-30"
          >
            ›
          </button>
        </div>
      </div>
      <p className="mb-3 text-xs text-ink-muted">
        {loggedCount} of {inMonth.length} days logged this month.
      </p>

      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w, i) => (
          <span key={i} className="text-[10px] font-medium uppercase text-ink-muted">
            {w}
          </span>
        ))}
        {monthGrid(key).map((date, i) => {
          if (!date) return <span key={`blank-${i}`} />;
          const day = byDate.get(date);
          const logged = (day?.entries ?? 0) > 0;
          const isClosed = closed.has(date);
          const future = date > today;
          const net = day ? Math.round(day.food - day.exercise) : 0;
          return (
            <span
              key={date}
              title={logged ? `${date}: ${formatCalories(net)} cal` : date}
              className={`flex aspect-square items-center justify-center rounded-lg text-[11px] tabular-nums ${
                future
                  ? 'text-ink-muted/40'
                  : isClosed
                    ? 'bg-good-soft font-semibold text-good'
                    : logged
                      ? 'bg-accent-soft font-medium text-accent-deep'
                      : 'bg-surface text-ink-muted'
              } ${date === today ? 'ring-1 ring-accent' : ''}`}
            >
              {Number(date.slice(8))}
            </span>
          );
        })}
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-secondary">
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-accent-soft" aria-hidden="true" /> logged
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-good-soft" aria-hidden="true" /> closed
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-surface" aria-hidden="true" /> nothing logged
        </li>
      </ul>
    </section>
  );
}
