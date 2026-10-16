// Paying for the Picnic cart.
//
// The order of calls follows picnic-api's own checkout script, which stops
// short of paying: read the cart, start checkout, initiate payment, send the
// person to their bank, poll until the payment is finished. Nobody has
// published the whole thing working end to end, so every step that commits
// money or an order is one a person asks for, and nothing here calls
// confirmOrder by itself — after a finished payment the order is looked for
// among the deliveries, and confirming is offered only if it isn't there.
//
// The cart is the household's, so each attempt is recorded with who started it.

import { PicnicError } from './picnic.mjs';

export function createCheckoutTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS picnic_checkouts (
    orderId TEXT PRIMARY KEY,
    transactionId TEXT,
    total INTEGER,
    -- STARTED, PAYING, FINISHED, PLACED, CONFIRMED, CANCELLED
    status TEXT NOT NULL,
    startedBy TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`);
}

const now = () => new Date().toISOString();

function record(db, orderId) {
  const row = db.prepare('SELECT * FROM picnic_checkouts WHERE orderId = ?').get(orderId);
  if (!row) throw new PicnicError('unknown_checkout', 'No checkout with that order here.', { status: 404 });
  return row;
}

const setStatus = (db, orderId, status, extra = {}) =>
  db
    .prepare(
      `UPDATE picnic_checkouts SET status = @status, updatedAt = @updatedAt,
         transactionId = COALESCE(@transactionId, transactionId) WHERE orderId = @orderId`,
    )
    .run({ orderId, status, updatedAt: now(), transactionId: extra.transactionId ?? null });

/**
 * Starts checkout and says what would be paid for. Places nothing: picnic-api's
 * own test script runs exactly this as its dry run.
 */
export async function startCheckout(db, picnic, { resolveKey, userId }) {
  const cart = await picnic.cart();
  if (!cart.total_count) throw new PicnicError('empty_cart', 'The cart is empty.', { status: 409 });
  const slotId = cart.selected_slot?.slot_id;
  if (!slotId) throw new PicnicError('no_slot', 'Choose a delivery slot first.', { status: 409 });

  const started = await picnic.startCheckout({ mts: cart.mts, ...(resolveKey ? { resolve_key: resolveKey } : {}) });
  const slot = (started.delivery_slots ?? cart.delivery_slots ?? []).find((s) => s.slot_id === slotId);
  db.prepare(
    `INSERT OR REPLACE INTO picnic_checkouts (orderId, total, status, startedBy, startedAt, updatedAt)
     VALUES (?, ?, 'STARTED', ?, ?, ?)`,
  ).run(started.order_id, started.total_price, userId, now(), now());

  return {
    orderId: started.order_id,
    total: started.total_price,
    count: started.total_count,
    deposit: started.total_deposit ?? 0,
    savings: started.total_savings ?? 0,
    expiresAt: started.transaction_expiry ?? null,
    address: started.address ?? null,
    slot: slot ? { start: slot.window_start, end: slot.window_end } : null,
  };
}

/** Where the bank should send the person back to: this app, on the page that waits for the result. */
export function returnUrlFor(origin, host, orderId) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new PicnicError('bad_origin', 'Unrecognised origin.', { status: 400 });
  }
  // Only ever back to the server the request came to.
  if (!/^https?:$/.test(url.protocol) || url.host !== host) {
    throw new PicnicError('bad_origin', 'Unrecognised origin.', { status: 400 });
  }
  return `${url.origin}/picnic/checkout?order=${encodeURIComponent(orderId)}`;
}

export async function pay(db, picnic, { orderId, returnUrl }) {
  const row = record(db, orderId);
  if (row.status !== 'STARTED') {
    throw new PicnicError('already_paying', 'Payment for this order has already started.', { status: 409 });
  }
  const payment = await picnic.initiatePayment(orderId, returnUrl);
  setStatus(db, orderId, 'PAYING', { transactionId: payment.transaction_id });
  return {
    transactionId: payment.transaction_id,
    // Absent for a payment that needs no bank page, such as a direct debit.
    redirectUrl: payment.action?.redirect_url ?? payment.issuer_authentication_url ?? null,
  };
}

/**
 * Where a checkout stands. Once Picnic reports the payment finished, the order
 * is looked for among the upcoming deliveries created since checkout started.
 */
export async function checkoutState(db, picnic, orderId) {
  const row = record(db, orderId);
  if (['PLACED', 'CONFIRMED', 'CANCELLED'].includes(row.status)) return { ...row, placed: row.status !== 'CANCELLED' };
  if (row.status === 'STARTED' || !row.transactionId) return { ...row, placed: false };

  const { checkout_status: paymentStatus } = await picnic.checkoutStatus(row.transactionId);
  if (paymentStatus !== 'FINISHED') return { ...row, paymentStatus, placed: false };

  const since = Date.parse(row.startedAt) - 5 * 60 * 1000;
  const delivery = (await picnic.deliveries()).find(
    (d) => d.status === 'CURRENT' && Date.parse(d.creationTime) >= since,
  );
  setStatus(db, orderId, delivery ? 'PLACED' : 'FINISHED');
  return { ...record(db, orderId), paymentStatus, placed: Boolean(delivery), delivery: delivery ?? null };
}

export async function cancelPayment(db, picnic, orderId) {
  const row = record(db, orderId);
  if (!['STARTED', 'PAYING'].includes(row.status)) {
    throw new PicnicError('cannot_cancel', 'This checkout can no longer be cancelled here.', { status: 409 });
  }
  if (row.transactionId) await picnic.cancelCheckout(row.transactionId);
  setStatus(db, orderId, 'CANCELLED');
  return record(db, orderId);
}

/** Only for a finished payment whose order didn't appear, and only when asked. */
export async function confirm(db, picnic, orderId) {
  const row = record(db, orderId);
  if (row.status !== 'FINISHED') {
    throw new PicnicError('cannot_confirm', 'Only a paid order that hasn’t appeared can be confirmed.', {
      status: 409,
    });
  }
  await picnic.confirmOrder(orderId);
  setStatus(db, orderId, 'CONFIRMED');
  return record(db, orderId);
}
