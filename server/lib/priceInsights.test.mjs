import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHistoryTables } from './picnicHistory.mjs';
import { createPriceTables, recordPrices } from './priceHistory.mjs';
import { basketIndex, monthsTo, noteFor, priceOverview, productPrices, spending } from './priceInsights.mjs';

const TODAY = '2026-10-17';
let db;
beforeEach(() => {
  db = new Database(':memory:');
  createHistoryTables(db);
  createPriceTables(db);
});

const row = (day, price, extra = {}) => ({ day, price, paid: null, deal: null, unitQuantity: '500 gram', ...extra });
const seen = (productId, rows) =>
  recordPrices(
    db,
    rows.map((r) => ({ productId, name: `Product ${productId}`, source: 'order', ...r })),
  );

describe('monthsTo', () => {
  it('counts back across a year', () => {
    expect(monthsTo('2026-02-10', 3)).toEqual(['2025-12', '2026-01', '2026-02']);
  });
});

describe('noteFor', () => {
  it('says when a price is the lowest in six months', () => {
    const rows = [
      row('2026-06-01', 249),
      row('2026-08-01', 239),
      row('2026-09-01', 249),
      row('2026-10-15', 249, { paid: 199 }),
    ];
    expect(noteFor(rows, { today: TODAY })).toMatchObject({ kind: 'lowest' });
  });

  it('says when it costs a tenth more than a year ago', () => {
    const rows = [row('2025-10-01', 200), row('2025-11-20', 200), row('2026-10-10', 229)];
    expect(noteFor(rows, { today: TODAY })).toEqual({ kind: 'up', text: 'Up 15% on a year ago' });
  });

  it('says when the pack shrank for about the same money', () => {
    const rows = [row('2026-08-01', 199), row('2026-10-10', 199, { unitQuantity: '450 gram' })];
    expect(noteFor(rows, { today: TODAY })).toMatchObject({
      kind: 'smaller',
      text: 'Smaller pack: 500 gram → 450 gram',
    });
  });

  it('says nothing about a product not seen lately, or with nothing to say', () => {
    expect(noteFor([row('2026-08-01', 199)], { today: TODAY })).toBeNull();
    expect(noteFor([row('2026-10-01', 199), row('2026-10-15', 199)], { today: TODAY })).toBeNull();
  });
});

describe('basketIndex', () => {
  it("shows each month's prices against now", () => {
    const history = new Map([
      ['a', [row('2026-08-05', 90), row('2026-10-10', 100)]],
      ['b', [row('2026-08-05', 180), row('2026-10-10', 200)]],
    ]);
    const months = basketIndex(history, { today: TODAY, months: 3, fewest: 1 });
    expect(months).toEqual([
      { month: '2026-08', index: 90, products: 2 },
      { month: '2026-09', index: null, products: 0 },
      { month: '2026-10', index: 100, products: 2 },
    ]);
  });
});

describe('spending', () => {
  it('adds up orders by month, leaving out cancelled ones', () => {
    const add = db.prepare(
      "INSERT INTO picnic_deliveries (id, status, windowStart, totalPrice, syncedAt) VALUES (?, ?, ?, ?, 'x')",
    );
    add.run('1', 'COMPLETED', '2026-09-03T18:00:00+02:00', 6000);
    add.run('2', 'COMPLETED', '2026-09-20T18:00:00+02:00', 4000);
    add.run('3', 'CANCELLED', '2026-09-25T18:00:00+02:00', 9999);
    add.run('4', 'COMPLETED', '2026-10-05T18:00:00+02:00', 7000);
    const s = spending(db, { today: TODAY, months: 2 });
    expect(s.months).toEqual([
      { month: '2026-09', total: 10000, orders: 2 },
      { month: '2026-10', total: 7000, orders: 1 },
    ]);
    expect(s.perWeek).toBe(Math.round(17000 / 12));
  });
});

describe('the overview and a product', () => {
  it('puts it together for the usuals, and is empty without prices', () => {
    expect(priceOverview(db, { usuals: [{ productId: 's1' }], today: TODAY })).toMatchObject({
      products: [],
      notes: [],
      kept: { n: 0 },
    });
    seen('s1', [row('2025-10-20', 200), row('2026-10-15', 250, { paid: 200, deal: '2 voor €4' })]);
    const overview = priceOverview(db, { usuals: [{ productId: 's1', imageId: 'img' }], today: TODAY });
    expect(overview.products[0]).toMatchObject({
      productId: 's1',
      price: 250,
      paid: 200,
      deal: '2 voor €4',
      change: 25,
      imageId: 'img',
    });
    expect(overview.products[0].months).toHaveLength(12);
  });

  it("gives one product's history, a year's low and high, and how often it had a deal", () => {
    seen('s2', [
      row('2026-03-02', 199),
      row('2026-05-04', 189, { paid: 150, deal: '1+1' }),
      row('2026-10-12', 219, { unitQuantity: '450 gram' }),
    ]);
    const p = productPrices(db, 's2', { today: TODAY });
    expect(p.year).toEqual({ low: 150, high: 219, dealWeeks: 1, weeks: 3 });
    expect(p.packs.map((x) => x.unitQuantity)).toEqual(['500 gram', '450 gram']);
    expect(p.points).toHaveLength(3);
    expect(productPrices(db, 'nothing')).toBeNull();
  });
});
