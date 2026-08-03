import { describe, expect, it } from 'vitest';
import { parseLabel, rescale } from './labelParse';

// These fixtures are what OCR actually hands back: lowercase-ish, ragged
// spacing, columns flattened onto one line, the odd letter/digit confusion.

const US_PANEL = `
HARVEST GROVE
Rolled Oats, Old Fashioned
Nutrition Facts
About 13 servings per container
Serving size 1/2 cup dry (40g)
Amount per serving
Calories 150
% Daily Value*
Total Fat 3g 4%
Saturated Fat 0.5g 3%
Sodium 0mg 0%
Total Carbohydrate 27g 10%
Dietary Fiber 4g 14%
Total Sugars 1g
Protein 5g
`;

const NL_PANEL = `
Voedingswaarde
per 100 g
Energie 2100 kJ / 502 kcal
Vetten 28,5 g
waarvan verzadigde vetzuren 3,1 g
Koolhydraten 48,2 g
waarvan suikers 22,4 g
Vezels 3,5 g
Eiwitten 8,6 g
Zout 0,45 g
`;

const NL_WITH_PORTION = `
Voedingswaarde per 100 g
Energie 1450 kJ / 345 kcal
Vetten 12,0 g
Koolhydraten 45,0 g
Eiwitten 9,5 g
Portiegrootte 45 g
`;

const KJ_ONLY = `
Nutrition per 100 g
Energy 1674 kJ
Fat 10 g
Carbohydrate 60 g
Protein 12 g
`;

describe('parseLabel — US per-serving panel', () => {
  const r = parseLabel(US_PANEL);

  it('reads the macros', () => {
    expect(r.calories).toBe(150);
    expect(r.fat).toBe(3);
    expect(r.carbs).toBe(27);
    expect(r.protein).toBe(5);
  });

  it('takes the serving size, not the sub-nutrient rows', () => {
    expect(r.basis).toBe('serving');
    expect(r.servingLabel).toBe('1/2 cup dry (40g)');
    expect(r.servingGrams).toBe(40);
  });

  it('does not mistake saturated fat, fiber, or sugars for the main macro', () => {
    expect(r.fat).not.toBe(0.5);
    expect(r.carbs).not.toBe(4);
    expect(r.carbs).not.toBe(1);
  });
});

describe('parseLabel — Dutch per-100g panel', () => {
  const r = parseLabel(NL_PANEL);

  it('flags the per-100g basis', () => {
    expect(r.basis).toBe('100g');
    expect(r.servingGrams).toBe(100);
  });

  it('reads kcal out of a combined kJ/kcal line', () => {
    expect(r.calories).toBe(502);
  });

  it('handles decimal commas', () => {
    expect(r.fat).toBe(28.5);
    expect(r.carbs).toBe(48.2);
    expect(r.protein).toBe(8.6);
  });

  it('skips "waarvan" sub-rows', () => {
    expect(r.fat).not.toBe(3.1);
    expect(r.carbs).not.toBe(22.4);
  });
});

describe('parseLabel — per-100g with a stated portion', () => {
  const r = parseLabel(NL_WITH_PORTION);

  it('keeps the 100g basis but records the portion weight', () => {
    expect(r.basis).toBe('100g');
    expect(r.calories).toBe(345);
    expect(r.servingGrams).toBe(45);
  });
});

describe('parseLabel — energy edge cases', () => {
  it('converts kJ when no kcal figure is printed', () => {
    expect(parseLabel(KJ_ONLY).calories).toBe(400); // 1674 / 4.184
  });

  it('ignores nonsense magnitudes on a bare Calories line', () => {
    expect(parseLabel('Calories 0\nProtein 3 g').calories).toBeNull();
  });
});

describe('parseLabel — OCR noise', () => {
  it('repairs letters misread as digits inside numbers', () => {
    const r = parseLabel('Energie 1O5 kcal\nEiwitten l2 g');
    expect(r.calories).toBe(105);
    expect(r.protein).toBe(12);
  });

  it('leaves a lone letter alone rather than inventing a digit from noise', () => {
    // "S" could be a 5, or could be junk. A null is easy to correct; a
    // fabricated 5 silently becomes a wrong food.
    expect(parseLabel('Vetten S g').fat).toBeNull();
  });

  it('leaves ordinary words alone', () => {
    const r = parseLabel('Zonnebloemolie\nProtein 7 g');
    expect(r.protein).toBe(7);
  });

  it('reports nothing rather than guessing on unrelated text', () => {
    const r = parseLabel('INGREDIENTS: water, sugar, salt.\nBest before end: see cap.');
    expect(r.calories).toBeNull();
    expect(r.protein).toBeNull();
    expect(r.found).toEqual([]);
  });

  it('lists what it found so the user knows what to check', () => {
    expect(parseLabel(US_PANEL).found).toContain('calories');
    expect(parseLabel(US_PANEL).found).toContain('serving size');
  });
});

// Verbatim Tesseract output for the two rendered panels above, captured at
// phone-photo resolution. This is the real bar the parser has to clear.
const OCR_US = `HARVEST GROVE
Rolled Oats, Old Fashioned
Serving size 1/2 cup dry (409)
|
Amount per serving
Calories 150
eee ee |
% Daily Value*
Total Fat 39 4%
Saturated Fat 0.5g 3%
Sodium Omg 0%
Total Carbohydrate 279 10%
Dietary Fiber 4g 14%
Total Sugars 1g
Protein 5g
|
*The % Daily Value tells you how much a nutrient in a serving of food
contributes to a daily diet.`;

const OCR_NL = `Voedingswaarde
per 100 g
Energie 2100 kJ / 502 kcal
Vetten 28,59
waarvan verzadigde vetzuren 319
Koolhydraten 48,29
waarvan suikers 22,49
Vezels 3,59
Eiwitten 8,69
Zout 0,45g`;

describe('parseLabel — real OCR output', () => {
  it('recovers the US panel despite "g" being read as 9', () => {
    const r = parseLabel(OCR_US);
    expect(r.calories).toBe(150);
    expect(r.fat).toBe(3); // "Total Fat 39 4%"
    expect(r.carbs).toBe(27); // "Total Carbohydrate 279 10%"
    expect(r.protein).toBe(5); // this one survived as "5g"
    expect(r.servingGrams).toBe(40); // "(409)"
  });

  it('recovers the Dutch per-100g panel', () => {
    const r = parseLabel(OCR_NL);
    expect(r.basis).toBe('100g');
    expect(r.calories).toBe(502);
    expect(r.fat).toBe(28.5); // "Vetten 28,59"
    expect(r.carbs).toBe(48.2); // "Koolhydraten 48,29"
    expect(r.protein).toBe(8.6); // "Eiwitten 8,69"
  });

  it('still skips the sub-nutrient rows in noisy output', () => {
    const r = parseLabel(OCR_NL);
    expect(r.fat).not.toBe(3.1); // "waarvan verzadigde vetzuren 319"
    expect(r.carbs).not.toBe(22.4); // "waarvan suikers 2249"
  });
});

describe('parseLabel — implausible values are dropped, not guessed', () => {
  it('rejects a macro that cannot fit in 100 g', () => {
    expect(parseLabel('per 100 g\nEiwitten 869 g').protein).toBeNull();
  });

  it('rejects impossible calories', () => {
    expect(parseLabel('per 100 g\nEnergie 4500 kcal').calories).toBeNull();
  });

  it('keeps a number that does carry its unit', () => {
    expect(parseLabel('per 100 g\nZout 0,45g\nEiwitten 19 g').protein).toBe(19);
  });
});

describe('rescale', () => {
  it('converts per-100g values to a real serving', () => {
    expect(rescale(502, 100, 30)).toBe(150.6);
    expect(rescale(8.6, 100, 30)).toBe(2.6);
  });

  it('is a no-op when the basis already matches', () => {
    expect(rescale(150, 40, 40)).toBe(150);
  });

  it('returns null for missing values or zero weights', () => {
    expect(rescale(null, 100, 30)).toBeNull();
    expect(rescale(100, 0, 30)).toBeNull();
    expect(rescale(100, 100, 0)).toBeNull();
  });
});
