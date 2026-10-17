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

/** Close enough to its window that the van could be out: from two hours before. */
export const nearWindow = (arriving, now = Date.now()) =>
  Boolean(arriving) && Date.parse(arriving.windowStart) - now < 2 * 60 * 60 * 1000;

export async function picnicHome({
  next,
  deliveries,
  usualsDue,
  dealCount,
  planCount,
  track = async () => null,
  dealWaitMs = 1500,
  now,
}) {
  const [nextDelivery, placed, deals] = await Promise.all([
    next().catch(() => null),
    deliveries().catch(() => []),
    within(
      dealCount().catch(() => null),
      dealWaitMs,
    ),
  ]);
  const arriving = arrivingOf(placed, now);
  const tracking = nearWindow(arriving, now) ? await track(arriving.id).catch(() => null) : null;
  return {
    next: nextDelivery,
    arriving: arriving && { ...arriving, eta: tracking?.eta ?? null, minutes: tracking?.minutes ?? null },
    usualsDue,
    deals,
    plan: planCount,
  };
}
