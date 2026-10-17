// What Picnic's products have cost, kept over time.
//
// Picnic keeps no price history that can be asked for, so it's kept here,
// from three places:
//
// - Past orders. Each line of a delivered order says what it cost at the
//   regular price, what was paid (in a PRICE decorator) and the deal (a PROMO
//   one). Their articles' own prices are no use (every one reads 432199).
//   These go back as far as the household's orders do; the older ones are
//   fetched slowly, once, in the background.
// - Search pages, read anyway for deals: every product on one, with its price
//   and its deal.
// - A daily look at the usuals' prices, so they're seen even when nobody
//   searches.
//
// One row per product per day; a later look on the same day replaces an
// earlier one. Prices are per item, in cents.

import { dealTerms } from './picnicDeals.mjs';
import { HISTORY_DAYS } from './picnicHistory.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export function createPriceTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS picnic_prices (
      productId TEXT NOT NULL,
      day TEXT NOT NULL,
      name TEXT NOT NULL,
      unitQuantity TEXT,
      -- The regular price of one, and what one cost with the deal, if there was one.
      price INTEGER NOT NULL,
      paid INTEGER,
      deal TEXT,
      -- 'order', 'search' or 'snapshot'.
      source TEXT NOT NULL,
      PRIMARY KEY (productId, day)
    );
    CREATE INDEX IF NOT EXISTS idx_picnic_prices_day ON picnic_prices(day);
    -- Past deliveries already read for their prices.
    CREATE TABLE IF NOT EXISTS picnic_price_scans (deliveryId TEXT PRIMARY KEY, scannedAt TEXT NOT NULL);
  `);
}

/** A date as the household sees it, in Amsterdam. */
export const dayOf = (at = Date.now()) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });

/**
 * Keeps prices seen on a day. An order's price is what was really paid, so a
 * search later that day doesn't replace it.
 */
export function recordPrices(db, observations) {
  const upsert = db.prepare(
    `INSERT INTO picnic_prices (productId, day, name, unitQuantity, price, paid, deal, source)
     VALUES (@productId, @day, @name, @unitQuantity, @price, @paid, @deal, @source)
     ON CONFLICT (productId, day) DO UPDATE SET
       name = excluded.name, unitQuantity = excluded.unitQuantity, price = excluded.price,
       paid = excluded.paid, deal = excluded.deal, source = excluded.source
     WHERE picnic_prices.source != 'order' OR excluded.source = 'order'`,
  );
  let kept = 0;
  db.transaction(() => {
    for (const o of observations) {
      if (!/^s?\d+$/.test(o.productId ?? '') || !o.name || !(o.price > 0) || !/^\d{4}-\d\d-\d\d$/.test(o.day)) continue;
      upsert.run({
        productId: o.productId,
        day: o.day,
        name: o.name,
        unitQuantity: o.unitQuantity ?? null,
        price: Math.round(o.price),
        paid: o.paid != null && Math.round(o.paid) !== Math.round(o.price) ? Math.round(o.paid) : null,
        deal: o.deal ?? null,
        source: o.source,
      });
      kept++;
    }
  })();
  return kept;
}

/**
 * Prices from a delivered order, on the day it was delivered. A line is one
 * product, maybe several of it; its price is the regular price of them all,
 * and the PRICE decorator what was paid for them all.
 */
export function pricesFromDelivery(delivery, windowStart) {
  const day = String(windowStart ?? delivery.slot?.window_start ?? '').slice(0, 10);
  const out = [];
  for (const order of delivery.orders ?? []) {
    for (const line of order.items ?? []) {
      const articles = line.items ?? [];
      const ids = new Set(articles.map((a) => a.id));
      if (ids.size !== 1 || !(line.price > 0)) continue;
      const quantity = articles.reduce(
        (n, a) => n + (a.decorators?.find((d) => d.type === 'QUANTITY')?.quantity ?? 1),
        0,
      );
      const paid = line.decorators?.find((d) => d.type === 'PRICE')?.display_price;
      const deal = line.decorators?.find((d) => d.type === 'PROMO')?.text ?? null;
      out.push({
        productId: articles[0].id,
        day,
        name: articles[0].name,
        unitQuantity: articles[0].unit_quantity ?? null,
        price: line.price / quantity,
        paid: paid != null ? paid / quantity : null,
        deal,
        source: 'order',
      });
    }
  }
  return out;
}

/**
 * Prices from a search page, as read by the deal finder. A reduction's price
 * is in the deal; a multi-buy's is what one comes to when bought that way.
 */
export function pricesFromSearchPage({ products, deals }, day, source = 'search') {
  return products
    .filter((p) => p.price > 0)
    .map((p) => {
      const deal = deals.get(p.productId) ?? null;
      let paid = null;
      if (deal) {
        const terms = dealTerms(deal.label, deal.price ?? p.price);
        paid = terms.count > 1 ? terms.total / terms.count : (deal.price ?? null);
      }
      return {
        productId: p.productId,
        day,
        name: p.name,
        unitQuantity: p.unitQuantity,
        // A reduction shows the price before it as "was".
        price: deal?.was ?? p.price,
        paid,
        deal: deal?.label ?? null,
        source,
      };
    });
}

/** Prices from Picnic's plain search: no deals, just what each costs. */
export const pricesFromSearch = (results, day) =>
  (Array.isArray(results) ? results : []).map((p) => ({
    productId: p.id,
    day,
    name: p.name,
    unitQuantity: p.unit_quantity ?? null,
    price: p.display_price,
    source: 'search',
  }));

/**
 * Reads the household's older orders for their prices, one at a time and
 * slowly: hundreds of them, from an API Picnic doesn't offer for this. Each
 * is read once. Returns how many were read.
 */
export async function backfillPrices(db, picnic, { pauseMs = 2000, limit = Infinity, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const done = new Set(
    db
      .prepare('SELECT deliveryId FROM picnic_price_scans')
      .all()
      .map((r) => r.deliveryId),
  );
  const all = await picnic.deliveries();
  // Spending needs only the summaries, which come in one request.
  keepSummaries(db, all);
  const summaries = all.filter((d) => d.status === 'COMPLETED' && !done.has(d.id));
  const mark = db.prepare('INSERT OR REPLACE INTO picnic_price_scans (deliveryId, scannedAt) VALUES (?, ?)');
  let read = 0;
  for (const summary of summaries) {
    if (read >= limit) break;
    const delivery = await picnic.delivery(summary.id);
    recordPrices(db, pricesFromDelivery(delivery, summary.windowStart));
    mark.run(summary.id, new Date().toISOString());
    read++;
    await wait(pauseMs);
  }
  return read;
}

/**
 * Keeps older deliveries' dates and totals, for spending over time: the
 * history keeps only the last few months, with what was in them. Recent ones
 * are left to it — kept here without their contents, it would think them done.
 */
export function keepSummaries(db, summaries, { now = Date.now() } = {}) {
  const since = new Date(now - HISTORY_DAYS * DAY_MS).toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO picnic_deliveries (id, status, windowStart, createdAt, totalPrice, syncedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const at = new Date(now).toISOString();
  db.transaction(() => {
    for (const s of summaries ?? []) {
      if ((s.windowStart ?? s.creationTime ?? '') >= since) continue;
      insert.run(s.id, s.status, s.windowStart ?? null, s.creationTime ?? null, s.totalPrice ?? null, at);
    }
  })();
}

/** Whether the usuals have had their look today. */
export const snapshotDue = (lastAt, now = Date.now()) => !lastAt || dayOf(lastAt) !== dayOf(now);

export { DAY_MS };
