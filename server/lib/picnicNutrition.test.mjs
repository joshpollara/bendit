import { describe, expect, it } from 'vitest';
import { nutriScore } from './nutriScore.mjs';
import { packGrams, parsePicnicNutrition, picnicFood } from './picnicNutrition.mjs';

// Sections as Picnic returned them for real products.

const MILK = 'Per 100 g\nEnergie\n197 kJ /\nkcal\n47 kcal\nKoolhydraten\n4,6g\nwaarvan suikers\n4,6g\nVet\n1,5g\nwaarvan verzadigd\n1,0g\nEiwit\n3,7g\nZout\n0,1g';
const CHICKEN = 'Per 100 g\nEnergie\n450 kJ /\nkcal\n108 kcal\nKoolhydraten\n0,0g\nwaarvan suikers\n0,0g\nVet\n0,8g\nwaarvan verzadigd\n0,4g\nVezels\n0,0g\nEiwit\n25g\nZout\n0,1g';
const BREAD = 'Per 100 g\nEnergie\n1.145 kJ /\nkcal\n274 kcal\nKoolhydraten\n29g\nwaarvan suikers\n1,5g\nVet\n10g\nwaarvan verzadigd\n1,6g\nVezels\n8,1g\nEiwit\n12g\nZout\n1,0g';

describe('parsePicnicNutrition', () => {
  it('reads every row, with Dutch decimals', () => {
    expect(parsePicnicNutrition(MILK)).toEqual({
      basis: 'g',
      kcal100: 47,
      carbs100: 4.6,
      sugar100: 4.6,
      fat100: 1.5,
      satFat100: 1,
      protein100: 3.7,
      sodiumMg100: 40,
    });
  });

  it('keeps sub-rows off the rows they belong to', () => {
    const chicken = parsePicnicNutrition(CHICKEN);
    expect(chicken).toMatchObject({ fat100: 0.8, satFat100: 0.4, carbs100: 0, sugar100: 0, fiber100: 0 });
  });

  it('reads the kcal figure, not the kJ one with a thousands separator', () => {
    expect(parsePicnicNutrition(BREAD)).toMatchObject({ kcal100: 274, fiber100: 8.1, sodiumMg100: 400 });
  });

  it('falls back to kJ when no kcal is given', () => {
    expect(parsePicnicNutrition('Per 100 g\nEnergie\n1.145 kJ\nEiwit\n12g').kcal100).toBe(274);
  });

  it('notices a per-100-ml panel', () => {
    expect(parsePicnicNutrition('Per 100 ml\nEnergie\n42 kcal').basis).toBe('ml');
  });

  it('gives up without an energy figure', () => {
    expect(parsePicnicNutrition('Per 100 g\nEiwit\n3g')).toBeNull();
  });
});

describe('packGrams', () => {
  it.each([
    ['400 gram', 400],
    ['1 liter', 1000],
    ['1.5 liter', 1500],
    ['6 x 330 ml', 1980],
    ['4 stuks', null],
  ])('%s → %s', (text, grams) => expect(packGrams(text)).toBe(grams));
});

describe('picnicFood', () => {
  const details = {
    id: 's1014735',
    name: '',
    brand: "'t Slagershuys",
    unitQuantity: '400 gram',
    infoSections: [
      { title: 'Ingrediënten', content: 'Kipfilet' },
      { title: 'Voedingswaarde', content: CHICKEN },
    ],
  };

  it('makes a food per 100 g, with the pack as a serving', () => {
    const food = picnicFood(details, { name: "'t Slagershuys kipfilets" });
    expect(food).toMatchObject({
      id: 'picnic-s1014735',
      name: "'t Slagershuys kipfilets",
      source: 'picnic',
      sourceId: 's1014735',
      servingLabel: '100 g',
      servingGrams: 100,
      caloriesPerServing: 108,
      protein: 25,
    });
    expect(food.servings).toEqual([
      { label: '100 g', grams: 100 },
      { label: 'Pack (400 gram)', grams: 400 },
    ]);
  });

  it('carries enough to be graded', () => {
    expect(nutriScore(picnicFood(details, { name: 'kip' }))?.grade).toBe('A');
  });

  it('has nothing to offer for a product without a nutrition section', () => {
    expect(picnicFood({ id: 's1', unitQuantity: '4 stuks', infoSections: [{ title: 'Extra informatie', content: '' }] })).toBeNull();
  });
});
