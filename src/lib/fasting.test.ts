import { describe, expect, it } from 'vitest';
import {
  clock,
  duration,
  fastMs,
  fromLocalInput,
  goalPct,
  HOUR_MS,
  metGoal,
  summarize,
  toLocalInput,
} from './fasting';
import type { Fast } from '../types';

const at = (iso: string) => Date.parse(iso);

const fast = (startedAt: string, endedAt?: string | null, goalHours?: number | null): Fast => ({
  id: startedAt,
  startedAt,
  endedAt: endedAt ?? null,
  goalHours: goalHours ?? null,
});

describe('fastMs', () => {
  it('measures a finished fast between its two instants', () => {
    expect(fastMs(fast('2026-08-13T20:00:00Z', '2026-08-14T12:00:00Z'))).toBe(16 * HOUR_MS);
  });

  it('measures a running fast against now', () => {
    const running = fast('2026-08-14T06:00:00Z');
    expect(fastMs(running, at('2026-08-14T14:30:00Z'))).toBe(8.5 * HOUR_MS);
  });

  // The whole point of storing instants: the eating window ran 8pm to 1am, so
  // the fast starts at 1am on the 14th and midnight is not a boundary.
  it('counts straight through midnight', () => {
    expect(fastMs(fast('2026-08-14T01:00:00Z', '2026-08-14T17:00:00Z'))).toBe(16 * HOUR_MS);
  });

  it('never goes negative when the end precedes the start', () => {
    expect(fastMs(fast('2026-08-14T12:00:00Z', '2026-08-14T11:00:00Z'))).toBe(0);
  });
});

describe('clock', () => {
  it('reads H:MM:SS', () => {
    expect(clock(0)).toBe('0:00:00');
    expect(clock(61_000)).toBe('0:01:01');
    expect(clock(16 * HOUR_MS + 24 * 60_000 + 5_000)).toBe('16:24:05');
  });

  it('keeps counting past a day rather than wrapping', () => {
    expect(clock(36 * HOUR_MS)).toBe('36:00:00');
  });
});

describe('duration', () => {
  it('drops the hours when there are none', () => {
    expect(duration(45 * 60_000)).toBe('45m');
  });

  it('reads hours and minutes otherwise', () => {
    expect(duration(16 * HOUR_MS + 24 * 60_000)).toBe('16h 24m');
    expect(duration(18 * HOUR_MS)).toBe('18h 0m');
  });
});

describe('goalPct', () => {
  it('is the share of the goal reached', () => {
    expect(goalPct(8 * HOUR_MS, 16)).toBe(50);
  });

  it('stops at full rather than overflowing the ring', () => {
    expect(goalPct(20 * HOUR_MS, 16)).toBe(100);
  });

  it('is nothing without a goal', () => {
    expect(goalPct(8 * HOUR_MS, null)).toBe(0);
  });
});

describe('metGoal', () => {
  it('needs a goal to meet', () => {
    expect(metGoal(fast('2026-08-13T20:00:00Z', '2026-08-14T20:00:00Z'))).toBe(false);
  });

  it('is met on the hour, not after it', () => {
    const sixteen = fast('2026-08-13T20:00:00Z', '2026-08-14T12:00:00Z', 16);
    expect(metGoal(sixteen)).toBe(true);
    expect(metGoal(fast('2026-08-13T20:00:00Z', '2026-08-14T11:59:00Z', 16))).toBe(false);
  });
});

describe('summarize', () => {
  const fasts = [
    fast('2026-08-13T20:00:00Z', '2026-08-14T12:00:00Z', 16), // 16h, met
    fast('2026-08-12T20:00:00Z', '2026-08-13T14:00:00Z', 16), // 18h, met
    fast('2026-08-11T20:00:00Z', '2026-08-12T08:00:00Z', 16), // 12h, missed
  ];

  it('averages, finds the longest, and counts the goals met', () => {
    const summary = summarize(fasts);
    expect(summary.count).toBe(3);
    expect(summary.averageMs).toBeCloseTo((46 / 3) * HOUR_MS, 5);
    expect(summary.longestMs).toBe(18 * HOUR_MS);
    expect(summary.metCount).toBe(2);
  });

  // A fast still going has a length that keeps changing; averaging it in would
  // make every earlier number move every second.
  it('ignores a fast that is still running', () => {
    expect(summarize([...fasts, fast('2026-08-14T20:00:00Z')]).count).toBe(3);
  });

  it('has nothing to say about no fasts', () => {
    expect(summarize([])).toEqual({ count: 0, averageMs: 0, longestMs: 0, metCount: 0 });
  });
});

describe('datetime-local round trip', () => {
  // Whatever the machine's zone, an instant written into the input and read
  // back out has to be the same instant.
  it('returns the instant it was given, to the minute', () => {
    const iso = '2026-08-14T01:00:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
  });

  it('refuses something that isn’t a time', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('yesterday')).toBeNull();
  });
});
