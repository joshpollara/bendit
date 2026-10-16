// The household's Picnic order history, kept here.
//
// Picnic's list of deliveries is one request, but what was in each one is a
// request per delivery — and there are hundreds. A delivered order never
// changes, so each is fetched once and kept; only new ones, and ones not yet
// delivered, are asked for again. That makes "what do we usually buy" a query
// rather than a few hundred calls.

/** Usuals and past orders look this far back: what's bought now, not two years ago. */
export const HISTORY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createHistoryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS picnic_deliveries (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, windowStart TEXT, createdAt TEXT,
      totalPrice INTEGER, syncedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS picnic_delivery_items (
      deliveryId TEXT NOT NULL, productId TEXT NOT NULL, name TEXT NOT NULL,
      unitQuantity TEXT, imageId TEXT, quantity INTEGER NOT NULL,
      PRIMARY KEY (deliveryId, productId)
    );
    CREATE INDEX IF NOT EXISTS idx_picnic_items_product ON picnic_delivery_items(productId);
  `);
}

/** The articles of a delivery as Picnic returns them: orders, lines, articles. */
export function itemsOf(delivery) {
  const byProduct = new Map();
  for (const order of delivery.orders ?? []) {
    for (const line of order.items ?? []) {
      for (const article of line.items ?? []) {
        const quantity = article.decorators?.find((d) => d.type === 'QUANTITY')?.quantity ?? 1;
        const existing = byProduct.get(article.id);
        if (existing) existing.quantity += quantity;
        else
          byProduct.set(article.id, {
            productId: article.id,
            name: article.name,
            unitQuantity: article.unit_quantity ?? null,
            imageId: article.image_ids?.[0] ?? null,
            quantity,
          });
      }
    }
  }
  return [...byProduct.values()];
}

async function mapLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Brings the kept history up to date: every delivery in the window that isn't
 * kept yet, and any not yet delivered, whose contents can still change.
 * Cancelled deliveries are remembered but never counted.
 */
export async function syncHistory(db, picnic, { now = Date.now() } = {}) {
  const since = new Date(now - HISTORY_DAYS * DAY_MS).toISOString();
  const summaries = (await picnic.deliveries()).filter((d) => (d.windowStart ?? d.creationTime) >= since);
  const kept = new Map(db.prepare('SELECT id, status FROM picnic_deliveries').all().map((r) => [r.id, r.status]));
  const stale = summaries.filter((d) => d.status !== 'CANCELLED' && (kept.get(d.id) !== 'COMPLETED'));

  const save = db.transaction((summary, items) => {
    db.prepare(
      `INSERT OR REPLACE INTO picnic_deliveries (id, status, windowStart, createdAt, totalPrice, syncedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(summary.id, summary.status, summary.windowStart, summary.creationTime, summary.totalPrice, new Date(now).toISOString());
    db.prepare('DELETE FROM picnic_delivery_items WHERE deliveryId = ?').run(summary.id);
    const insert = db.prepare(
      `INSERT INTO picnic_delivery_items (deliveryId, productId, name, unitQuantity, imageId, quantity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      insert.run(summary.id, item.productId, item.name, item.unitQuantity, item.imageId, item.quantity);
    }
  });

  await mapLimited(stale, 3, async (summary) => save(summary, itemsOf(await picnic.delivery(summary.id))));
  for (const summary of summaries.filter((d) => d.status === 'CANCELLED' && !kept.has(d.id))) save(summary, []);
  return { fetched: stale.length };
}

/** Past orders in the window, newest first, with what was in them. */
export function pastOrders(db, { now = Date.now() } = {}) {
  const since = new Date(now - HISTORY_DAYS * DAY_MS).toISOString();
  const deliveries = db
    .prepare(
      `SELECT * FROM picnic_deliveries WHERE status != 'CANCELLED' AND windowStart >= ?
       ORDER BY windowStart DESC`,
    )
    .all(since);
  const items = db.prepare('SELECT * FROM picnic_delivery_items WHERE deliveryId = ? ORDER BY name');
  return deliveries.map((d) => ({ ...d, items: items.all(d.id) }));
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * What the household usually buys: each product with how many of the window's
 * orders it was in, how many it usually comes to, and — for anything bought
 * more than once — how often, and whether it's due again.
 */
export function usuals(db, { now = Date.now() } = {}) {
  const orders = pastOrders(db, { now }).filter((o) => o.items.length > 0);
  // How long the history covers: from the oldest order in the window to now.
  const spanDays = orders.length ? (now - Date.parse(orders.at(-1).windowStart)) / DAY_MS : 0;
  const byProduct = new Map();
  for (const order of orders) {
    const at = Date.parse(order.windowStart);
    for (const item of order.items) {
      const entry =
        byProduct.get(item.productId) ??
        { productId: item.productId, name: item.name, unitQuantity: item.unitQuantity, imageId: item.imageId, dates: [], quantities: [] };
      entry.dates.push(at);
      entry.quantities.push(item.quantity);
      byProduct.set(item.productId, entry);
    }
  }

  return [...byProduct.values()]
    .map(({ dates, quantities, ...product }) => {
      const sorted = [...dates].sort((a, b) => a - b);
      const gaps = sorted.slice(1).map((at, i) => (at - sorted[i]) / DAY_MS);
      // The typical gap between orders of it, unless it's bought less often
      // than that suggests: two orders a week apart, in three months of orders,
      // isn't a weekly habit.
      const everyDays = gaps.length ? Math.round(Math.max(median(gaps), spanDays / dates.length)) : null;
      const daysSince = Math.floor((now - sorted.at(-1)) / DAY_MS);
      return {
        ...product,
        orders: dates.length,
        ofOrders: orders.length,
        quantity: Math.max(1, Math.round(median(quantities))),
        lastOrdered: new Date(sorted.at(-1)).toISOString(),
        everyDays,
        // A little early counts: the next order is usually a few days off.
        due: everyDays != null && daysSince >= everyDays * 0.8,
      };
    })
    .sort((a, b) => Number(b.due) - Number(a.due) || b.orders - a.orders || a.name.localeCompare(b.name));
}
