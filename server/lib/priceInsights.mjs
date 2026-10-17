// What the kept prices say: spending, how much more the usuals cost than
// they did, what's worth knowing about one now, and one product's history.
// See lib/priceHistory.mjs for how they're kept.
//
// "Price" is the regular price of one; "paid" what one came to with a deal.
// Comparisons over time use the regular price, so a deal doesn't read as
// prices falling.

import { packGrams } from './picnicNutrition.mjs';
import { dayOf } from './priceHistory.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const daysBefore = (day, n) => dayOf(Date.parse(`${day}T12:00:00Z`) - n * DAY_MS);
const monthOf = (day) => day.slice(0, 7);

/** The last `n` months, oldest first, ending with the one `today` is in. */
export function monthsTo(today, n) {
  const [y, m] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

/** Spent on Picnic orders each month, and a typical week lately. */
export function spending(db, { today = dayOf(), months = 12 } = {}) {
  const list = monthsTo(today, months);
  const rows = db
    .prepare(
      `SELECT substr(windowStart, 1, 7) AS month, SUM(totalPrice) AS total, COUNT(*) AS orders
       FROM picnic_deliveries WHERE status != 'CANCELLED' AND windowStart >= ? GROUP BY month`,
    )
    .all(`${list[0]}-01`);
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const recent = db
    .prepare(
      `SELECT SUM(totalPrice) AS total FROM picnic_deliveries
       WHERE status != 'CANCELLED' AND windowStart >= ? AND windowStart < ?`,
    )
    .get(daysBefore(today, 84), today).total;
  return {
    months: list.map((month) => ({
      month,
      total: byMonth.get(month)?.total ?? 0,
      orders: byMonth.get(month)?.orders ?? 0,
    })),
    perWeek: recent ? Math.round(recent / 12) : null,
  };
}

/** Each product's kept prices, oldest first. */
function historyOf(db, ids) {
  const rows = db
    .prepare(`SELECT * FROM picnic_prices WHERE productId IN (SELECT value FROM json_each(?)) ORDER BY productId, day`)
    .all(JSON.stringify(ids));
  const by = new Map();
  for (const row of rows) by.set(row.productId, [...(by.get(row.productId) ?? []), row]);
  return by;
}

/**
 * How much the usuals cost each month against what they cost now (100):
 * each one's typical price that month over its latest, averaged over the
 * ones seen that month. Months with too few to go by are null.
 */
export function basketIndex(history, { today = dayOf(), months = 12, fewest = 5 } = {}) {
  const list = monthsTo(today, months);
  return list.map((month) => {
    const ratios = [];
    for (const rows of history.values()) {
      const latest = rows.at(-1)?.price;
      const inMonth = rows.filter((r) => monthOf(r.day) === month).map((r) => r.price);
      if (latest && inMonth.length) ratios.push(median(inMonth) / latest);
    }
    return {
      month,
      // A month with only a few products seen says more about them than about prices.
      index: ratios.length >= fewest ? Math.round((100 * ratios.reduce((a, b) => a + b, 0)) / ratios.length) : null,
      products: ratios.length,
    };
  });
}

/** Grams or ml per cent: what a pack gives for its price, to compare sizes. */
const perCent = (row) => {
  const g = packGrams(row.unitQuantity);
  return g && row.price ? g / row.price : null;
};

/**
 * What's worth knowing about one product now, from its history, or null:
 * the lowest it's been in six months, up a tenth or more on a year ago, or a
 * smaller pack for about the same money.
 */
export function noteFor(rows, { today = dayOf() } = {}) {
  const latest = rows.at(-1);
  if (!latest || latest.day < daysBefore(today, 7)) return null;
  const effective = (r) => r.paid ?? r.price;
  const now = effective(latest);

  const halfYear = rows.filter((r) => r !== latest && r.day >= daysBefore(today, 182));
  if (halfYear.length >= 3 && now < Math.min(...halfYear.map(effective))) {
    return { kind: 'lowest', text: 'Lowest in 6 months' };
  }

  // A pack that's shrunk: the latest smaller than before, and less for the money.
  const before = [...rows].reverse().find((r) => r.unitQuantity && r.unitQuantity !== latest.unitQuantity);
  if (before && before.day >= daysBefore(today, 182)) {
    const was = packGrams(before.unitQuantity);
    const is = packGrams(latest.unitQuantity);
    if (was && is && is < was && perCent(latest) < perCent(before) * 0.97) {
      return { kind: 'smaller', text: `Smaller pack: ${before.unitQuantity} → ${latest.unitQuantity}` };
    }
  }

  const yearAgo = rows.filter((r) => r.day >= daysBefore(today, 400) && r.day <= daysBefore(today, 300));
  const then = median(yearAgo.map((r) => r.price));
  if (then && latest.price >= then * 1.1) {
    return {
      kind: 'up',
      text: `Up ${Math.round((latest.price / then - 1) * 100)}% on a year ago`,
    };
  }
  return null;
}

/** A product's typical price each month, for a small chart. */
export function monthly(rows, { today = dayOf(), months = 12 } = {}) {
  return monthsTo(today, months).map((month) => {
    const prices = rows.filter((r) => monthOf(r.day) === month).map((r) => r.price);
    return prices.length ? Math.round(median(prices)) : null;
  });
}

/** The Prices page: spending, the usuals over time, what's worth knowing, and each usual. */
export function priceOverview(db, { usuals, today = dayOf() }) {
  const history = historyOf(
    db,
    usuals.map((u) => u.productId),
  );
  const products = usuals
    .filter((u) => history.has(u.productId))
    .map((u) => {
      const rows = history.get(u.productId);
      const latest = rows.at(-1);
      const yearAgo = median(
        rows.filter((r) => r.day >= daysBefore(today, 400) && r.day <= daysBefore(today, 300)).map((r) => r.price),
      );
      return {
        productId: u.productId,
        name: latest.name,
        unitQuantity: latest.unitQuantity,
        imageId: u.imageId ?? null,
        price: latest.price,
        paid: latest.paid,
        deal: latest.day >= daysBefore(today, 7) ? latest.deal : null,
        seen: latest.day,
        change: yearAgo ? Math.round((latest.price / yearAgo - 1) * 100) : null,
        note: noteFor(rows, { today }),
        months: monthly(rows, { today }),
      };
    });
  const index = basketIndex(history, { today, months: 24 });
  const yearAgo = index.at(-13)?.index;
  return {
    spending: spending(db, { today }),
    basket: {
      months: index,
      // Last year's usuals against now: 92 means they cost 8% less then.
      change: yearAgo ? Math.round((100 / yearAgo - 1) * 100) : null,
    },
    notes: products
      .filter((p) => p.note)
      .map(({ productId, name, imageId, note }) => ({ productId, name, imageId, note })),
    products,
    kept: db.prepare('SELECT COUNT(*) AS n, MIN(day) AS since FROM picnic_prices').get(),
  };
}

/** One product's kept prices, and what's worth knowing about it. */
export function productPrices(db, productId, { today = dayOf() } = {}) {
  const rows = historyOf(db, [productId]).get(productId) ?? [];
  if (!rows.length) return null;
  const latest = rows.at(-1);
  const year = rows.filter((r) => r.day >= daysBefore(today, 365));
  const weeks = new Set(year.map((r) => `${r.day.slice(0, 4)}-${Math.floor(Date.parse(r.day) / (7 * DAY_MS))}`));
  const dealWeeks = new Set(
    year.filter((r) => r.deal).map((r) => `${r.day.slice(0, 4)}-${Math.floor(Date.parse(r.day) / (7 * DAY_MS))}`),
  );
  const packs = [];
  for (const r of rows) {
    if (r.unitQuantity && packs.at(-1)?.unitQuantity !== r.unitQuantity)
      packs.push({ day: r.day, unitQuantity: r.unitQuantity });
  }
  return {
    productId,
    name: latest.name,
    unitQuantity: latest.unitQuantity,
    points: rows.map(({ day, price, paid, deal }) => ({ day, price, paid, deal })),
    latest: { day: latest.day, price: latest.price, paid: latest.paid, deal: latest.deal },
    year: year.length
      ? {
          low: Math.min(...year.map((r) => r.paid ?? r.price)),
          high: Math.max(...year.map((r) => r.price)),
          // Of the weeks it was seen, how many had a deal.
          dealWeeks: dealWeeks.size,
          weeks: weeks.size,
        }
      : null,
    packs: packs.length > 1 ? packs : [],
    note: noteFor(rows, { today }),
  };
}
