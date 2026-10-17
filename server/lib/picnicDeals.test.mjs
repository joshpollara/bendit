import { describe, expect, it } from 'vitest';
import { costOf, createDealFinder, dealTerms, readSearchPage } from './picnicDeals.mjs';

// A search page in Picnic's shape: products under "sellingUnit", deals in each
// product's tile analytics. The tile ids carry a suffix in some layouts.
const tile = (id, deal) => ({
  id: `selling-unit-${id}-tile-1-0`,
  analytics: { contexts: [{ data: deal }] },
  content: {},
});
const unit = (id, name, price, unitQuantity, decorators = []) => ({
  sellingUnit: { id, name, display_price: price, unit_quantity: unitQuantity, image_id: `img-${id}`, decorators },
});
const PAGE = {
  body: {
    children: [
      tile('s1', { promotion_id: 'p1', promotion_label: '2 voor €5', price: 299, show_strikethrough_price: false }),
      tile('s2', { promotion_id: 'p2', promotion_label: '25% korting', price: 201, strikethrough_price: 269, show_strikethrough_price: true }),
      tile('s3', { type: 'SEARCH_RESULT_ENTITY' }),
    ],
    results: [
      unit('s1', 'Cheddar', 299, '150 gram'),
      unit('s2', 'Tortillas', 201, '8 stuks'),
      unit('s3', 'Butter', 269, '250 gram'),
      unit('s7', 'Asperges', 769, '450 gram', [
        { type: 'UNAVAILABLE', reason: 'SOLD_OUT', explanation: { short_explanation: 'Tijdelijk uitverkocht' } },
      ]),
    ],
  },
};

describe('reading a search page', () => {
  it("finds each product, and each one's own deal", () => {
    const { products, deals } = readSearchPage(PAGE);
    expect(products.map((p) => [p.productId, p.price, p.unavailable])).toEqual([
      ['s1', 299, null],
      ['s2', 201, null],
      ['s3', 269, null],
      ['s7', 769, 'Tijdelijk uitverkocht'],
    ]);
    expect(deals.get('s1')).toEqual({ label: '2 voor €5', price: 299, was: null });
    expect(deals.get('s2')).toEqual({ label: '25% korting', price: 201, was: 269 });
    expect(deals.has('s3')).toBe(false);
  });
});

describe('what a deal costs', () => {
  it('understands the kinds of deal Picnic runs', () => {
    expect(dealTerms('2 voor €5', 299)).toEqual({ count: 2, total: 500 });
    expect(dealTerms('2 voor €3.50', 239)).toEqual({ count: 2, total: 350 });
    expect(dealTerms('1+1 gratis', 300)).toEqual({ count: 2, total: 300 });
    expect(dealTerms('2e halve prijs', 499)).toEqual({ count: 2, total: 749 });
    expect(dealTerms('2e = 60% korting', 200)).toEqual({ count: 2, total: 280 });
    expect(dealTerms('25% korting', 201)).toEqual({ count: 1, total: 201 });
  });

  it('prices a quantity, paying full price for any left over from a multi-buy', () => {
    const deal = { label: '2 voor €5', price: 299 };
    expect(costOf(1, 299, deal)).toBe(299);
    expect(costOf(2, 299, deal)).toBe(500);
    expect(costOf(3, 299, deal)).toBe(799);
    // A reduction is already in the deal's price.
    expect(costOf(2, 269, { label: '25% korting', price: 201, was: 269 })).toBe(402);
  });
});

describe('checking an order', () => {
  const picnic = { searchPage: async () => PAGE };
  const similar = {
    s3: {
      brand: 'Brand',
      products: [
        { productId: 's4', name: 'Picnic butter', unitQuantity: '250 gram', price: 199 },
        { productId: 's5', name: 'Picnic butter', unitQuantity: '500 gram', price: 339 },
        { productId: 's6', name: 'Margarine', unitQuantity: '250 gram', price: 99 },
      ],
    },
  };
  const finder = (grades = {}) =>
    createDealFinder(picnic, {
      similarOf: async (p) => similar[p.productId] ?? { brand: null, products: [] },
      grade: async (p) => grades[p.productId] ?? null,
    });

  it('reports the deal on an item and what it saves', async () => {
    const [cheddar] = await finder().check([{ productId: 's1', name: 'Cheddar', unitQuantity: '150 gram', quantity: 2 }]);
    expect(cheddar).toMatchObject({ price: 299, cost: 500, saves: 98, oneMore: null });
  });

  it('suggests one more to complete a multi-buy, only for something bought regularly', async () => {
    const item = { productId: 's1', name: 'Cheddar', unitQuantity: '150 gram', quantity: 1 };
    expect((await finder().check([item]))[0].oneMore).toBeNull();
    const [cheddar] = await finder().check([item], { regulars: new Set(['s1']) });
    // The second costs €2.01 instead of €2.99.
    expect(cheddar.oneMore).toEqual({ extra: 201, saves: 98 });
  });

  it('finds the same food for less, about the same amount of it, and never less healthy', async () => {
    const item = { productId: 's3', name: 'Butter', unitQuantity: '250 gram', quantity: 2 };
    const [butter] = await finder().check([item]);
    // 2 × 250 g for €5.38: 1 × 500 g saves €1.99, 2 × 250 g own brand saves €1.40. Margarine isn't butter.
    expect(butter.cheaper.map((c) => [c.productId, c.quantity, c.saves])).toEqual([
      ['s5', 1, 199],
      ['s4', 2, 140],
    ]);
    const [graded] = await finder({ s3: 'D', s5: 'E', s4: 'D' }).check([item]);
    expect(graded.cheaper.map((c) => c.productId)).toEqual(['s4']);
  });
});
