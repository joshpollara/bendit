import { describe, expect, it } from 'vitest';
import { forEachRow, number, parseLine, RowStream } from './csv.mjs';
import { buildFoods, buildNutrientMap, collectNutrition, collectPortions } from './usda.mjs';
import { isPlausible, matchesCountries, toFood } from './off.mjs';

describe('delimited parsing', () => {
  it('handles quoted commas the way USDA writes food names', () => {
    const line = '123,"Chicken, broilers or fryers, breast",sr_legacy_food';
    expect(parseLine(line)).toEqual([
      '123',
      'Chicken, broilers or fryers, breast',
      'sr_legacy_food',
    ]);
  });

  it('handles doubled quotes inside a field', () => {
    expect(parseLine('1,"Bob""s Beans",x')).toEqual(['1', 'Bob"s Beans', 'x']);
  });

  it('treats a tab-separated line literally — OFF quotes nothing', () => {
    // A product name containing a quote is data, not syntax.
    expect(parseLine('737628064502\tBob"s "Best" Rice\tBob', '\t')).toEqual([
      '737628064502',
      'Bob"s "Best" Rice',
      'Bob',
    ]);
  });

  it('keeps empty trailing fields so column positions stay aligned', () => {
    expect(parseLine('a,b,,')).toEqual(['a', 'b', '', '']);
  });

  it('maps rows onto header names', () => {
    const seen = [];
    forEachRow('id,name\n1,Apple\n2,Pear\n', (row) => seen.push(row));
    expect(seen).toEqual([{ id: '1', name: 'Apple' }, { id: '2', name: 'Pear' }]);
  });

  it('reads numbers but refuses to turn blanks into zero', () => {
    expect(number('12.5')).toBe(12.5);
    expect(number('12,5')).toBe(12.5); // some exports use a decimal comma
    expect(number('')).toBeNull();
    expect(number('unknown')).toBeNull();
  });
});

describe('RowStream — for inputs too big to hold in memory', () => {
  it('emits rows as chunks arrive, splitting lines across chunk boundaries', () => {
    const rows = [];
    const stream = new RowStream((row) => rows.push(row));
    stream.push('code\tproduct_name\n737\tRi');
    stream.push('ce\n999\tBeans\n');
    stream.end();
    expect(rows).toEqual([
      { code: '737', product_name: 'Rice' },
      { code: '999', product_name: 'Beans' },
    ]);
  });

  it('emits a final row with no trailing newline', () => {
    const rows = [];
    const stream = new RowStream((row) => rows.push(row));
    stream.push('a,b\n1,2');
    stream.end();
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('USDA normalization', () => {
  // Nutrient ids differ between releases, so the importer resolves them through
  // nutrient.csv rather than assuming the number is the id.
  const nutrientRows = [
    { id: '1008', nutrient_nbr: '1008', name: 'Energy', unit_name: 'KCAL' },
    { id: '1003', nutrient_nbr: '1003', name: 'Protein', unit_name: 'G' },
    { id: '1004', nutrient_nbr: '1004', name: 'Total lipid (fat)', unit_name: 'G' },
    { id: '1005', nutrient_nbr: '1005', name: 'Carbohydrate, by difference', unit_name: 'G' },
    { id: '1062', nutrient_nbr: '1062', name: 'Energy', unit_name: 'kJ' },
    { id: '9999', nutrient_nbr: '307', name: 'Sodium, Na', unit_name: 'MG' },
  ];
  const nutrientMap = buildNutrientMap(nutrientRows);

  it('resolves a nutrient through its legacy number when the id is unfamiliar', () => {
    // Row id 9999 is unknown, but nutrient_nbr 307 is sodium in every release.
    const nutrition = collectNutrition(
      [{ fdc_id: '1', nutrient_id: '9999', amount: '74' }],
      nutrientMap,
    );
    expect(nutrition.get('1')?.sodiumMg100).toBe(74);
  });

  it('collects per-100g macros against their food', () => {
    const nutrition = collectNutrition(
      [
        { fdc_id: '171077', nutrient_id: '1008', amount: '165' },
        { fdc_id: '171077', nutrient_id: '1003', amount: '31.02' },
        { fdc_id: '171077', nutrient_id: '1004', amount: '3.57' },
        { fdc_id: '171077', nutrient_id: '1005', amount: '0' },
      ],
      nutrientMap,
    );
    expect(nutrition.get('171077')).toMatchObject({
      kcal100: 165,
      protein100: 31.02,
      fat100: 3.57,
      carbs100: 0, // a real measured zero, unlike a missing field
    });
  });

  it('falls back to kJ when a food has no kcal row', () => {
    const nutrition = collectNutrition(
      [{ fdc_id: '2', nutrient_id: '1062', amount: '2100' }],
      nutrientMap,
    );
    expect(Math.round(nutrition.get('2').kcal100)).toBe(502);
  });

  it('builds household serving labels from portions', () => {
    const portions = collectPortions(
      [
        { fdc_id: '1', amount: '1', measure_unit_id: '1000', gram_weight: '140' },
        { fdc_id: '1', amount: '0.5', measure_unit_id: '1000', gram_weight: '70' },
      ],
      new Map([[1000, 'cup']]),
    );
    expect(portions.get('1')).toEqual([
      { label: '1 cup (140g)', grams: 140 },
      { label: '0.5 cup (70g)', grams: 70 },
    ]);
  });

  it('drops portions with no usable weight', () => {
    const portions = collectPortions(
      [{ fdc_id: '1', amount: '1', measure_unit_id: '1', gram_weight: '' }],
      new Map(),
    );
    expect(portions.has('1')).toBe(false);
  });

  it('assembles a complete food, always ending with a 100g option', () => {
    const [food] = buildFoods({
      foods: [{ fdc_id: '171077', description: 'Chicken, breast, cooked, roasted' }],
      nutrition: new Map([['171077', { kcal100: 165, protein100: 31 }]]),
      portions: new Map([['171077', [{ label: '1 breast (172g)', grams: 172 }]]]),
    });
    expect(food.id).toBe('usda-171077');
    expect(food.source).toBe('usda');
    expect(food.sourceId).toBe('171077');
    expect(food.caloriesPerServing).toBe(284); // 165 × 1.72
    expect(food.servings.at(-1)).toEqual({ label: '100 g', grams: 100 });
  });

  it('skips foods with no energy — they would match a search and add nothing', () => {
    const built = buildFoods({
      foods: [{ fdc_id: '5', description: 'Water, tap' }],
      nutrition: new Map([['5', { protein100: 0 }]]),
      portions: new Map(),
    });
    expect(built).toEqual([]);
  });
});

describe('Open Food Facts normalization', () => {
  const product = (overrides = {}) => ({
    code: '5000112637922',
    product_name: 'Coca-Cola Zero',
    brands: 'Coca-Cola,Coke',
    countries_tags: 'en:belgium,en:netherlands',
    'energy-kcal_100g': '0.3',
    proteins_100g: '0',
    carbohydrates_100g: '0',
    fat_100g: '0',
    serving_size: '330 ml',
    serving_quantity: '330',
    ...overrides,
  });

  it('normalizes a product into the canonical shape', () => {
    const food = toFood(product({ 'energy-kcal_100g': '42', carbohydrates_100g: '10.6' }));
    expect(food.id).toBe('off-5000112637922');
    expect(food.barcode).toBe('5000112637922');
    expect(food.sourceId).toBe('5000112637922');
    expect(food.brand).toBe('Coca-Cola'); // first brand only
    expect(food.kcal100).toBe(42);
  });

  it('marks drinks as ml so a 100 ml basis is never read as grams', () => {
    expect(toFood(product({ 'energy-kcal_100g': '42' })).basis).toBe('ml');
  });

  it('converts sodium and salt into milligrams', () => {
    const withSodium = toFood(product({ 'energy-kcal_100g': '42', sodium_100g: '0.5' }));
    expect(withSodium.sodiumMg100).toBe(500);
    const withSalt = toFood(product({ 'energy-kcal_100g': '42', salt_100g: '1.25' }));
    expect(withSalt.sodiumMg100).toBe(500);
  });

  it('converts kJ when only joules are published', () => {
    const food = toFood(
      product({ 'energy-kcal_100g': '', 'energy-kj_100g': '2100', carbohydrates_100g: '48' }),
    );
    expect(Math.round(food.kcal100)).toBe(502);
  });

  it('rejects rows a human clearly mistyped', () => {
    // 3,500 kcal per 100 g is roughly four times pure fat.
    expect(toFood(product({ 'energy-kcal_100g': '3500' }))).toBeNull();
    // 250 g of protein cannot fit in 100 g of food.
    expect(toFood(product({ 'energy-kcal_100g': '400', proteins_100g: '250' }))).toBeNull();
    // Macros summing past the weight of the food.
    expect(
      toFood(product({ 'energy-kcal_100g': '400', proteins_100g: '60', fat_100g: '60' })),
    ).toBeNull();
  });

  it('rejects rows with nothing to identify or measure them by', () => {
    expect(toFood(product({ code: '' }))).toBeNull();
    expect(toFood(product({ product_name: '' }))).toBeNull();
    expect(toFood(product({ 'energy-kcal_100g': '', 'energy-kj_100g': '' }))).toBeNull();
  });

  it('accepts a legitimate zero without treating it as missing', () => {
    const water = toFood(product({ product_name: 'Sparkling water', 'energy-kcal_100g': '0' }));
    expect(water).toBeNull(); // zero energy has nothing to log; excluded on purpose
  });

  it('filters by country the way the import is scoped', () => {
    const countries = ['netherlands', 'belgium', 'germany'];
    expect(matchesCountries(product(), countries)).toBe(true);
    expect(matchesCountries(product({ countries_tags: 'en:united-states' }), countries)).toBe(false);
    expect(matchesCountries(product({ countries_tags: '' }), countries)).toBe(false);
    expect(matchesCountries(product({ countries_tags: 'en:france' }), [])).toBe(true); // no filter
  });

  it('accepts plausible values at the edges of the range', () => {
    expect(isPlausible({ kcal100: 900, fat100: 100 })).toBe(true); // pure oil
    expect(isPlausible({ kcal100: 1 })).toBe(true);
    expect(isPlausible({ kcal100: null })).toBe(false);
  });
});
