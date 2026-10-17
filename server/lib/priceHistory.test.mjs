import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHistoryTables } from './picnicHistory.mjs';
import {
  backfillPrices,
  createPriceTables,
  dayOf,
  keepSummaries,
  pricesFromDelivery,
  pricesFromSearch,
  pricesFromSearchPage,
  recordPrices,
} from './priceHistory.mjs';

let db;
beforeEach(() => {
  db = new Database(':memory:');
  createHistoryTables(db);
  createPriceTables(db);
});

const article = (id, name, quantity = 1) => ({
  id,
  name,
  unit_quantity: '1 liter',
  price: 432199,
  decorators: [{ type: 'QUANTITY', quantity }],
});

// As Picnic returns a delivered order: line prices in cents for the whole
// line, articles' own prices meaningless.
const DELIVERY = {
  orders: [
    {
      items: [
        { price: 89, items: [article('s1', 'Picnic volle melk')] },
        {
          price: 478,
          decorators: [
            { type: 'PRICE', display_price: 239 },
            { type: 'PROMO', text: '1+1 gratis' },
          ],
          items: [article('s2', 'Optimel kwark', 2)],
        },
        { price: 300, items: [article('s3', 'One'), article('s4', 'Other')] },
      ],
    },
  ],
};

describe('prices from a delivered order', () => {
  it('gives the regular price of one, what one cost with the deal, and the deal', () => {
    expect(pricesFromDelivery(DELIVERY, '2026-10-14T18:00:00.000+02:00')).toEqual([
      expect.objectContaining({ productId: 's1', day: '2026-10-14', price: 89, paid: null, deal: null }),
      expect.objectContaining({ productId: 's2', price: 239, paid: 119.5, deal: '1+1 gratis', source: 'order' }),
    ]);
  });
});

describe('prices from a search page', () => {
  it('gives multi-buys as the price of one bought that way, and reductions from their old price', () => {
    const products = [
      { productId: 's1', name: 'Kwark', unitQuantity: '500 g', price: 239 },
      { productId: 's2', name: 'Kaas', unitQuantity: '150 g', price: 189 },
      { productId: 's3', name: 'Melk', unitQuantity: '1 l', price: 99 },
    ];
    const deals = new Map([
      ['s1', { label: '2 voor €3,50', price: 239, was: null }],
      ['s2', { label: 'nu €1.89', price: 189, was: 249 }],
    ]);
    expect(pricesFromSearchPage({ products, deals }, '2026-10-17')).toEqual([
      expect.objectContaining({ productId: 's1', price: 239, paid: 175, deal: '2 voor €3,50' }),
      expect.objectContaining({ productId: 's2', price: 249, paid: 189, deal: 'nu €1.89' }),
      expect.objectContaining({ productId: 's3', price: 99, paid: null, deal: null }),
    ]);
  });
});

describe('recordPrices', () => {
  const row = (id) => db.prepare('SELECT * FROM picnic_prices WHERE productId = ?').get(id);

  it('keeps one a day, the latest, but never lets a search replace what an order paid', () => {
    recordPrices(db, [{ productId: 's1', day: '2026-10-17', name: 'Melk', price: 99, source: 'search' }]);
    recordPrices(db, [{ productId: 's1', day: '2026-10-17', name: 'Melk', price: 95, source: 'search' }]);
    expect(row('s1').price).toBe(95);
    recordPrices(db, [{ productId: 's1', day: '2026-10-17', name: 'Melk', price: 89, source: 'order' }]);
    recordPrices(db, [{ productId: 's1', day: '2026-10-17', name: 'Melk', price: 99, source: 'search' }]);
    expect(row('s1')).toMatchObject({ price: 89, source: 'order' });
  });

  it('leaves out what has no price, and a paid price the same as the regular one', () => {
    const kept = recordPrices(db, [
      { productId: 's1', day: '2026-10-17', name: 'Melk', price: null, source: 'search' },
      { productId: 's2', day: '2026-10-17', name: 'Kaas', price: 189, paid: 189, source: 'search' },
    ]);
    expect(kept).toBe(1);
    expect(row('s2').paid).toBeNull();
  });

  it('takes plain search results', () => {
    recordPrices(
      db,
      pricesFromSearch([{ id: 's9', name: 'Brood', unit_quantity: '800 g', display_price: 249 }], '2026-10-17'),
    );
    expect(row('s9')).toMatchObject({ price: 249, unitQuantity: '800 g' });
  });
});

describe('backfillPrices', () => {
  const NOW = Date.parse('2026-10-17T12:00:00Z');
  const summaries = [
    { id: 'new', status: 'COMPLETED', windowStart: '2026-10-14T18:00:00+02:00', totalPrice: 7021 },
    { id: 'old', status: 'COMPLETED', windowStart: '2019-03-01T18:00:00+01:00', totalPrice: 5000 },
    { id: 'gone', status: 'CANCELLED', windowStart: '2019-02-01T18:00:00+01:00', totalPrice: 0 },
  ];
  const picnic = (asked) => ({
    deliveries: async () => summaries,
    delivery: async (id) => (asked.push(id), DELIVERY),
  });

  it('reads each delivered order once, a few at a time', async () => {
    const asked = [];
    expect(await backfillPrices(db, picnic(asked), { limit: 1, sleep: async () => {} })).toBe(1);
    expect(await backfillPrices(db, picnic(asked), { sleep: async () => {} })).toBe(1);
    expect(await backfillPrices(db, picnic(asked), { sleep: async () => {} })).toBe(0);
    expect(asked).toEqual(['new', 'old']);
    expect(db.prepare("SELECT day FROM picnic_prices WHERE productId = 's1' ORDER BY day").all()).toEqual([
      { day: '2019-03-01' },
      { day: '2026-10-14' },
    ]);
  });

  it('keeps older totals for spending, but not recent ones, which the history fetches', () => {
    keepSummaries(db, summaries, { now: NOW });
    expect(
      db
        .prepare('SELECT id FROM picnic_deliveries ORDER BY id')
        .all()
        .map((r) => r.id),
    ).toEqual(['gone', 'old']);
  });
});

describe('dayOf', () => {
  it('is the date in Amsterdam', () => {
    expect(dayOf(Date.parse('2026-10-16T22:30:00Z'))).toBe('2026-10-17');
  });
});
