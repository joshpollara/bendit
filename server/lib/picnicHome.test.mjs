import { describe, expect, it } from 'vitest';
import { arrivingOf, picnicHome } from './picnicHome.mjs';

const NOW = Date.parse('2026-10-20T12:00:00Z');

describe('arrivingOf', () => {
  it('picks the soonest placed order still to come', () => {
    const arriving = arrivingOf(
      [
        { id: 'old', status: 'COMPLETED', windowStart: '2026-10-14T16:00:00Z', windowEnd: '2026-10-14T17:00:00Z' },
        { id: 'later', status: 'CURRENT', windowStart: '2026-10-24T16:00:00Z', windowEnd: '2026-10-24T17:00:00Z' },
        { id: 'soon', status: 'CURRENT', windowStart: '2026-10-21T16:00:00Z', windowEnd: '2026-10-21T17:00:00Z' },
      ],
      NOW,
    );
    expect(arriving?.id).toBe('soon');
  });

  it('leaves out an order whose window has passed', () => {
    expect(
      arrivingOf(
        [{ id: 'x', status: 'CURRENT', windowStart: '2026-10-19T16:00:00Z', windowEnd: '2026-10-19T17:00:00Z' }],
        NOW,
      ),
    ).toBeNull();
  });

  it('is null with nothing placed', () => {
    expect(arrivingOf([], NOW)).toBeNull();
    expect(arrivingOf(undefined, NOW)).toBeNull();
  });
});

describe('picnicHome', () => {
  const base = {
    next: async () => ({ cutOffTime: '2026-10-20T20:00:00Z', windowStart: '2026-10-21T16:00:00Z', ordered: false }),
    deliveries: async () => [],
    usualsDue: 4,
    dealCount: async () => 2,
    planCount: 7,
    now: NOW,
  };

  it('puts it all together', async () => {
    expect(await picnicHome(base)).toEqual({
      next: { cutOffTime: '2026-10-20T20:00:00Z', windowStart: '2026-10-21T16:00:00Z', ordered: false },
      arriving: null,
      usualsDue: 4,
      deals: 2,
      plan: 7,
    });
  });

  it("leaves deals out when they're slow, rather than waiting", async () => {
    const home = await picnicHome({
      ...base,
      dealCount: () => new Promise((resolve) => setTimeout(() => resolve(5), 200)),
      dealWaitMs: 20,
    });
    expect(home.deals).toBeNull();
    expect(home.usualsDue).toBe(4);
  });

  it('carries on when Picnic lookups fail', async () => {
    const fail = async () => {
      throw new Error('down');
    };
    const home = await picnicHome({ ...base, next: fail, deliveries: fail, dealCount: fail });
    expect(home).toMatchObject({ next: null, arriving: null, deals: null, usualsDue: 4, plan: 7 });
  });
});
