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
          if (behaviour.searchError) throw new Error(behaviour.searchError);
          return [{ id: 's1', name: q }];
        },
      };
      this.cart = { getCart: async () => ({ items: [] }) };
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

  it('drops an expired session and says so', async () => {
    const { picnic } = setup({ searchError: '401 Unauthorized' });
    await picnic.connect();
    await expect(picnic.search('melk')).rejects.toMatchObject({ code: 'session_expired' });
    expect(picnic.status()).toMatchObject({ connected: false });
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
