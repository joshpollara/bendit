import { describe, expect, it } from 'vitest';
import { gradeLines, recipeTips } from './recipeTips.mjs';

const line = (grade, grams) => ({ grade, grams });

describe('gradeLines', () => {
  it('averages grades by weight, and gives none when too little is graded', () => {
    expect(gradeLines([line('A', 300), line('E', 100)])).toBe('B');
    expect(gradeLines([line('A', 100), line(null, 300)])).toBeNull();
  });
});

describe('recipeTips', () => {
  it('says nothing for an A, or an ungraded recipe', () => {
    expect(recipeTips([line('A', 400)])).toEqual([]);
    expect(recipeTips([line(null, 400)])).toEqual([]);
  });

  it('offers halving before leaving out, and leaving out when only that gets there', () => {
    // 600 g at A and 100 g of E is a B; half the E is an A.
    expect(recipeTips([line('A', 600), line('E', 100)])[0]).toEqual({ kind: 'halve', index: 1, to: 'A' });
    expect(recipeTips([line('A', 600), line('E', 100)]).some((t) => t.kind === 'leave_out')).toBe(false);
    // With 200 g of E, only leaving it out gets there.
    expect(recipeTips([line('A', 600), line('E', 200), line('C', 50)])[0]).toEqual({
      kind: 'leave_out',
      index: 1,
      to: 'A',
    });
  });

  it('puts several changes together when no single one reaches A', () => {
    const lines = [line('A', 500), line('D', 100), line('E', 100), line('C', 50)];
    const together = recipeTips(lines).find((t) => t.kind === 'together');
    expect(together.to).toBe('A');
    expect(
      gradeLines(lines.map((l, i) => (together.changes.some((c) => c.index === i) ? { ...l, grams: 0 } : l))),
    ).toBe('A');
  });

  it('works out how many vegetables would get there', () => {
    const lines = [line('A', 100), line('D', 300)];
    const veg = recipeTips(lines).find((t) => t.kind === 'add_veg');
    expect(veg).toMatchObject({ to: 'B' });
    expect(gradeLines([...lines, line('A', veg.grams)])).toBe('B');
    expect(gradeLines([...lines, line('A', veg.grams - 50)])).toBe('C');
  });
});
