// A push before Picnic stops taking changes to the next delivery.
//
// Each person chooses how long before the cutoff they want it, or not at
// all. The cutoff is the selected delivery slot's, one lookup for the whole
// household. Nothing is sent once an order for that delivery is placed, and
// each person gets one per cutoff, even across a restart.

export function createPicnicReminderTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS picnic_reminders (
    userId TEXT PRIMARY KEY,
    hoursBefore INTEGER NOT NULL,
    -- The cutoff last reminded about, so it's once each.
    lastCutoff TEXT
  )`);
}

export const REMINDER_HOURS = [2, 6, 24];

export function setReminder(db, userId, hoursBefore) {
  if (hoursBefore == null) {
    db.prepare('DELETE FROM picnic_reminders WHERE userId = ?').run(userId);
    return null;
  }
  const hours = Number(hoursBefore);
  if (!REMINDER_HOURS.includes(hours)) throw Object.assign(new Error('hoursBefore must be 2, 6 or 24'), { status: 400 });
  db.prepare(
    `INSERT INTO picnic_reminders (userId, hoursBefore) VALUES (?, ?)
     ON CONFLICT (userId) DO UPDATE SET hoursBefore = excluded.hoursBefore`,
  ).run(userId, hours);
  return hours;
}

export const reminderFor = (db, userId) =>
  db.prepare('SELECT hoursBefore FROM picnic_reminders WHERE userId = ?').get(userId)?.hoursBefore ?? null;

const clock = (iso, timeZone) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone });
const day = (iso, timeZone) =>
  new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone }).replace(',', '');
const euros = (cents) => `€${(cents / 100).toFixed(2)}`;

/** What to say: when it closes, and what's in the cart for that delivery. */
export function reminderMessage({ cart, slot, timeZone = 'Europe/Amsterdam' }) {
  const items = cart?.total_count ?? 0;
  const delivery = `${day(slot.windowStart, timeZone)} ${clock(slot.windowStart, timeZone)}`;
  return {
    title: `Picnic order closes at ${clock(slot.cutOffTime, timeZone)}`,
    body: items
      ? `${items} ${items === 1 ? 'item' : 'items'} in the cart, ${euros(cart.checkout_total_price ?? 0)}, for ${delivery}.`
      : `Nothing in the cart yet for ${delivery}.`,
  };
}

/**
 * The household's next cutoff and whether there's an order for it yet,
 * kept for a while: the reminder checks often, Picnic needn't be asked often.
 */
export function createPicnicReminders({ db, picnic, send, now = () => Date.now(), cacheMs = 30 * 60 * 1000 }) {
  let cached = null;

  async function nextCutoff() {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    const { slots = [], selectedSlot } = (await picnic.slots()) ?? {};
    const slot = selectedSlot ? slots.find((s) => s.slotId === selectedSlot.slotId) : null;
    let value = null;
    if (slot?.cutOffTime && slot.windowStart) {
      const deliveries = (await picnic.deliveries().catch(() => [])) ?? [];
      // An order already placed for that delivery needs no reminding.
      const ordered = deliveries.some(
        (d) => d.status === 'CURRENT' && Date.parse(d.windowStart ?? d.slot?.window_start) === Date.parse(slot.windowStart),
      );
      value = { slot, ordered };
    }
    cached = { at: now(), value };
    return value;
  }

  return {
    /** Sends whatever reminders are due now. Returns how many people were reminded. */
    async tick() {
      if (!picnic.status().connected) return 0;
      const people = db
        .prepare(
          `SELECT r.userId, r.hoursBefore, r.lastCutoff, p.timezone
           FROM picnic_reminders r LEFT JOIN profile p ON p.userId = r.userId`,
        )
        .all();
      if (people.length === 0) return 0;
      const next = await nextCutoff().catch(() => null);
      if (!next || next.ordered) return 0;
      const cutoff = Date.parse(next.slot.cutOffTime);
      const left = cutoff - now();
      const due = people.filter(
        (p) => left > 0 && left <= p.hoursBefore * 3_600_000 && p.lastCutoff !== next.slot.cutOffTime,
      );
      if (due.length === 0) return 0;
      const cart = await picnic.cart().catch(() => null);
      const mark = db.prepare('UPDATE picnic_reminders SET lastCutoff = ? WHERE userId = ?');
      for (const person of due) {
        const { title, body } = reminderMessage({ cart, slot: next.slot, timeZone: person.timezone || undefined });
        mark.run(next.slot.cutOffTime, person.userId);
        await send(person.userId, title, body);
      }
      return due.length;
    },

    /** The next cutoff, for showing beside the setting. */
    async next() {
      const value = await nextCutoff().catch(() => null);
      return value ? { cutOffTime: value.slot.cutOffTime, windowStart: value.slot.windowStart, ordered: value.ordered } : null;
    },
  };
}
