import { describe, expect, it } from 'vitest';
import { dayOf, leftUntil } from './PicnicHome';

describe('leftUntil', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  it('counts down in minutes, hours, then days', () => {
    expect(leftUntil('2026-10-20T12:40:00Z', now)).toBe('40 min left');
    expect(leftUntil('2026-10-20T17:30:00Z', now)).toBe('5 h left');
    expect(leftUntil('2026-10-21T13:00:00Z', now)).toBe('1 day left');
    expect(leftUntil('2026-10-23T12:00:00Z', now)).toBe('3 days left');
  });
  it('is null once the cutoff has passed', () => {
    expect(leftUntil('2026-10-20T11:00:00Z', now)).toBeNull();
  });
});

describe('dayOf', () => {
  it('says today and tomorrow, else the date', () => {
    expect(dayOf('2026-10-20T15:00:00', '2026-10-20')).toBe('today');
    expect(dayOf('2026-10-21T15:00:00', '2026-10-20')).toBe('tomorrow');
    expect(dayOf('2026-10-23T15:00:00', '2026-10-20')).toBe('Fri 23 Oct');
  });
});
