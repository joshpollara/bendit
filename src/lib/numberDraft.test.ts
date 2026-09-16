import { describe, expect, it } from 'vitest';
import { parseNumberDraft } from './numberDraft';

describe('parseNumberDraft', () => {
  it.each(['', ' ', '0', '-1', 'not a number', 'Infinity'])(
    'rejects an invalid edit draft: %j',
    (value) => {
      expect(parseNumberDraft(value)).toBeNull();
    },
  );

  it('accepts a positive decimal', () => {
    expect(parseNumberDraft(' 125.5 ')).toBe(125.5);
  });

  it('accepts zero only when asked to', () => {
    expect(parseNumberDraft('0', { allowZero: true })).toBe(0);
    expect(parseNumberDraft('', { allowZero: true })).toBeNull();
    expect(parseNumberDraft('-1', { allowZero: true })).toBeNull();
  });
});
