import { describe, expect, it } from 'vitest';
import { gradeFor, gradeMeal, nutriScore, processingForMeal } from './nutriScore.mjs';

// The fixtures are real foods with their published per-100g figures. Where the
// official grade is known it is stated, including the cases this implementation
// cannot reach — an algorithm is only worth having if its limits are written
// down where they can be seen.

const food = (kcal100, sugar100, satFat100, sodiumMg100, fiber100 = 0, protein100 = 0) => ({
  kcal100,
  sugar100,
  satFat100,
  sodiumMg100,
  fiber100,
  protein100,
});

describe('nutriScore', () => {
  it('grades a plain vegetable well', () => {
    // Broccoli, raw: 34 kcal, 1.7 sugar, 0.04 sat fat, 33 mg sodium.
    expect(nutriScore(food(34, 1.7, 0.04, 33, 2.6, 2.8)).grade).toBe('A');
  });

  it('grades a sugary drink’s worth of sugar badly', () => {
    // A syrup at 300 kcal and 70 g of sugar per 100 g.
    expect(nutriScore(food(300, 70, 0, 20)).grade).toBe('D');
  });

  it('grades crisps in the middle, as the salt and fat pull against each other', () => {
    // Potato crisps: 536 kcal, 0.3 sugar, 3.1 sat fat, 525 mg sodium.
    const grade = nutriScore(food(536, 0.3, 3.1, 525, 4.8, 7)).grade;
    expect(['C', 'D']).toContain(grade);
  });

  it('stops counting protein once a food is far enough into the negative', () => {
    // Cured salami: high energy, high saturated fat, very high salt. Its
    // protein must not rescue it, which is the rule that exists for exactly
    // this food.
    const salami = nutriScore(food(407, 1.5, 13, 1800, 0, 22));
    expect(salami.grade).toBe('E');
  });

  it('says nothing rather than something when the data is thin', () => {
    // No saturated fat figure: the food would score better for having no data,
    // which is the one answer that must never be given.
    expect(nutriScore({ kcal100: 100, sugar100: 1, sodiumMg100: 10 })).toBeNull();
    expect(nutriScore({})).toBeNull();
    expect(nutriScore(null)).toBeNull();
  });

  it('under-grades whole fruit, which is the known limit', () => {
    // An apple: the official grade is A, which depends on the fruit share this
    // has no data for. It computes as B — recorded here so the gap is a known
    // quantity rather than a surprise.
    expect(nutriScore(food(52, 10.4, 0.03, 1, 2.4, 0.3)).grade).toBe('B');
  });
});

describe('drinks, which are scored on their own tables', () => {
  const drink = (kcal100, sugar100, extra = {}) => ({
    kcal100,
    sugar100,
    satFat100: 0,
    sodiumMg100: 4,
    basis: 'ml',
    ...extra,
  });

  it('grades a sugary cola E, as the official system does', () => {
    // On the food tables this came out B, which is the sort of wrong that would
    // make the whole feature worth ignoring.
    expect(nutriScore(drink(42, 10.6)).grade).toBe('E');
  });

  it('grades water A', () => {
    expect(nutriScore(drink(0, 0)).grade).toBe('A');
  });

  it('grades a diet drink better than a sugary one', () => {
    expect(nutriScore(drink(1, 0.2)).grade).toBe('B');
  });

  it('treats the same numbers differently as a food', () => {
    const asFood = nutriScore({ ...drink(42, 10.6), basis: 'g' });
    expect(asFood.grade).not.toBe('E');
  });
});

describe('the fruit and vegetable share', () => {
  it('lifts a whole fruit to the grade it officially holds', () => {
    const apple = food(52, 10.4, 0.03, 1, 2.4, 0.3);
    expect(nutriScore(apple).grade).toBe('B'); // without the share
    expect(nutriScore({ ...apple, fruitVeg: 100 }).grade).toBe('A');
  });

  it('does nothing for a food that is mostly something else', () => {
    // Crisps are made of potato and are not a vegetable in this sense; the
    // curated list matches whole plants only, which this guards.
    const crisps = food(536, 0.3, 3.1, 525, 4.8, 7);
    expect(nutriScore(crisps).grade).toBe(nutriScore({ ...crisps, fruitVeg: 0 }).grade);
  });
});

describe('gradeFor', () => {
  it('maps the published bands', () => {
    expect(gradeFor(-15)).toBe('A');
    expect(gradeFor(-1)).toBe('A');
    expect(gradeFor(0)).toBe('B');
    expect(gradeFor(2)).toBe('B');
    expect(gradeFor(3)).toBe('C');
    expect(gradeFor(10)).toBe('C');
    expect(gradeFor(11)).toBe('D');
    expect(gradeFor(18)).toBe('D');
    expect(gradeFor(19)).toBe('E');
  });
});

describe('gradeMeal', () => {
  it('weights by how much of each was eaten', () => {
    // 300 g of an A against 20 g of an E is an A-ish meal.
    expect(gradeMeal([
      { grade: 'A', grams: 300 },
      { grade: 'E', grams: 20 },
    ]).grade).toBe('A');
  });

  it('lets a large helping of something poor carry the meal', () => {
    // 300 g of an E against 50 g of an A averages 4.4, which is a D. Rounding
    // that up to E would say the salad on the side counted for nothing.
    expect(gradeMeal([
      { grade: 'A', grams: 50 },
      { grade: 'E', grams: 300 },
    ]).grade).toBe('D');
  });

  it('is an E when the whole meal is', () => {
    expect(gradeMeal([{ grade: 'E', grams: 300 }]).grade).toBe('E');
  });

  it('reports how much of the meal it could actually grade', () => {
    const result = gradeMeal([
      { grade: 'B', grams: 100 },
      { grade: null, grams: 300 },
    ]);
    expect(result.grade).toBe('B');
    expect(result.covered).toBeCloseTo(0.25, 2);
  });

  it('has no grade for a meal it knows nothing about', () => {
    expect(gradeMeal([{ grade: null, grams: 100 }])).toBeNull();
    expect(gradeMeal([])).toBeNull();
    expect(gradeMeal()).toBeNull();
  });
});

describe('processingForMeal', () => {
  it('reports the most processed thing, not the average', () => {
    // A plate of vegetables with a stock cube is not "lightly processed".
    const result = processingForMeal([
      { nova: 1, grams: 400 },
      { nova: 4, grams: 5 },
    ]);
    expect(result.worst).toBe(4);
  });

  it('reports how much of the meal was ultra-processed', () => {
    const result = processingForMeal([
      { nova: 1, grams: 300 },
      { nova: 4, grams: 100 },
    ]);
    expect(result.ultraShare).toBeCloseTo(0.25, 2);
  });

  it('has nothing to say about foods with no classification', () => {
    expect(processingForMeal([{ nova: null, grams: 100 }])).toBeNull();
    expect(processingForMeal([])).toBeNull();
  });
});
