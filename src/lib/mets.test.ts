import { describe, expect, it } from 'vitest';
import { caloriesBurned, parseMinutes } from './mets';

describe('parseMinutes', () => {
  it('reads a typed duration', () => {
    expect(parseMinutes('30')).toBe(30);
    expect(parseMinutes(' 45 ')).toBe(45);
  });

  it('lets the box be empty while the old duration is deleted', () => {
    // "30" → backspace → "3" → backspace → "". The empty box used to become 1,
    // which then could not be deleted, so every duration started with a 1.
    expect(parseMinutes('3')).toBe(3);
    expect(parseMinutes('')).toBeNull();
    expect(parseMinutes('   ')).toBeNull();
  });

  it('refuses a duration that is not a positive whole number', () => {
    expect(parseMinutes('0')).toBeNull();
    expect(parseMinutes('-5')).toBeNull();
    expect(parseMinutes('0.4')).toBeNull();
    expect(parseMinutes('abc')).toBeNull();
  });

  it('rounds a fraction of a minute', () => {
    expect(parseMinutes('20.6')).toBe(21);
  });
});

describe('caloriesBurned', () => {
  it('scales with the METs, the weight, and the minutes', () => {
    expect(caloriesBurned(8, 80, 30)).toBe(336);
    expect(caloriesBurned(8, 80, 60)).toBe(672);
  });
});
