import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cartAdditions,
  clearChoice,
  createPicnicShoppingTables,
  createSuggester,
  packsFor,
  productFrom,
  setChoice,
  withProducts,
} from './picnicShopping.mjs';

const MINCE = { productId: 's1001382', name: "'t Slagershuys rundergehakt", unitQuantity: '500 gram', price: 549 };
const ONIONS = { productId: 's1115349', name: 'Gele uien', unitQuantity: '3 stuks', price: 99 };

describe('packsFor', () => {
  it('covers the weight needed with whole packs', () => {
    expect(packsFor({ grams: 313 }, MINCE)).toBe(1);
    expect(packsFor({ grams: 750 }, MINCE)).toBe(2);
  });

  it('does not buy a second pack for a few grams over', () => {
    expect(packsFor({ grams: 510 }, MINCE)).toBe(1);
  });

  it('counts whole things against how many come in a pack', () => {
    expect(packsFor({ grams: null, written: ['2'] }, ONIONS)).toBe(1);
    expect(packsFor({ grams: null, written: ['4'] }, ONIONS)).toBe(2);
  });

  it('buys one when the amount cannot be compared', () => {
    expect(packsFor({ grams: null, written: ['1 tsp'] }, { unitQuantity: '50 gram' })).toBe(1);
  });
});

describe('cartAdditions', () => {
  it('adds chosen, unticked lines, merging the same product', () => {
    const items = [
      { key: 'a', checked: false, choice: MINCE, suggestion: null, packs: 1 },
      { key: 'b', checked: false, choice: MINCE, suggestion: null, packs: 2 },
      { key: 'c', checked: false, choice: ONIONS, suggestion: null, packs: 1 },
      { key: 'd', checked: true, choice: ONIONS, suggestion: null, packs: 1 },
      { key: 'e', checked: false, choice: null, suggestion: null, packs: null },
    ];
    expect(cartAdditions(items)).toEqual([
      { productId: MINCE.productId, quantity: 3 },
      { productId: ONIONS.productId, quantity: 1 },
    ]);
  });

  it('never buys a suggestion nobody accepted', () => {
    expect(cartAdditions([{ key: 'a', checked: false, choice: null, suggestion: MINCE, packs: 1 }])).toEqual([]);
  });
});

describe('suggestions', () => {
  it('searches once per term an hour', async () => {
    let calls = 0;
    let clock = 0;
    const suggest = createSuggester(
      async () => {
        calls++;
        return [{ id: 's1', name: 'Rundergehakt', image_id: 'img', unit_quantity: '500 gram', display_price: 549 }];
      },
      { now: () => clock },
    );
    expect(await suggest('Ground beef')).toEqual({
      productId: 's1',
      name: 'Rundergehakt',
      imageId: 'img',
      unitQuantity: '500 gram',
      price: 549,
    });
    await suggest('ground beef ');
    expect(calls).toBe(1);
    clock += 61 * 60 * 1000;
    await suggest('ground beef');
    expect(calls).toBe(2);
  });
});

describe('withProducts', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    createPicnicShoppingTables(db);
  });

  const list = {
    listKey: 'w',
    items: [
      { key: 'food:beef', name: 'ground beef', grams: 750, written: [], checked: false },
      { key: 'name:onion', name: 'onion', grams: null, written: ['2'], checked: false },
      { key: 'name:salt', name: 'salt', grams: null, written: ['1 tsp'], checked: true },
    ],
  };

  it('uses the household’s choice, suggests for the rest, and skips ticked lines', async () => {
    setChoice(db, 'food:beef', MINCE, { userId: 'u1' });
    const searched = [];
    const result = await withProducts(db, list, async (term) => {
      searched.push(term);
      return ONIONS;
    });
    expect(searched).toEqual(['onion']);
    const [beef, onion, salt] = result.items;
    expect(beef).toMatchObject({ choice: MINCE, suggestion: null, packs: 2 });
    expect(onion).toMatchObject({ choice: null, suggestion: ONIONS, packs: 1 });
    expect(salt).toMatchObject({ choice: null, suggestion: null, packs: null });
  });

  it('forgets a choice when asked', async () => {
    setChoice(db, 'food:beef', MINCE, { userId: 'u1' });
    clearChoice(db, 'food:beef');
    const result = await withProducts(db, list, async () => null);
    expect(result.items[0].choice).toBeNull();
  });

  it('carries on without a suggestion when Picnic fails', async () => {
    const result = await withProducts(db, list, async () => {
      throw new Error('503');
    });
    expect(result.items[1]).toMatchObject({ suggestion: null, packs: null });
  });
});

describe('productFrom', () => {
  it('takes a search result into the list’s shape', () => {
    expect(productFrom({ id: 's1', name: 'X', image_id: 'i', unit_quantity: '1 kilo', display_price: 100 })).toEqual({
      productId: 's1',
      name: 'X',
      imageId: 'i',
      unitQuantity: '1 kilo',
      price: 100,
    });
  });
});
