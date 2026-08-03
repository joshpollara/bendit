import { describe, expect, it } from 'vitest';
import { barcodeVariants } from './barcode.mjs';

describe('barcodeVariants', () => {
  it('tries the scanned form first', () => {
    expect(barcodeVariants('8712345678906')[0]).toBe('8712345678906');
  });

  it('pads a UPC-A to its EAN-13 form', () => {
    // The same tin of soup is '049000006346' in one database and
    // '0049000006346' in the next.
    expect(barcodeVariants('049000006346')).toEqual(['049000006346', '0049000006346']);
  });

  it('drops the padding zero the other way round', () => {
    expect(barcodeVariants('0049000006346')).toEqual(['0049000006346', '049000006346']);
  });

  it('reads the product out of a GTIN-14 case code', () => {
    expect(barcodeVariants('08712345678906')).toEqual(['08712345678906', '8712345678906']);
  });

  it('leaves an EAN-13 alone — nothing to pad', () => {
    expect(barcodeVariants('8712345678906')).toEqual(['8712345678906']);
  });

  it('never strips zeros that carry meaning', () => {
    // A short code padded out would otherwise match an unrelated food.
    expect(barcodeVariants('0000000000005')).toEqual(['0000000000005', '000000000005']);
  });

  it('has nothing to look up for junk', () => {
    expect(barcodeVariants('')).toEqual([]);
    expect(barcodeVariants('abc')).toEqual([]);
    expect(barcodeVariants(null)).toEqual([]);
  });
});
