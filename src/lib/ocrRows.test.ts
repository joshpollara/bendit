import { describe, expect, it } from 'vitest';
import { itemsToLines, itemsToText, type OcrItem } from './ocrRows';

// Builds a word-box table like a detector would emit: each cell one box, laid
// out in rows, optionally rotated around the origin by `deg`.
function table(rows: string[][], deg = 0): OcrItem[] {
  const theta = (deg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const items: OcrItem[] = [];
  rows.forEach((cells, r) => {
    cells.forEach((text, c) => {
      // Column widths vary like a real label: label column wide, value narrow.
      // Rotate each snippet's CENTER — a detector's axis-aligned boxes have
      // their centers on the rotated row, whatever the snippet's width.
      const width = text.length * 9;
      const height = 16;
      const cx0 = (c === 0 ? 10 : 240) + width / 2;
      const cy0 = 20 + r * 24 + height / 2;
      const cx = cx0 * cos - cy0 * sin;
      const cy = cx0 * sin + cy0 * cos;
      items.push({
        text,
        box: { x: cx - width / 2, y: cy - height / 2, width, height },
        confidence: 0.9,
      });
    });
  });
  return items;
}

const NL_ROWS = [
  ['Voedingswaarde', 'per 100 g'],
  ['Energie', '2100 kJ / 502 kcal'],
  ['Vetten', '28,5 g'],
  ['waarvan verzadigde vetzuren', '3,1 g'],
  ['Koolhydraten', '48,2 g'],
  ['waarvan suikers', '22,4 g'],
  ['Vezels', '3,5 g'],
  ['Eiwitten', '8,6 g'],
  ['Zout', '0,45 g'],
];

describe('itemsToLines', () => {
  it('joins an upright table into label-value rows', () => {
    const lines = itemsToLines(table(NL_ROWS));
    expect(lines).toContain('Eiwitten 8,6 g');
    expect(lines).toContain('Vetten 28,5 g');
    expect(lines).toHaveLength(NL_ROWS.length);
  });

  it.each([3, 5, -4, 7])('keeps rows intact at %d° tilt', (deg) => {
    const lines = itemsToLines(table(NL_ROWS, deg));
    // The failure mode this exists to prevent: protein paired with the salt
    // value from the next row.
    expect(lines).toContain('Eiwitten 8,6 g');
    expect(lines).toContain('Zout 0,45 g');
    expect(lines).toContain('Koolhydraten 48,2 g');
    expect(lines).toHaveLength(NL_ROWS.length);
  });

  it('orders words left-to-right within a row even when emitted shuffled', () => {
    const shuffled = [...table(NL_ROWS, 4)].reverse();
    expect(itemsToLines(shuffled)).toContain('Energie 2100 kJ / 502 kcal');
  });

  it('handles empty and single-item input', () => {
    expect(itemsToLines([])).toEqual([]);
    expect(itemsToLines([{ text: 'hi', box: { x: 0, y: 0, width: 10, height: 10 }, confidence: 1 }])).toEqual(['hi']);
  });
});

describe('itemsToText', () => {
  it('produces newline-separated text the label parser can read', () => {
    const text = itemsToText(table(NL_ROWS, -4));
    expect(text.split('\n')).toHaveLength(NL_ROWS.length);
    expect(text).toMatch(/Eiwitten 8,6 g/);
  });
});
