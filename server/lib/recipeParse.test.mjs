import { describe, expect, it } from 'vitest';
import { parseIngredient, parseIngredients } from './recipeParse.mjs';

// The fixtures are ingredient lines as recipes actually write them, from
// cookbooks and recipe sites, including the ones that are awkward on purpose.

const parse = (line) => parseIngredient(line);

describe('quantities', () => {
  it('reads a plain number', () => {
    expect(parse('2 tbsp olive oil')).toMatchObject({ quantity: 2, unit: 'tbsp', name: 'olive oil' });
  });

  it('reads a written fraction', () => {
    expect(parse('1/2 cup flour')).toMatchObject({ quantity: 0.5, unit: 'cup', name: 'flour' });
  });

  it('reads a vulgar fraction', () => {
    expect(parse('½ cup flour')).toMatchObject({ quantity: 0.5, unit: 'cup' });
    expect(parse('¾ tsp salt')).toMatchObject({ quantity: 0.75, unit: 'tsp' });
  });

  it('reads a mixed number both ways round', () => {
    expect(parse('1 1/2 cups milk')).toMatchObject({ quantity: 1.5, unit: 'cup', name: 'milk' });
    expect(parse('1½ cups milk')).toMatchObject({ quantity: 1.5, unit: 'cup' });
  });

  it('takes the middle of a range', () => {
    expect(parse('2-3 cloves garlic')).toMatchObject({ quantity: 2.5, unit: 'clove', name: 'garlic' });
    expect(parse('4 to 6 tbsp water')).toMatchObject({ quantity: 5, unit: 'tbsp' });
  });

  it('reads a decimal comma, as European recipes write it', () => {
    expect(parse('1,5 kg potatoes')).toMatchObject({ quantity: 1.5, unit: 'kg' });
  });

  it('leaves the quantity unknown when the line has none', () => {
    expect(parse('Salt and pepper to taste')).toMatchObject({ quantity: null, unit: null });
    expect(parse('A handful of parsley')).toMatchObject({ quantity: null, unit: null });
  });
});

describe('units', () => {
  it('understands the spellings of the same unit', () => {
    for (const line of ['2 tbsp oil', '2 tbs oil', '2 tablespoons oil', '2 Tablespoon oil']) {
      expect(parse(line).unit, line).toBe('tbsp');
    }
    for (const line of ['500 g chicken', '500g chicken', '500 grams chicken', '500 gr chicken']) {
      expect(parse(line).unit, line).toBe('g');
    }
  });

  it('reads metric written without a space', () => {
    expect(parse('250ml water')).toMatchObject({ quantity: 250, unit: 'ml', name: 'water' });
  });

  it('keeps a size word out of the unit but knows it was there', () => {
    expect(parse('3 large eggs')).toMatchObject({ quantity: 3, unit: null, size: 'large', name: 'eggs' });
  });

  it('has no unit for a bare count', () => {
    expect(parse('2 onions')).toMatchObject({ quantity: 2, unit: null, name: 'onions' });
  });
});

describe('names and notes', () => {
  it('separates preparation from the food', () => {
    expect(parse('1 onion, finely chopped')).toMatchObject({
      quantity: 1,
      name: 'onion',
      note: 'finely chopped',
    });
  });

  it('keeps the food when the line ends in an instruction', () => {
    expect(parse('200 g butter, softened')).toMatchObject({ name: 'butter', note: 'softened' });
    expect(parse('2 tbsp olive oil, for frying')).toMatchObject({ name: 'olive oil' });
  });

  it('drops "of" from "a pinch of salt"', () => {
    expect(parse('1 pinch of salt')).toMatchObject({ unit: 'pinch', name: 'salt' });
  });

  it('strips a list bullet', () => {
    expect(parse('- 2 tbsp olive oil')).toMatchObject({ quantity: 2, name: 'olive oil' });
  });

  it('keeps the line exactly as written', () => {
    expect(parse('  1 onion, finely chopped  ').raw).toBe('1 onion, finely chopped');
  });
});

describe('parenthesised weights', () => {
  it('prefers the stated weight to the vague count', () => {
    // "1 tin" is a guess; "400g" is not. The tin itself isn't part of the
    // food's name either — what was eaten is tomatoes.
    expect(parse('1 (400g) tin chopped tomatoes')).toMatchObject({
      quantity: 400,
      unit: 'g',
      name: 'tomatoes',
      note: 'chopped',
    });
  });

  it('prefers the stated volume to the spoon', () => {
    expect(parse('2 tablespoons (30 ml) olive oil')).toMatchObject({ quantity: 30, unit: 'ml' });
  });

  it('leaves a parenthetical that is not a measure in the name', () => {
    expect(parse('1 cup (packed) brown sugar').name).toMatch(/brown sugar/);
  });
});

describe('parseIngredients', () => {
  it('reads a whole list', () => {
    const list = parseIngredients(`
      2 tbsp olive oil
      1 onion, finely chopped
      2 cloves garlic, crushed
      400 g tinned tomatoes
      Salt and pepper to taste
    `);
    expect(list.map((i) => i.name)).toEqual([
      'olive oil',
      'onion',
      'garlic',
      'tinned tomatoes',
      'Salt and pepper',
    ]);
  });

  it('skips headings and blank lines', () => {
    const list = parseIngredients(['For the sauce:', '', '2 tbsp olive oil', 'For the topping:']);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('olive oil');
  });

  it('takes a string as readily as an array', () => {
    expect(parseIngredients('2 tbsp olive oil\n1 onion')).toHaveLength(2);
  });
});
