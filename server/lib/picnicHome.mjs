// What the Picnic screen opens on: the next delivery and its cutoff, an order
// already on its way, and how much there is to start the next order from.
//
// One request for the lot. Deals take a Picnic lookup per usual the first
// time in a while, so they're waited on only briefly: if they aren't ready the
// count is left out, and it's there the next time the screen is opened.

const LIVE = ['CURRENT', 'IN_PROGRESS'];

/** The placed order due soonest that hasn't been delivered, or null. */
export function arrivingOf(deliveries, now = Date.now()) {
  return (
    (deliveries ?? [])
      .filter((d) => LIVE.includes(d.status) && d.windowStart)
      .filter((d) => !d.windowEnd || Date.parse(d.windowEnd) > now)
      .sort((a, b) => Date.parse(a.windowStart) - Date.parse(b.windowStart))
      .map(({ id, status, windowStart, windowEnd, totalPrice }) => ({
        id,
        status,
        windowStart,
        windowEnd: windowEnd ?? null,
        totalPrice: totalPrice ?? null,
      }))[0] ?? null
  );
}

const within = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);

export async function picnicHome({ next, deliveries, usualsDue, dealCount, planCount, dealWaitMs = 1500, now }) {
  const [nextDelivery, placed, deals] = await Promise.all([
    next().catch(() => null),
    deliveries().catch(() => []),
    within(
      dealCount().catch(() => null),
      dealWaitMs,
    ),
  ]);
  return {
    next: nextDelivery,
    arriving: arrivingOf(placed, now),
    usualsDue,
    deals,
    plan: planCount,
  };
}
