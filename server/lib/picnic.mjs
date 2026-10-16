// Picnic, the grocery delivery service, through its unofficial app API.
//
// One Picnic account per installation, configured with PICNIC_USERNAME,
// PICNIC_PASSWORD and PICNIC_COUNTRY_CODE. Every Bend It! user on the
// installation shares it: one cart, one order history.
//
// The password stays in the environment. What is stored is the session Picnic
// issues after signing in — including the SMS code it asks for the first time —
// so a restart or a deploy doesn't need another code. It is encrypted with a
// key derived from the password, so a copy of the database alone doesn't carry
// a usable session.
//
// The API is not supported by Picnic and can change without notice. Every
// failure comes back as a PicnicError with a code the client can act on,
// rather than as whatever the library happened to throw.

import crypto from 'node:crypto';
import PicnicClient from 'picnic-api';

export class PicnicError extends Error {
  constructor(code, message, { status = 502 } = {}) {
    super(message);
    this.name = 'PicnicError';
    this.code = code;
    this.status = status;
  }
}

export function createPicnicTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS picnic_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    authKey TEXT, pendingAuthKey TEXT, updatedAt TEXT NOT NULL
  )`);
}

/** AES-256-GCM, keyed from the account password: iv.tag.ciphertext, base64url. */
function cipher(password) {
  const key = crypto.scryptSync(password, 'bendit-picnic-session', 32);
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
    },
    open(sealed) {
      try {
        const [iv, tag, body] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(body), d.final()]).toString('utf8');
      } catch {
        // Sealed under a different password: the session is no use any more.
        return null;
      }
    },
  };
}

/** The library throws plain Errors; an expired session is recognisable only by its text. */
const isAuthFailure = (error) => /\b40[13]\b|unauthori[sz]ed|AUTH_|invalid.*(token|key)/i.test(String(error?.message));

export function createPicnic({ db, env = process.env, Client = PicnicClient }) {
  createPicnicTables(db);
  const username = env.PICNIC_USERNAME;
  const password = env.PICNIC_PASSWORD;
  const countryCode = (env.PICNIC_COUNTRY_CODE ?? 'NL').toUpperCase();
  const configured = Boolean(username && password);
  const box = configured ? cipher(password) : null;

  const row = () => db.prepare('SELECT * FROM picnic_session WHERE id = 1').get();
  const store = ({ authKey = null, pendingAuthKey = null }) =>
    db
      .prepare(
        `INSERT INTO picnic_session (id, authKey, pendingAuthKey, updatedAt) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET authKey = excluded.authKey,
           pendingAuthKey = excluded.pendingAuthKey, updatedAt = excluded.updatedAt`,
      )
      .run(authKey && box.seal(authKey), pendingAuthKey && box.seal(pendingAuthKey), new Date().toISOString());

  const authKey = () => (configured && row()?.authKey ? box.open(row().authKey) : null);
  const pendingAuthKey = () => (configured && row()?.pendingAuthKey ? box.open(row().pendingAuthKey) : null);

  function requireConfigured() {
    if (!configured) {
      throw new PicnicError('not_configured', 'Picnic is not set up on this server.', { status: 409 });
    }
  }

  /** A signed-in client, or a not_connected error. */
  function client() {
    requireConfigured();
    const key = authKey();
    if (!key) throw new PicnicError('not_connected', 'Picnic is not connected.', { status: 409 });
    return new Client({ countryCode, authKey: key });
  }

  /** Runs a call against Picnic, turning its failures into PicnicErrors. */
  async function call(fn) {
    try {
      return await fn(client());
    } catch (error) {
      if (error instanceof PicnicError) throw error;
      if (isAuthFailure(error)) {
        store({});
        throw new PicnicError('session_expired', 'The Picnic session has expired. Connect again.', {
          status: 409,
        });
      }
      throw new PicnicError('picnic_failed', `Picnic: ${error?.message ?? 'request failed'}`);
    }
  }

  return {
    countryCode,

    status() {
      return {
        configured,
        connected: Boolean(authKey()),
        awaitingCode: !authKey() && Boolean(pendingAuthKey()),
        countryCode,
      };
    },

    /** Signs in. When Picnic asks for an SMS code, sends one and waits for verify(). */
    async connect() {
      requireConfigured();
      const picnic = new Client({ countryCode });
      let login;
      try {
        login = await picnic.auth.login(username, password);
      } catch (error) {
        throw new PicnicError('login_failed', `Picnic sign-in failed: ${error?.message ?? 'unknown error'}`);
      }
      if (login.second_factor_authentication_required) {
        await picnic.auth.generate2FACode('SMS');
        store({ pendingAuthKey: login.authKey });
        return this.status();
      }
      store({ authKey: login.authKey });
      return this.status();
    },

    async verify(code) {
      requireConfigured();
      const pending = pendingAuthKey();
      if (!pending) throw new PicnicError('no_pending_code', 'Request a code first.', { status: 409 });
      try {
        const verified = await new Client({ countryCode, authKey: pending }).auth.verify2FACode(
          String(code).trim(),
        );
        store({ authKey: verified.authKey });
      } catch (error) {
        throw new PicnicError('code_rejected', `Picnic didn't accept that code: ${error?.message ?? ''}`.trim(), {
          status: 400,
        });
      }
      return this.status();
    },

    async disconnect() {
      if (authKey()) await client().auth.logout().catch(() => {});
      if (configured) store({});
      return this.status();
    },

    search: (query) => call((p) => p.catalog.search(query)),
    product: (id) => call((p) => p.catalog.getProductDetails(id)),
    image: (id, size) => call((p) => p.catalog.getImage(id, size)),
    cart: () => call((p) => p.cart.getCart()),
    addToCart: (id, count) => call((p) => p.cart.addProductToCart(id, count)),
    removeFromCart: (id, count) => call((p) => p.cart.removeProductFromCart(id, count)),
    clearCart: () => call((p) => p.cart.clearCart()),
  };
}
