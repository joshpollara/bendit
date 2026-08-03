import { describe, expect, it } from 'vitest';
import { ocrToLabel } from './labelRead';
import type { ParsedLabel } from './labelParse';

// readLabel itself needs a camera photo and a canvas; what's testable here is
// the translation the fallback depends on — an OCR result becoming the same
// shape the model returns, so one validator serves both.

const parsed = (over: Partial<ParsedLabel> = {}): ParsedLabel => ({
  basis: 'serving',
  calories: 150,
  protein: 5,
  carbs: 27,
  fat: 3,
  servingLabel: '1/2 cup (40g)',
  servingGrams: 40,
  found: ['calories', 'protein', 'carbs', 'fat'],
  ...over,
});

describe('ocrToLabel', () => {
  it('puts a per-serving read in the per-serving column', () => {
    const label = ocrToLabel(parsed());
    expect(label.perServing?.calories).toBe(150);
    expect(label.per100).toBeNull();
    expect(label.servingGrams).toBe(40);
  });

  it('puts a Dutch per-100g read in the per-100 column', () => {
    // Getting this backwards would triple or third every number that follows.
    const label = ocrToLabel(parsed({ basis: '100g', servingGrams: 100 }));
    expect(label.per100?.calories).toBe(150);
    expect(label.perServing).toBeNull();
    expect(label.basis).toBe('g');
  });

  it('carries a millilitre basis through', () => {
    const label = ocrToLabel(parsed({ basis: '100ml' }));
    expect(label.basis).toBe('ml');
    expect(label.per100).toBeTruthy();
  });

  it('never claims high confidence for an on-device read', () => {
    expect(ocrToLabel(parsed()).confidence).toBe('medium');
  });

  it('passes missing values through as missing, not zero', () => {
    const label = ocrToLabel(parsed({ protein: null, fat: null }));
    expect(label.perServing?.protein).toBeNull();
    expect(label.perServing?.fat).toBeNull();
  });
});
