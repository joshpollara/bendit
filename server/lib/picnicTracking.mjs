// A delivery on its way: when it'll arrive, who's bringing it, and the route.
//
// Picnic answers two things while a delivery is out. The position says when
// the van is expected and which moment of its planned route it's at now; the
// scenario is that planned route, a timestamped list of points, with the
// driver. Points are thinned for drawing: a route can have thousands.

const MAX_POINTS = 150;

/** Every nth point, keeping the first and last, so at most `max` remain. */
export function thin(points, max = MAX_POINTS) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

/** The index of the last point at or before `ts`; 0 before the route starts. */
export function indexAt(points, ts) {
  let at = 0;
  for (let i = 0; i < points.length; i++) if (points[i].ts <= ts) at = i;
  return at;
}

/** The tracking to show, or null when Picnic gave no position. */
export function trackingOf({ position, scenario, now = Date.now() }) {
  if (!position?.eta) return null;
  const route = (scenario?.scenario ?? []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  const points = thin(route);
  return {
    eta: new Date(position.eta).toISOString(),
    minutes: Math.max(0, Math.round((position.eta - now) / 60_000)),
    moving: Boolean(position.scenario_in_progress),
    // Picnic says how often to ask again; not more than every 15 s.
    pollMs: Math.max(15_000, Number(position.query_interval) || 30_000),
    driver: scenario?.driver?.name ? { name: scenario.driver.name, photoUrl: scenario.driver.photo_url ?? null } : null,
    route:
      points.length >= 2
        ? { points: points.map((p) => [p.lat, p.lng]), at: indexAt(points, position.scenario_ts ?? now) }
        : null,
  };
}
