import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSwapChecker, createSwapTables, foodWords, pickSwaps, sharedWords } from './picnicSwaps.mjs';

/** A product page with a nutrition section that grades as asked. */
const NUTRITION = {
  // Lean chicken: A.
  A: 'Per 100 g\nEnergie\n110 kcal\nVet\n1,5 g\nwaarvan verzadigd\n0,4 g\nKoolhydraten\n0 g\nwaarvan suikers\n0 g\nEiwit\n24 g\nZout\n0,2 g',
  // Smoked chicken: C.
  C: 'Per 100 g\nEnergie\n180 kcal\nVet\n9 g\nwaarvan verzadigd\n3 g\nKoolhydraten\n3 g\nwaarvan suikers\n3 g\nEiwit\n20 g\nZout\n1,5 g',
  // Cured, salty chicken: D.
  D: 'Per 100 g\nEnergie\n150 kcal\nVet\n6 g\nwaarvan verzadigd\n4 g\nKoolhydraten\n2 g\nwaarvan suikers\n9 g\nEiwit\n20 g\nZout\n2,6 g',
};
const page = (id, { name, brand, grade, similar = [] }) => ({
  id,
  name: '',
  brand,
  unitQuantity: '150 gram',
  infoSections: grade ? [{ title: 'Voedingswaarde', content: NUTRITION[grade] }] : [],
  similarProducts: similar.map((s) => ({
    id: s,
    name: PRODUCTS[s].name,
    displayPrice: 300,
    unitQuantity: '200 gram',
  })),
});
const PRODUCTS = {
  s1: {
    name: "'t Slagershuys kipfilet flinterdun",
    brand: "'t Slagershuys",
    grade: 'D',
    similar: ['s2', 's3'],
  },
  s2: { name: "'t Slagershuys kipfilet", brand: "'t Slagershuys", grade: 'A' },
  s3: {
    name: "'t Slagershuys beenham flinterdun",
    brand: "'t Slagershuys",
    grade: 'A',
  },
  s4: { name: 'Picnic kipfilet', brand: 'Picnic', grade: 'A' },
  s5: { name: 'Komkommer', grade: null },
};

function fakePicnic() {
  const calls = { product: 0, search: 0 };
  return {
    calls,
    product: async (id) => {
      calls.product++;
      return page(id, PRODUCTS[id]);
    },
    search: async () => {
      calls.search++;
      return [
        {
          id: 's4',
          name: 'Picnic kipfilet',
          display_price: 250,
          unit_quantity: '300 gram',
        },
      ];
    },
  };
}

let db;
beforeEach(() => {
  db = new Database(':memory:');
  createSwapTables(db);
});

describe('matching names', () => {
  it('leaves out the brand and words that say nothing about the food', () => {
    expect(foodWords("'t Slagershuys kipfilet flinterdun", "'t Slagershuys")).toEqual(['kipfilet']);
  });

  it('does not take a food that only mentions the original for a swap', () => {
    const feta = { name: 'Picnic Griekse feta', brand: 'Picnic' };
    expect(sharedWords(feta, { name: 'Picnic feta', brand: 'Picnic' })).toBe(1);
    expect(sharedWords(feta, { name: 'Olijven gevuld met feta' })).toBe(0);
  });

  it('offers only A to C swaps, the most alike first', () => {
    const original = {
      productId: 'x',
      name: 'Picnic Griekse feta',
      brand: 'Picnic',
      grade: 'E',
    };
    const swaps = pickSwaps(original, [
      { productId: 'd', name: 'Feta dip', grade: 'D' },
      { productId: 'b', name: 'Feta light', grade: 'B' },
      { productId: 'c', name: 'Griekse feta blokjes', grade: 'C' },
    ]);
    expect(swaps.map((s) => s.productId)).toEqual(['c', 'b']);
  });
});

describe('checking an order', () => {
  it('grades each product and suggests better ones for a D', async () => {
    const picnic = fakePicnic();
    const check = createSwapChecker(db, picnic);
    const [chicken, cucumber] = await check([
      { productId: 's1', name: PRODUCTS.s1.name },
      { productId: 's5', name: 'Komkommer' },
    ]);
    expect(chicken.grade).toBe('D');
    // Plain kipfilet from either brand, the cheaper first; not ham, which
    // only shares "flinterdun".
    expect(chicken.swaps.map((s) => [s.productId, s.grade])).toEqual([
      ['s4', 'A'],
      ['s2', 'A'],
    ]);
    expect(cucumber).toEqual({ productId: 's5', grade: null, swaps: [] });
  });

  it('keeps grades and swaps, so a second check asks Picnic nothing', async () => {
    const picnic = fakePicnic();
    const check = createSwapChecker(db, picnic);
    await check([{ productId: 's1', name: PRODUCTS.s1.name }]);
    const asked = { ...picnic.calls };
    await check([{ productId: 's1', name: PRODUCTS.s1.name }]);
    expect(picnic.calls).toEqual(asked);
  });

  it('asks again after a month', async () => {
    const picnic = fakePicnic();
    let now = Date.parse('2026-10-01T00:00:00Z');
    const check = createSwapChecker(db, picnic, { now: () => now });
    await check([{ productId: 's2', name: PRODUCTS.s2.name }]);
    now += 31 * 24 * 60 * 60 * 1000;
    await check([{ productId: 's2', name: PRODUCTS.s2.name }]);
    expect(picnic.calls.product).toBe(2);
  });
});

describe('during an A/B month', () => {
  it('swaps a C only for an A or B', () => {
    const original = { productId: 'x', name: 'Picnic Griekse feta', brand: 'Picnic', grade: 'C' };
    const swaps = pickSwaps(original, [
      { productId: 'c', name: 'Griekse feta blokjes', grade: 'C' },
      { productId: 'b', name: 'Feta light', grade: 'B' },
    ]);
    expect(swaps.map((s) => s.productId)).toEqual(['b']);
  });

  it('looks for swaps for C items only when asked to', async () => {
    PRODUCTS.s6 = { name: "'t Slagershuys kipfilet gerookt", brand: "'t Slagershuys", grade: 'C', similar: ['s2'] };
    const check = createSwapChecker(db, fakePicnic());
    const [usual] = await check([{ productId: 's6', name: PRODUCTS.s6.name }]);
    expect(usual).toMatchObject({ grade: 'C', swaps: [] });
    const [abMonth] = await check([{ productId: 's6', name: PRODUCTS.s6.name }], { alsoC: true });
    expect(abMonth.swaps.map((s) => [s.productId, s.grade])).toEqual([
      ['s4', 'A'],
      ['s2', 'A'],
    ]);
  });
});
