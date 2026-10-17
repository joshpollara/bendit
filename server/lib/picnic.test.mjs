import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createPicnic, PicnicError } from './picnic.mjs';

const ENV = { PICNIC_USERNAME: 'me@example.com', PICNIC_PASSWORD: 'secret', PICNIC_COUNTRY_CODE: 'nl' };

/** A stand-in for picnic-api: records what it was asked, answers from `behaviour`. */
function fakeClient(behaviour = {}) {
  const calls = [];
  class Client {
    constructor(options) {
      this.options = options;
      calls.push(['new', options]);
      this.auth = {
        login: async (user, pass) => {
          calls.push(['login', user, pass]);
          const logins = calls.filter((c) => c[0] === 'login').length;
          if (logins > 1 && behaviour.relogin) return behaviour.relogin;
          return behaviour.login ?? { authKey: 'full-key', second_factor_authentication_required: false };
        },
        generate2FACode: async (channel) => calls.push(['generate2FACode', channel]),
        verify2FACode: async (code) => {
          calls.push(['verify2FACode', code, this.options.authKey]);
          if (behaviour.rejectCode) throw new Error('OTP_INVALID');
          return { authKey: 'verified-key' };
        },
        logout: async () => calls.push(['logout']),
      };
      this.catalog = {
        search: async (q) => {
          calls.push(['search', q, this.options.authKey]);
          if (behaviour.searchError && (!behaviour.failingKey || behaviour.failingKey === this.options.authKey)) {
            throw new Error(behaviour.searchError);
          }
          return [{ id: 's1', name: q }];
        },
      };
      this.cart = { getCart: async () => ({ items: [] }) };
      this.user = {
        getUserDetails: async () => {
          calls.push(['getUserDetails', this.options.authKey]);
          if (behaviour.userError) throw new Error(behaviour.userError);
          return { user_id: 'u1' };
        },
      };
    }
  }
  return { Client, calls };
}

const setup = (behaviour, env = ENV) => {
  const db = new Database(':memory:');
  const fake = fakeClient(behaviour);
  return { db, ...fake, picnic: createPicnic({ db, env, Client: fake.Client }) };
};

describe('picnic', () => {
  it('says when the server has no account configured', async () => {
    const { picnic } = setup({}, {});
    expect(picnic.status()).toMatchObject({ configured: false, connected: false });
    await expect(picnic.search('melk')).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('is not connected until signed in', async () => {
    const { picnic } = setup();
    expect(picnic.status()).toMatchObject({ configured: true, connected: false, countryCode: 'NL' });
    await expect(picnic.search('melk')).rejects.toBeInstanceOf(PicnicError);
  });

  it('signs in without a code when Picnic does not ask for one', async () => {
    const { picnic, calls } = setup();
    expect(await picnic.connect()).toMatchObject({ connected: true, awaitingCode: false });
    expect(calls).toContainEqual(['login', 'me@example.com', 'secret']);
    await picnic.search('melk');
    expect(calls).toContainEqual(['search', 'melk', 'full-key']);
  });

  it('sends an SMS code, then signs in with it', async () => {
    const { picnic, calls } = setup({
      login: { authKey: 'pending-key', second_factor_authentication_required: true },
    });
    expect(await picnic.connect()).toMatchObject({ connected: false, awaitingCode: true });
    expect(calls).toContainEqual(['generate2FACode', 'SMS']);

    expect(await picnic.verify(' 123456 ')).toMatchObject({ connected: true, awaitingCode: false });
    expect(calls).toContainEqual(['verify2FACode', '123456', 'pending-key']);
    await picnic.search('kip');
    expect(calls).toContainEqual(['search', 'kip', 'verified-key']);
  });

  it('keeps waiting for a code Picnic rejected', async () => {
    const { picnic } = setup({
      login: { authKey: 'pending-key', second_factor_authentication_required: true },
      rejectCode: true,
    });
    await picnic.connect();
    await expect(picnic.verify('000000')).rejects.toMatchObject({ code: 'code_rejected', status: 400 });
    expect(picnic.status()).toMatchObject({ connected: false, awaitingCode: true });
  });

  it('stores the session encrypted, not as Picnic issued it', async () => {
    const { picnic, db } = setup();
    await picnic.connect();
    const stored = db.prepare('SELECT authKey FROM picnic_session').get().authKey;
    expect(stored).not.toContain('full-key');
  });

  it('treats a session sealed under another password as no session', async () => {
    const { picnic, db, Client } = setup();
    await picnic.connect();
    const changed = createPicnic({ db, env: { ...ENV, PICNIC_PASSWORD: 'new' }, Client });
    expect(changed.status()).toMatchObject({ connected: false });
  });

  it("drops an expired session and says so, when it can't be renewed without a code", async () => {
    const { picnic } = setup({
      searchError: '401 Unauthorized',
      userError: '401 Unauthorized',
      relogin: { authKey: 'pending', second_factor_authentication_required: true },
    });
    let told = 0;
    picnic.onSessionEnded(() => told++);
    await picnic.connect();
    await expect(picnic.search('melk')).rejects.toMatchObject({ code: 'session_expired' });
    expect(picnic.status()).toMatchObject({ connected: false, awaitingCode: false });
    expect(told).toBe(1);
  });

  it('keeps the session when only the request was refused', async () => {
    const { picnic } = setup({ searchError: '403 Forbidden' });
    await picnic.connect();
    await expect(picnic.search('melk')).rejects.toMatchObject({ code: 'picnic_failed' });
    expect(picnic.status()).toMatchObject({ connected: true });
  });

  it('signs in again without a code where Picnic allows, and carries on', async () => {
    const { picnic, calls } = setup({
      searchError: '401 Unauthorized',
      failingKey: 'full-key',
      userError: '401 Unauthorized',
      relogin: { authKey: 'renewed-key', second_factor_authentication_required: false },
    });
    await picnic.connect();
    expect(await picnic.search('melk')).toEqual([{ id: 's1', name: 'melk' }]);
    expect(calls).toContainEqual(['search', 'melk', 'renewed-key']);
    expect(calls.filter((c) => c[0] === 'generate2FACode')).toHaveLength(0);
  });

  it('reports any other failure without dropping the session', async () => {
    const { picnic } = setup({ searchError: '503 Service Unavailable' });
    await picnic.connect();
    await expect(picnic.search('melk')).rejects.toMatchObject({ code: 'picnic_failed' });
    expect(picnic.status()).toMatchObject({ connected: true });
  });

  it('passes on a checkout issue with what is needed to accept it', async () => {
    const db = new Database(':memory:');
    const { Client } = fakeClient();
    class WithCheckout extends Client {
      static isCheckoutIssueError = (e) => e?.kind === 'issue';
      constructor(options) {
        super(options);
        this.cart = {
          startCheckout: async () => {
            throw Object.assign(new Error('CART_HAS_ISSUES'), {
              kind: 'issue',
              title: 'Leeftijdscontrole',
              issueMessage: 'Dit product bevat alcohol.',
              blocking: false,
              resolveKey: 'AGE_OK',
            });
          },
        };
      }
    }
    const picnic = createPicnic({ db, env: ENV, Client: WithCheckout });
    await picnic.connect();
    await expect(picnic.startCheckout({ mts: 1 })).rejects.toMatchObject({
      code: 'checkout_issue',
      status: 409,
      details: { title: 'Leeftijdscontrole', blocking: false, resolveKey: 'AGE_OK' },
    });
  });

  it('signs out', async () => {
    const { picnic, calls } = setup();
    await picnic.connect();
    expect(await picnic.disconnect()).toMatchObject({ connected: false });
    expect(calls).toContainEqual(['logout']);
  });
});

const jwt = (expMs) =>
  ['h', Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url'), 's'].join('.');
const DAY = 24 * 60 * 60 * 1000;

describe('picnic session ending', () => {
  const START = Date.parse('2026-10-17T12:00:00Z');
  const make = (behaviour) => {
    const db = new Database(':memory:');
    const fake = fakeClient(behaviour);
    let clock = START;
    const picnic = createPicnic({ db, env: ENV, Client: fake.Client, now: () => clock });
    return { picnic, calls: fake.calls, at: (t) => (clock = t) };
  };
  const needsCode = { authKey: 'pending', second_factor_authentication_required: true };

  it('says when the session ends', async () => {
    const { picnic } = make({
      login: { authKey: jwt(START + 180 * DAY), second_factor_authentication_required: false },
    });
    await picnic.connect();
    expect(picnic.status().expiresAt).toBe(new Date(Math.floor((START + 180 * DAY) / 1000) * 1000).toISOString());
  });

  it('warns a week before, a day before and once it has ended, once each', async () => {
    const exp = START + 30 * DAY;
    const { picnic, at } = make({
      login: { authKey: jwt(exp), second_factor_authentication_required: false },
      relogin: needsCode,
    });
    await picnic.connect();
    expect(await picnic.checkSession()).toBeNull();
    at(exp - 6 * DAY);
    expect(await picnic.checkSession()).toMatchObject({ warning: 'week' });
    expect(await picnic.checkSession()).toBeNull();
    at(exp - 12 * 60 * 60 * 1000);
    expect(await picnic.checkSession()).toMatchObject({ warning: 'day' });
    expect(await picnic.checkSession()).toBeNull();
    at(exp + 60_000);
    expect(await picnic.checkSession()).toMatchObject({ warning: 'ended' });
    expect(picnic.status().connected).toBe(false);
    expect(await picnic.checkSession()).toBeNull();
  });

  it('renews in the last week where no code is needed, without warning', async () => {
    const exp = START + 30 * DAY;
    const { picnic, at, calls } = make({
      login: { authKey: jwt(exp), second_factor_authentication_required: false },
      relogin: { authKey: jwt(exp + 180 * DAY), second_factor_authentication_required: false },
    });
    await picnic.connect();
    at(exp - 5 * DAY);
    expect(await picnic.checkSession()).toBeNull();
    expect(Date.parse(picnic.status().expiresAt)).toBeGreaterThan(exp + 100 * DAY);
    expect(calls.filter((c) => c[0] === 'generate2FACode')).toHaveLength(0);
  });

  it('keeps the old session working while a new code is awaited', async () => {
    const { picnic } = make({
      login: { authKey: jwt(START + 3 * DAY), second_factor_authentication_required: false },
      relogin: needsCode,
    });
    await picnic.connect();
    expect(await picnic.connect()).toMatchObject({ connected: true, awaitingCode: true });
    await picnic.search('melk');
    expect(await picnic.verify('123456')).toMatchObject({ connected: true, awaitingCode: false });
  });
});
