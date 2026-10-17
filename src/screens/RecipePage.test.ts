import { describe, expect, it } from 'vitest';
import { amount, scaledLine } from './RecipePage';

describe('scaling a recipe', () => {
  it('writes amounts the way a recipe would', () => {
    expect(amount(1.5)).toBe('1½');
    expect(amount(0.5)).toBe('½');
    expect(amount(1 / 3)).toBe('⅓');
    expect(amount(2.4)).toBe('2.4');
    expect(amount(2.98)).toBe('3');
    expect(amount(312.5)).toBe('313');
  });

  it('scales a line with an amount, and leaves the rest as written', () => {
    const lentils = { raw: '1 cup red lentils (rinsed)', quantity: 1, unit: 'cup', name: 'red lentils', grams: 190 };
    expect(scaledLine(lentils, 1)).toBe('1 cup red lentils (rinsed)');
    expect(scaledLine(lentils, 1.25)).toBe('1¼ cup red lentils (rinsed)');
    expect(scaledLine({ raw: 'salt to taste', quantity: null, grams: null }, 2)).toBe('salt to taste');
    expect(scaledLine({ raw: '2 onions, sliced', quantity: 2, unit: null, name: 'onion', grams: null }, 1.5)).toBe('3 onions, sliced');
    expect(scaledLine({ raw: '1 1/2 cups rice', quantity: 1.5, unit: 'cup', name: 'rice', grams: 280 }, 2)).toBe('3 cups rice');
    expect(scaledLine({ raw: '1 or 2 tbsp chipotle', quantity: 1.5, unit: 'tbsp', name: 'chipotle', grams: null }, 2)).toBe('2–4 tbsp chipotle');
    expect(scaledLine({ raw: '1-1/2 cups tomato sauce', quantity: 1.5, unit: 'cup', name: 'tomato sauce', grams: null }, 2)).toBe('3 cups tomato sauce');
    expect(scaledLine({ raw: 'Rice, 2 cups', quantity: 2, unit: 'cup', name: 'rice', grams: 370 }, 0.5)).toBe('1 cup rice');
  });
});
