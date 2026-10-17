import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPicnicReminders, createPicnicReminderTables, reminderMessage, setReminder } from './picnicReminder.mjs';

const SLOT = { slotId: 'slot-1', windowStart: '2026-10-18T19:00:00Z', cutOffTime: '2026-10-17T20:00:00Z' };

function fakePicnic({ ordered = false, items = 31 } = {}) {
  const asked = { slots: 0 };
  return {
    asked,
    status: () => ({ connected: true }),
    slots: async () => (asked.slots++, { slots: [SLOT], selectedSlot: { slotId: 'slot-1' } }),
    deliveries: async () => (ordered ? [{ status: 'CURRENT', windowStart: SLOT.windowStart }] : []),
    cart: async () => ({ total_count: items, checkout_total_price: 7841 }),
  };
}

let db;
let sent;
const send = async (userId, title, body) => sent.push({ userId, title, body });
beforeEach(() => {
  db = new Database(':memory:');
  db.exec("CREATE TABLE profile (userId TEXT PRIMARY KEY, timezone TEXT)");
  db.prepare("INSERT INTO profile VALUES ('ann', 'Europe/Amsterdam')").run();
  createPicnicReminderTables(db);
  sent = [];
});

const at = (iso) => () => Date.parse(iso);

describe('the Picnic cutoff reminder', () => {
  it('says when it closes and what is in the cart, in local time', () => {
    expect(reminderMessage({ cart: { total_count: 31, checkout_total_price: 7841 }, slot: SLOT })).toEqual({
      title: 'Picnic order closes at 22:00',
      body: '31 items in the cart, €78.41, for Sun 18 Oct 21:00.',
    });
    expect(reminderMessage({ cart: { total_count: 0 }, slot: SLOT }).body).toBe('Nothing in the cart yet for Sun 18 Oct 21:00.');
  });

  it('reminds each person once, within their chosen time before the cutoff', async () => {
    setReminder(db, 'ann', 2);
    setReminder(db, 'ben', 6);
    // Five hours before: only Ben's six-hour reminder is due.
    expect(await createPicnicReminders({ db, picnic: fakePicnic(), send, now: at('2026-10-17T15:00:00Z') }).tick()).toBe(1);
    expect(sent.map((s) => s.userId)).toEqual(['ben']);
    // An hour before: Ann's, and not Ben's again.
    const later = createPicnicReminders({ db, picnic: fakePicnic(), send, now: at('2026-10-17T19:00:00Z') });
    expect(await later.tick()).toBe(1);
    expect(await later.tick()).toBe(0);
    expect(sent.map((s) => s.userId)).toEqual(['ben', 'ann']);
  });

  it('says nothing once the order is placed, or after the cutoff', async () => {
    setReminder(db, 'ann', 24);
    expect(await createPicnicReminders({ db, picnic: fakePicnic({ ordered: true }), send, now: at('2026-10-17T19:00:00Z') }).tick()).toBe(0);
    expect(await createPicnicReminders({ db, picnic: fakePicnic(), send, now: at('2026-10-17T20:30:00Z') }).tick()).toBe(0);
    expect(sent).toEqual([]);
  });

  it('asks Picnic for the slot once in a while, not every check', async () => {
    setReminder(db, 'ann', 2);
    const picnic = fakePicnic();
    const reminders = createPicnicReminders({ db, picnic, send, now: at('2026-10-17T10:00:00Z') });
    await reminders.tick();
    await reminders.tick();
    expect(picnic.asked.slots).toBe(1);
  });

  it('only takes the offered lead times', () => {
    expect(() => setReminder(db, 'ann', 3)).toThrow(/2, 6 or 24/);
    expect(setReminder(db, 'ann', null)).toBeNull();
  });
});
