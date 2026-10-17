import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { api, type PicnicTracking } from '../lib/api';

const W = 320;
const H = 160;
const PAD = 12;

/** Route points fitted into the drawing, north up. */
export function project(points: [number, number][]) {
  const mid = (points.reduce((sum, [lat]) => sum + lat, 0) / points.length) * (Math.PI / 180);
  const xs = points.map(([, lng]) => lng * Math.cos(mid));
  const ys = points.map(([lat]) => -lat);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = Math.min((W - 2 * PAD) / (maxX - minX || 1), (H - 2 * PAD) / (maxY - minY || 1));
  const offX = (W - (maxX - minX) * scale) / 2;
  const offY = (H - (maxY - minY) * scale) / 2;
  return points.map((_, i) => [offX + (xs[i] - minX) * scale, offY + (ys[i] - minY) * scale] as const);
}

const line = (pts: readonly (readonly [number, number])[]) =>
  pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

function RouteSketch({ route }: { route: NonNullable<PicnicTracking['route']> }) {
  const pts = project(route.points);
  const van = pts[route.at];
  const home = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-xl bg-surface" role="img" aria-label="Route">
      <polyline points={line(pts.slice(0, route.at + 1))} fill="none" className="stroke-line" strokeWidth="3" />
      <polyline
        points={line(pts.slice(route.at))}
        fill="none"
        className="stroke-accent"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <circle cx={home[0]} cy={home[1]} r="6" className="fill-card stroke-ink" strokeWidth="2.5" />
      <circle cx={van[0]} cy={van[1]} r="7" className="fill-accent stroke-card" strokeWidth="2.5" />
    </svg>
  );
}

/** Live arrival, driver and route, asked again as often as Picnic says. */
export default function PicnicTrackingView({ id, initial }: { id: string; initial: PicnicTracking }) {
  const [tracking, setTracking] = useState<PicnicTracking | null>(initial);
  useEffect(() => {
    if (!tracking) return;
    const timer = window.setTimeout(() => {
      api.picnicTracking(id).then(setTracking, () => {});
    }, tracking.pollMs);
    return () => window.clearTimeout(timer);
  }, [id, tracking]);

  if (!tracking) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-accent">
        Arriving about {format(parseISO(tracking.eta), 'HH:mm')}
        {tracking.minutes > 0 && ` · ${tracking.minutes} min`}
      </p>
      {tracking.driver && (
        <div className="flex items-center gap-2">
          {tracking.driver.photoUrl && (
            <img src={tracking.driver.photoUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
          )}
          <span className="text-sm">{tracking.driver.name}</span>
        </div>
      )}
      {tracking.route && <RouteSketch route={tracking.route} />}
    </div>
  );
}
