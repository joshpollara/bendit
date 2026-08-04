import { describe, expect, it } from 'vitest';
import { parseIngredient } from './recipeParse.mjs';
import { SOURCES, weighIngredient } from './recipeMeasure.mjs';

// The portion lists are real ones, copied from what the USDA import produces.
const OLIVE_OIL = [
  { label: '1 tablespoon (14g)', grams: 14 },
  { label: '1 cup (216g)', grams: 216 },
  { label: '1 tsp (5g)', grams: 5 },
  { label: '100 g', grams: 100 },
];
const FLOUR = [
  { label: '1 cup (125g)', grams: 125 },
  { label: '100 g', grams: 100 },
];
const MILK = [
  { label: '1 cup (244g)', grams: 244 },
  { label: '1 tbsp (15g)', grams: 15 },
  { label: '100 g', grams: 100 },
];
const ONION = [
  { label: '1 cup, chopped (160g)', grams: 160 },
  { label: '1 tbsp chopped (10g)', grams: 10 },
  { label: '1 large (150g)', grams: 150 },
  { label: '1 medium (110g)', grams: 110 },
  { label: '100 g', grams: 100 },
];
const EGG = [
  { label: '1 large (50g)', grams: 50 },
  { label: '1 medium (44g)', grams: 44 },
  { label: '100 g', grams: 100 },
];

const weigh = (line, servings) => weighIngredient(parseIngredient(line), servings);

describe('weights the line states outright', () => {
  it('takes grams as grams', () => {
    expect(weigh('500 g chicken breast', [])).toMatchObject({ grams: 500, source: SOURCES.stated });
  });

  it('converts the other mass units', () => {
    expect(weigh('1 kg potatoes', []).grams).toBe(1000);
    expect(weigh('8 oz butter', []).grams).toBe(226.8);
    expect(weigh('1 lb mince', []).grams).toBe(453.6);
  });

  it('needs no food data to do it', () => {
    expect(weigh('250 g anything at all', []).source).toBe(SOURCES.stated);
  });
});

describe("weights from the food's own portions", () => {
  it('knows a tablespoon of oil is 14 g, not 15 ml of water', () => {
    expect(weigh('2 tbsp olive oil', OLIVE_OIL)).toMatchObject({ grams: 28, source: SOURCES.food });
  });

  it('knows a cup of flour and a cup of milk are different weights', () => {
    expect(weigh('1 cup flour', FLOUR).grams).toBe(125);
    expect(weigh('1 cup milk', MILK).grams).toBe(244);
  });

  it('scales a fraction of a portion', () => {
    expect(weigh('1/2 cup flour', FLOUR).grams).toBe(62.5);
    expect(weigh('1½ cups milk', MILK).grams).toBe(366);
  });

  it('answers a size word from the matching portion', () => {
    expect(weigh('3 large eggs', EGG)).toMatchObject({ grams: 150, source: SOURCES.food });
  });

  it('weighs a bare count as a medium one', () => {
    expect(weigh('2 onions', ONION)).toMatchObject({ grams: 220, source: SOURCES.food });
  });

  it('prefers the plain portion to the qualified one', () => {
    // "1 cup (160g) chopped" and "1 cup, sifted" both answer "cup"; the plainer
    // label is the one a recipe means.
    expect(weigh('1 cup onion', ONION).grams).toBe(160);
  });

  it('uses the food’s density for a volume it has no spoon for', () => {
    // Milk has no "fl oz" portion, but a cup of it weighs 244g — so 100ml is
    // 101.7g rather than the 100g water would be.
    const result = weigh('100 ml milk', MILK);
    expect(result.source).toBe(SOURCES.food);
    expect(result.grams).toBeCloseTo(101.7, 0);
  });
});

describe('weights from a generic measure', () => {
  it('treats millilitres as water when the food says nothing', () => {
    expect(weigh('250 ml water', [])).toMatchObject({ grams: 250, source: SOURCES.generic });
  });

  it('has standard weights for the vague measures', () => {
    expect(weigh('2 cloves garlic', []).source).toBe(SOURCES.generic);
    expect(weigh('1 pinch salt', []).grams).toBeLessThan(1);
  });

  it('falls back to a spoon of water for an unknown food', () => {
    expect(weigh('1 tbsp mystery sauce', [])).toMatchObject({ grams: 15, source: SOURCES.generic });
  });
});

describe('lines that cannot be weighed', () => {
  it('refuses rather than invents when there is no amount', () => {
    expect(weigh('Salt and pepper to taste', [])).toMatchObject({
      grams: null,
      source: SOURCES.unknown,
    });
  });

  it('refuses a bare count of something it has no portion for', () => {
    const result = weigh('2 aubergines', []);
    expect(result.grams).toBeNull();
    expect(result.reason).toMatch(/no weight/);
  });

  it('says why, so the screen can ask for that one', () => {
    expect(weigh('A handful of parsley', []).reason).toBe('no amount given');
  });
});
