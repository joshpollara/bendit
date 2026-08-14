import { format, parseISO } from 'date-fns';
import type { Fast } from '../types';

// A fast is measured off the clock it was started on, not off the food log.
// Everything here is arithmetic on two instants; nothing consults a date.

export const HOUR_MS = 3_600_000;

/** How long a fast has run, or ran. One still going is measured against now. */
export function fastMs(fast: Fast, now: number = Date.now()): number {
  const started = Date.parse(fast.startedAt);
  const ended = fast.endedAt ? Date.parse(fast.endedAt) : now;
  return Math.max(0, ended - started);
}

/** H:MM:SS. A running clock without seconds looks broken. */
export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

/** "16h 24m" — how a finished fast reads back. */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes % 60}m`;
}

export const goalPct = (ms: number, goalHours?: number | null): number =>
  goalHours && goalHours > 0 ? Math.min(100, (ms / (goalHours * HOUR_MS)) * 100) : 0;

export const metGoal = (fast: Fast, now?: number): boolean =>
  !!fast.goalHours && fastMs(fast, now) >= fast.goalHours * HOUR_MS;

/** The time of day a fast turned, written the way a clock face is read. */
export const atTime = (iso: string): string => format(parseISO(iso), 'HH:mm');

/** Day and time together, for a fast that has scrolled out of living memory. */
export const atDayTime = (iso: string): string => format(parseISO(iso), 'EEE d MMM, HH:mm');

// <input type="datetime-local"> speaks local wall time with no zone attached,
// so both directions go through the browser's own idea of local.
export const toLocalInput = (iso: string): string =>
  format(parseISO(iso), "yyyy-MM-dd'T'HH:mm");

export function fromLocalInput(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export interface FastSummary {
  count: number;
  averageMs: number;
  longestMs: number;
  metCount: number;
}

/** Over finished fasts only: one still running has no length yet, just a total so far. */
export function summarize(fasts: Fast[]): FastSummary {
  const done = fasts.filter((f) => f.endedAt);
  if (done.length === 0) return { count: 0, averageMs: 0, longestMs: 0, metCount: 0 };
  const lengths = done.map((f) => fastMs(f));
  return {
    count: done.length,
    averageMs: lengths.reduce((sum, ms) => sum + ms, 0) / done.length,
    longestMs: Math.max(...lengths),
    metCount: done.filter((f) => metGoal(f)).length,
  };
}
