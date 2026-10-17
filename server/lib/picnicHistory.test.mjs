import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHistoryTables, itemsOf, pastOrders, syncHistory, usuals } from './picnicHistory.mjs';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

const article = (id, name, quantity) => ({
  id,
  name,
  unit_quantity: '1 liter',
  image_ids: [`img-${id}`],
  decorators: [{ type: 'QUANTITY', quantity }],
});
const delivery = (articles) => ({ orders: [{ items: [{ items: articles }] }] });

/** A Picnic with deliveries 4, 18, 32 and 200 days ago, plus a cancelled one. */
function fakePicnic() {
  const fetched = [];
  const details = {
    d4: delivery([article('milk', 'Melk', 2), article('eggs', 'Eieren', 1)]),
    d18: delivery([article('milk', 'Melk', 2), article('coffee', 'Koffie', 1)]),
    d32: delivery([article('milk', 'Melk', 1), article('eggs', 'Eieren', 1)]),
    d200: delivery([article('old', 'Oud', 1)]),
  };
  return {
    fetched,
    deliveries: async () => [
      { id: 'd4', status: 'COMPLETED', windowStart: daysAgo(4), creationTime: daysAgo(6), totalPrice: 1000 },
      { id: 'd18', status: 'COMPLETED', windowStart: daysAgo(18), creationTime: daysAgo(20), totalPrice: 1000 },
      { id: 'd32', status: 'COMPLETED', windowStart: daysAgo(32), creationTime: daysAgo(34), totalPrice: 1000 },
      { id: 'dx', status: 'CANCELLED', windowStart: daysAgo(10), creationTime: daysAgo(11), totalPrice: 0 },
      { id: 'd200', status: 'COMPLETED', windowStart: daysAgo(200), creationTime: daysAgo(201), totalPrice: 1000 },
    ],
    delivery: async (id) => {
      fetched.push(id);
      return details[id];
    },
  };
}

let db;
beforeEach(() => {
  db = new Database(':memory:');
  createHistoryTables(db);
});

describe('itemsOf', () => {
  it('adds up a product that appears on more than one line', () => {
    const items = itemsOf({
      orders: [{ items: [{ items: [article('milk', 'Melk', 1)] }, { items: [article('milk', 'Melk', 2)] }] }],
    });
    expect(items).toEqual([
      { productId: 'milk', name: 'Melk', unitQuantity: '1 liter', imageId: 'img-milk', quantity: 3 },
    ]);
  });
});

describe('syncing the history', () => {
  it('fetches what was in each delivery of the last three months, once', async () => {
    const picnic = fakePicnic();
    expect(await syncHistory(db, picnic, { now: NOW })).toEqual({ fetched: 3 });
    expect(picnic.fetched.sort()).toEqual(['d18', 'd32', 'd4']);
    picnic.fetched.length = 0;
    expect(await syncHistory(db, picnic, { now: NOW })).toEqual({ fetched: 0 });
  });

  it('lists past orders newest first, leaving out cancelled ones', async () => {
    await syncHistory(db, fakePicnic(), { now: NOW });
    const orders = pastOrders(db, { now: NOW });
    expect(orders.map((o) => o.id)).toEqual(['d4', 'd18', 'd32']);
    expect(orders[0].items.map((i) => [i.name, i.quantity])).toEqual([
      ['Eieren', 1],
      ['Melk', 2],
    ]);
  });
});

describe('usuals', () => {
  it('ranks by how often it is bought, with the usual quantity and how often', async () => {
    await syncHistory(db, fakePicnic(), { now: NOW });
    const list = usuals(db, { now: NOW });
    const milk = list.find((u) => u.productId === 'milk');
    // In all three orders, 2 most times, every 14 days, last bought 4 days ago: not due yet.
    expect(milk).toMatchObject({ orders: 3, ofOrders: 3, quantity: 2, everyDays: 14, due: false });
    const eggs = list.find((u) => u.productId === 'eggs');
    // Every 28 days, last bought 4 days ago.
    expect(eggs).toMatchObject({ orders: 2, everyDays: 28, due: false });
    const coffee = list.find((u) => u.productId === 'coffee');
    expect(coffee).toMatchObject({ orders: 1, everyDays: null, due: false });
    expect(list.map((u) => u.productId)).toEqual(['milk', 'eggs', 'coffee']);
  });

  it('does not call an occasional buy a weekly one', async () => {
    const picnic = fakePicnic();
    const deliveries = await picnic.deliveries();
    picnic.deliveries = async () => [
      ...deliveries,
      { id: 'd60', status: 'COMPLETED', windowStart: daysAgo(60), creationTime: daysAgo(61), totalPrice: 1000 },
      { id: 'd80', status: 'COMPLETED', windowStart: daysAgo(80), creationTime: daysAgo(81), totalPrice: 1000 },
    ];
    const detail = picnic.delivery;
    picnic.delivery = async (id) => (id === 'd60' || id === 'd80' ? delivery([article('tea', 'Thee', 1)]) : detail(id));
    await syncHistory(db, picnic, { now: NOW });
    // Coffee once, 18 days ago; nothing to go on. Tea twice, 20 days apart, in 80 days of orders: every 40.
    expect(usuals(db, { now: NOW }).find((u) => u.productId === 'tea')).toMatchObject({ everyDays: 40 });
  });

  it('marks something due once most of its usual gap has passed', async () => {
    await syncHistory(db, fakePicnic(), { now: NOW });
    // Twelve days after the last order, milk (every 14 days) is due and comes first.
    const later = NOW + 8 * 86_400_000;
    const list = usuals(db, { now: later });
    expect(list[0]).toMatchObject({ productId: 'milk', due: true });
  });
});
