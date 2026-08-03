import { describe, expect, it } from 'vitest';
import { expandUpcE, isValidBarcode, normalizeBarcode } from './barcode';

describe('normalizeBarcode', () => {
  it('keeps only digits, however the code arrives', () => {
    expect(normalizeBarcode(' 8712345678906 ')).toBe('8712345678906');
    expect(normalizeBarcode('871-234-567-8906')).toBe('8712345678906');
  });

  it('keeps leading zeros — they are part of the number', () => {
    expect(normalizeBarcode('049000006346')).toBe('049000006346');
  });
});

describe('isValidBarcode', () => {
  it('accepts real codes at each length', () => {
    expect(isValidBarcode('8712345678906')).toBe(true); // EAN-13
    expect(isValidBarcode('049000006346')).toBe(true); // UPC-A
    expect(isValidBarcode('96385074')).toBe(true); // EAN-8
  });

  it('rejects a single wrong digit — the whole point of the check digit', () => {
    expect(isValidBarcode('8712345678906')).toBe(true);
    expect(isValidBarcode('8712345678905')).toBe(false); // check digit off by one
    expect(isValidBarcode('8712345679906')).toBe(false); // a body digit misread
  });

  it('rejects a transposition, which is what a person typing gets wrong', () => {
    expect(isValidBarcode('8712345687906')).toBe(false);
  });

  it('rejects anything that is not a barcode length', () => {
    expect(isValidBarcode('')).toBe(false);
    expect(isValidBarcode('12345')).toBe(false);
    expect(isValidBarcode('871234567890')).toBe(false); // 12 digits, but not a valid UPC-A
  });
});

describe('expandUpcE', () => {
  // Each compression mode removes a different run of zeros. The expansion is
  // right when the resulting UPC-A passes its own check digit, because that
  // digit was computed from the full-length code in the first place.
  // The last digit of the short form is the check digit of the long one, not a
  // separate number — the compression drops zeros, nothing else.
  const cases: [string, string][] = [
    ['04963406', '049000006346'], // mode 0
    ['04567834', '045600000784'], // mode 3
    ['04567840', '045670000080'], // mode 4
    ['01278965', '012789000065'], // modes 5–9
  ];

  it.each(cases)('expands %s to %s', (short, full) => {
    expect(expandUpcE(short)).toBe(full);
    expect(isValidBarcode(expandUpcE(short))).toBe(true);
  });

  it('leaves anything that is not eight digits alone', () => {
    expect(expandUpcE('049000006346')).toBe('049000006346');
  });
});
