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
// A session lasts about six months. In its last week it's renewed by signing
// in again where Picnic allows that without a code; where it doesn't,
// checkSession() says so, a week and a day before and once it has ended, for
// everyone to be told.
//
// The API is not supported by Picnic and can change without notice. Every
// failure comes back as a PicnicError with a code the client can act on,
// rather than as whatever the library happened to throw.

import crypto from 'node:crypto';
import PicnicClient from 'picnic-api';

export class PicnicError extends Error {
  constructor(code, message, { status = 502, details = null } = {}) {
    super(message);
    this.name = 'PicnicError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createPicnicTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS picnic_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    authKey TEXT, pendingAuthKey TEXT, updatedAt TEXT NOT NULL
  )`);
  // The last warning given about this session ending: week, day or ended.
  try {
    db.exec('ALTER TABLE picnic_session ADD COLUMN warned TEXT');
  } catch {
    // Already there.
  }
}

/** When a session ends, from the expiry in Picnic's key (a JWT); null if it can't be read. */
export function expiryOf(key) {
  try {
    const claims = JSON.parse(Buffer.from(String(key).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(claims?.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WARNINGS = ['week', 'day', 'ended'];

/** Which warning a session ending at `expiresAt` is due at `now`, if any. */
export function warningAt(expiresAt, now) {
  const left = expiresAt - now;
  if (left <= 0) return 'ended';
  if (left <= DAY_MS) return 'day';
  if (left <= 7 * DAY_MS) return 'week';
  return null;
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

export function createPicnic({ db, env = process.env, Client = PicnicClient, now = () => Date.now() }) {
  createPicnicTables(db);
  const username = env.PICNIC_USERNAME;
  const password = env.PICNIC_PASSWORD;
  const countryCode = (env.PICNIC_COUNTRY_CODE ?? 'NL').toUpperCase();
  const configured = Boolean(username && password);
  const box = configured ? cipher(password) : null;

  const row = () => db.prepare('SELECT * FROM picnic_session WHERE id = 1').get();
  // A new session starts with no warnings given.
  const store = ({ authKey = null, pendingAuthKey = null, warned = null }) =>
    db
      .prepare(
        `INSERT INTO picnic_session (id, authKey, pendingAuthKey, updatedAt, warned) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET authKey = excluded.authKey,
           pendingAuthKey = excluded.pendingAuthKey, updatedAt = excluded.updatedAt, warned = excluded.warned`,
      )
      .run(authKey && box.seal(authKey), pendingAuthKey && box.seal(pendingAuthKey), new Date().toISOString(), warned);

  // Told when a request finds the session has ended. Set with onSessionEnded().
  let onEnded = null;
  let lastRenewal = 0;

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

  /**
   * Signs in again without a code, where Picnic allows it. Never sends one:
   * nobody may be there to type it in. True when there's a new session.
   */
  async function renew() {
    if (!configured) return false;
    try {
      const login = await new Client({ countryCode }).auth.login(username, password);
      if (login.second_factor_authentication_required || !login.authKey) return false;
      store({ authKey: login.authKey, pendingAuthKey: pendingAuthKey() });
      return true;
    } catch {
      return false;
    }
  }

  /** The session has ended: drop it, remembering that's been said. */
  const ended = () => store({ pendingAuthKey: pendingAuthKey(), warned: 'ended' });

  /** Whether the session behind a refused call is really gone: one more, simple, request. */
  async function sessionGone(key) {
    try {
      await new Client({ countryCode, authKey: key }).user.getUserDetails();
      return false;
    } catch (error) {
      return isAuthFailure(error);
    }
  }

  /** Runs a call against Picnic, turning its failures into PicnicErrors. */
  async function call(fn, { retried = false } = {}) {
    const key = configured ? authKey() : null;
    try {
      return await fn(client());
    } catch (error) {
      if (error instanceof PicnicError) throw error;
      // Something in the cart stops checkout: the minimum order, an age check.
      // Some can be accepted and retried with the key Picnic sends.
      if (Client.isCheckoutIssueError?.(error)) {
        throw new PicnicError('checkout_issue', error.issueMessage || error.title || 'Picnic cannot check out this cart.', {
          status: 409,
          details: {
            title: error.title,
            message: error.issueMessage,
            blocking: error.blocking,
            resolveKey: error.resolveKey || null,
          },
        });
      }
      // A refusal can be about the request rather than the session (a 403
      // for one thing): it's only dropped once that's checked.
      if (isAuthFailure(error) && key && (await sessionGone(key))) {
        // Renewed meanwhile, or renewable now: try once more with that.
        if (!retried && (authKey() !== key || (await renew()))) return call(fn, { retried: true });
        if (authKey() === key) {
          ended();
          onEnded?.();
        }
        throw new PicnicError('session_expired', 'The Picnic session has expired. Connect again.', {
          status: 409,
        });
      }
      throw new PicnicError('picnic_failed', `Picnic: ${error?.message ?? 'request failed'}`);
    }
  }

  return {
    countryCode,

    onSessionEnded(fn) {
      onEnded = fn;
    },

    status() {
      const key = authKey();
      const expires = key ? expiryOf(key) : null;
      return {
        configured,
        connected: Boolean(key),
        awaitingCode: Boolean(pendingAuthKey()),
        countryCode,
        expiresAt: expires ? new Date(expires).toISOString() : null,
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
        // Signing in again before the session ends keeps it working meanwhile.
        store({ authKey: authKey(), pendingAuthKey: login.authKey, warned: row()?.warned ?? null });
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

    /**
     * Run every so often. Renews a session in its last week where that needs
     * no code, drops one that has ended, and returns the warning now due —
     * 'week', 'day' or 'ended' — once each, or null.
     */
    async checkSession() {
      const key = configured ? authKey() : null;
      if (!key) return null;
      const expires = expiryOf(key);
      if (!expires) return null;
      const due = warningAt(expires, now());
      if (!due) return null;
      if (now() - lastRenewal > 12 * 60 * 60 * 1000) {
        lastRenewal = now();
        if (await renew()) return null;
      }
      const warned = row()?.warned;
      if (due === 'ended') ended();
      if (WARNINGS.indexOf(due) <= WARNINGS.indexOf(warned)) return null;
      if (due !== 'ended') db.prepare('UPDATE picnic_session SET warned = ? WHERE id = 1').run(due);
      return { warning: due, expiresAt: new Date(expires).toISOString() };
    },

    async disconnect() {
      if (authKey())
        await client()
          .auth.logout()
          .catch(() => {});
      if (configured) store({});
      return this.status();
    },

    search: (query) => call((p) => p.catalog.search(query)),
    /** Picnic's search results page itself, which also carries each result's deal. */
    searchPage: (query) => call((p) => p.app.getPage(`search-page-results?search_term=${encodeURIComponent(query)}`)),
    product: (id) => call((p) => p.catalog.getProductDetails(id)),
    image: (id, size) => call((p) => p.catalog.getImage(id, size)),
    cart: () => call((p) => p.cart.getCart()),
    addToCart: (id, count) => call((p) => p.cart.addProductToCart(id, count)),
    removeFromCart: (id, count) => call((p) => p.cart.removeProductFromCart(id, count)),
    clearCart: () => call((p) => p.cart.clearCart()),
    addProducts: (items) => call((p) => p.cart.addProductsToCart(items)),

    slots: () => call((p) => p.cart.getDeliverySlotOverview()),
    setSlot: (slotId) => call((p) => p.cart.setDeliverySlot(slotId)),

    minimumOrder: () => call((p) => p.cart.getMinimumOrderValue()).catch(() => null),
    startCheckout: (input) => call((p) => p.cart.startCheckout(input)),
    initiatePayment: (orderId, returnUrl) => call((p) => p.cart.initiatePayment(orderId, returnUrl)),
    checkoutStatus: (transactionId) => call((p) => p.cart.getCheckoutStatus(transactionId)),
    cancelCheckout: (transactionId) => call((p) => p.cart.cancelCheckout(transactionId)),
    confirmOrder: (orderId) => call((p) => p.cart.confirmOrder(orderId)),

    wallet: (page) => call((p) => p.payment.getWalletTransactions(page)),
    walletTransaction: (id) => call((p) => p.payment.getWalletTransactionDetails(id)),

    deliveries: () => call((p) => p.delivery.getDeliverySummaries()),
    rateDelivery: (id, rating) => call((p) => p.delivery.setDeliveryRating(id, rating)),
    cancelDelivery: (id) => call((p) => p.delivery.cancelDelivery(id)),
    emailInvoice: (id) => call((p) => p.delivery.sendDeliveryInvoiceEmail(id)),
    delivery: (id) => call((p) => p.delivery.getDelivery(id)),
    /** Live position, or null: Picnic only answers while a delivery is on its way. */
    position: (id) => call((p) => p.delivery.getDeliveryPosition(id)).catch(() => null),
    /** The planned route and the driver, or null, likewise only while it's on its way. */
    scenario: (id) => call((p) => p.delivery.getDeliveryScenario(id)).catch(() => null),
  };
}
