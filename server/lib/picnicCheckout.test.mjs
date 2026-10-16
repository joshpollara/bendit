import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cancelPayment,
  checkoutState,
  confirm,
  createCheckoutTables,
  pay,
  returnUrlFor,
  startCheckout,
} from './picnicCheckout.mjs';

const SLOT = { slot_id: 'slot-1', window_start: '2026-10-20T18:15:00+02:00', window_end: '2026-10-20T19:15:00+02:00' };

/** A stand-in for the Picnic service, recording calls. */
function fakePicnic(overrides = {}) {
  const calls = [];
  const picnic = {
    calls,
    cart: async () => ({ total_count: 3, mts: 42, selected_slot: { slot_id: 'slot-1' }, delivery_slots: [SLOT] }),
    startCheckout: async (input) => {
      calls.push(['startCheckout', input]);
      return { order_id: 'order-1', total_price: 5230, total_count: 3, total_deposit: 25, total_savings: 100, delivery_slots: [SLOT] };
    },
    initiatePayment: async (orderId, returnUrl) => {
      calls.push(['initiatePayment', orderId, returnUrl]);
      return { transaction_id: 'tx-1', action: { redirect_url: 'https://bank.example/pay' } };
    },
    checkoutStatus: async () => ({ checkout_status: 'IN_PROGRESS' }),
    deliveries: async () => [],
    cancelCheckout: async (tx) => calls.push(['cancelCheckout', tx]),
    confirmOrder: async (id) => calls.push(['confirmOrder', id]),
    ...overrides,
  };
  return picnic;
}

let db;
beforeEach(() => {
  db = new Database(':memory:');
  createCheckoutTables(db);
});

describe('starting checkout', () => {
  it('says what would be paid for, with the slot, and records who started it', async () => {
    const picnic = fakePicnic();
    const summary = await startCheckout(db, picnic, { userId: 'ann' });
    expect(summary).toMatchObject({ orderId: 'order-1', total: 5230, count: 3, slot: { start: SLOT.window_start } });
    expect(picnic.calls).toEqual([['startCheckout', { mts: 42 }]]);
    expect(db.prepare('SELECT status, startedBy FROM picnic_checkouts').get()).toEqual({ status: 'STARTED', startedBy: 'ann' });
  });

  it('passes on the key that accepts a checkout issue', async () => {
    const picnic = fakePicnic();
    await startCheckout(db, picnic, { userId: 'ann', resolveKey: 'AGE_OK' });
    expect(picnic.calls[0][1]).toEqual({ mts: 42, resolve_key: 'AGE_OK' });
  });

  it('refuses an empty cart, or one without a slot', async () => {
    await expect(
      startCheckout(db, fakePicnic({ cart: async () => ({ total_count: 0 }) }), { userId: 'ann' }),
    ).rejects.toMatchObject({ code: 'empty_cart' });
    await expect(
      startCheckout(db, fakePicnic({ cart: async () => ({ total_count: 2, selected_slot: null }) }), { userId: 'ann' }),
    ).rejects.toMatchObject({ code: 'no_slot' });
  });
});

describe('the return address', () => {
  it('is the page that waits for the result, on the same server', () => {
    expect(returnUrlFor('https://bendit.fly.dev', 'bendit.fly.dev', 'order-1')).toBe(
      'https://bendit.fly.dev/picnic/checkout?order=order-1',
    );
  });

  it('is never somewhere else', () => {
    expect(() => returnUrlFor('https://evil.example', 'bendit.fly.dev', 'o')).toThrow();
    expect(() => returnUrlFor('javascript:alert(1)', 'bendit.fly.dev', 'o')).toThrow();
  });
});

describe('paying', () => {
  it('sends the person to their bank, once', async () => {
    const picnic = fakePicnic();
    await startCheckout(db, picnic, { userId: 'ann' });
    expect(await pay(db, picnic, { orderId: 'order-1', returnUrl: 'https://x/r' })).toEqual({
      transactionId: 'tx-1',
      redirectUrl: 'https://bank.example/pay',
    });
    await expect(pay(db, picnic, { orderId: 'order-1', returnUrl: 'https://x/r' })).rejects.toMatchObject({
      code: 'already_paying',
    });
  });

  it('waits while the bank is still busy', async () => {
    const picnic = fakePicnic();
    await startCheckout(db, picnic, { userId: 'ann' });
    await pay(db, picnic, { orderId: 'order-1', returnUrl: 'https://x/r' });
    expect(await checkoutState(db, picnic, 'order-1')).toMatchObject({ status: 'PAYING', placed: false });
  });

  it('finds the order among the deliveries once paid, without confirming anything', async () => {
    const picnic = fakePicnic({
      checkoutStatus: async () => ({ checkout_status: 'FINISHED' }),
      deliveries: async () => [{ id: 'd-1', status: 'CURRENT', creationTime: new Date().toISOString() }],
    });
    await startCheckout(db, picnic, { userId: 'ann' });
    await pay(db, picnic, { orderId: 'order-1', returnUrl: 'https://x/r' });
    expect(await checkoutState(db, picnic, 'order-1')).toMatchObject({ status: 'PLACED', placed: true });
    expect(picnic.calls.some(([name]) => name === 'confirmOrder')).toBe(false);
  });

  it('offers confirming only when a paid order did not appear, and only once', async () => {
    const picnic = fakePicnic({ checkoutStatus: async () => ({ checkout_status: 'FINISHED' }) });
    await startCheckout(db, picnic, { userId: 'ann' });
    await expect(confirm(db, picnic, 'order-1')).rejects.toMatchObject({ code: 'cannot_confirm' });
    await pay(db, picnic, { orderId: 'order-1', returnUrl: 'https://x/r' });
    expect(await checkoutState(db, picnic, 'order-1')).toMatchObject({ status: 'FINISHED', placed: false });
    await confirm(db, picnic, 'order-1');
    expect(picnic.calls.filter(([name]) => name === 'confirmOrder')).toEqual([['confirmOrder', 'order-1']]);
    await expect(confirm(db, picnic, 'order-1')).rejects.toMatchObject({ code: 'cannot_confirm' });
  });

  it('cancels a payment in progress, and not one that finished', async () => {
    const picnic = fakePicnic();
    await startCheckout(db, picnic, { userId: 'ann' });
    await pay(db, picnic, { orderId: 'order-1', returnUrl: 'https://x/r' });
    expect(await cancelPayment(db, picnic, 'order-1')).toMatchObject({ status: 'CANCELLED' });
    expect(picnic.calls).toContainEqual(['cancelCheckout', 'tx-1']);
    await expect(cancelPayment(db, picnic, 'order-1')).rejects.toMatchObject({ code: 'cannot_cancel' });
  });

  it('knows nothing of orders it did not start', async () => {
    await expect(checkoutState(db, fakePicnic(), 'someone-elses')).rejects.toMatchObject({ code: 'unknown_checkout' });
  });
});
