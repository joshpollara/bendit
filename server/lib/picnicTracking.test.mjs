import { describe, expect, it } from 'vitest';
import { indexAt, thin, trackingOf } from './picnicTracking.mjs';

const NOW = Date.parse('2026-10-20T17:00:00Z');
const route = Array.from({ length: 400 }, (_, i) => ({
  ts: NOW - 20 * 60_000 + i * 6_000,
  lat: 52 + i / 1000,
  lng: 4.9,
}));

describe('thin', () => {
  it('keeps the ends and at most the limit', () => {
    const out = thin(route, 50);
    expect(out).toHaveLength(50);
    expect(out[0]).toBe(route[0]);
    expect(out.at(-1)).toBe(route.at(-1));
  });
  it('leaves a short route alone', () => {
    expect(thin(route.slice(0, 10), 50)).toHaveLength(10);
  });
});

describe('indexAt', () => {
  it('finds where the van is on the route', () => {
    expect(indexAt(route, route[120].ts + 1)).toBe(120);
    expect(indexAt(route, 0)).toBe(0);
  });
});

describe('trackingOf', () => {
  const position = {
    eta: NOW + 12 * 60_000,
    scenario_ts: route[200].ts,
    query_interval: 5000,
    scenario_in_progress: true,
  };
  const scenario = {
    scenario: route,
    driver: { name: 'Sam', photo_url: 'https://x/p.jpg' },
    vehicle: { image: 'AAAA' },
  };

  it('gives minutes away, the driver and the route, without the van image', () => {
    const t = trackingOf({ position, scenario, now: NOW });
    expect(t).toMatchObject({ minutes: 12, moving: true, driver: { name: 'Sam', photoUrl: 'https://x/p.jpg' } });
    expect(t.pollMs).toBe(15_000);
    expect(t.route.points.length).toBeLessThanOrEqual(150);
    expect(t.route.points[t.route.at][0]).toBeCloseTo(52.2, 1);
    expect(JSON.stringify(t)).not.toContain('AAAA');
  });

  it('is null without a position, and has no route without a scenario', () => {
    expect(trackingOf({ position: null, scenario, now: NOW })).toBeNull();
    expect(trackingOf({ position, scenario: null, now: NOW })).toMatchObject({
      driver: null,
      route: null,
      minutes: 12,
    });
  });
});
