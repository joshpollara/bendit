// Accounts.
//
// Passwords are hashed with scrypt from node's own crypto — deliberately slow,
// salted per user, and already in the standard library, so nothing is added to
// the dependency list for it. A stored hash is `scrypt$N$salt$key`, which
// carries its own parameters so the cost can be raised later without stranding
// the passwords hashed before the change.
//
// Usernames are compared lowercased. "Josh" and "josh" are the same person
// trying to log in, and a system that disagrees is only ever annoying.

import crypto from 'node:crypto';

const SCRYPT_COST = 16_384; // ~50ms per hash; the point is that it isn't fast
const KEY_LENGTH = 32;

export const normalizeUsername = (name) => String(name ?? '').trim().toLowerCase();

/** Letters, digits, dot, dash, underscore. Enough for a name, no room for tricks. */
export const isValidUsername = (name) => /^[a-z0-9._-]{2,32}$/.test(normalizeUsername(name));

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(String(password), salt, KEY_LENGTH, { N: SCRYPT_COST }).toString('hex');
  return `scrypt$${SCRYPT_COST}$${salt}$${key}`;
}

/** Constant-time, and false rather than throwing on a hash it can't read. */
export function verifyPassword(password, stored) {
  const [scheme, cost, salt, key] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const candidate = crypto.scryptSync(String(password), salt, KEY_LENGTH, { N: Number(cost) });
  const expected = Buffer.from(key, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function createUsersTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
  `);
}

export const countUsers = (db) => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

export const findUser = (db, username) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(username)) ?? null;

export const listUsers = (db) =>
  db.prepare('SELECT id, username, createdAt FROM users ORDER BY createdAt').all();

/** Throws on a bad name or a duplicate — both are things a person should be told. */
export function createUser(db, username, password) {
  const name = normalizeUsername(username);
  if (!isValidUsername(name)) {
    throw new Error(`"${username}" isn't a usable username (letters, digits, . _ - and 2–32 long).`);
  }
  if (String(password ?? '').length < 8) {
    throw new Error('That password is too short — use at least 8 characters.');
  }
  if (findUser(db, name)) throw new Error(`There is already a user called "${name}".`);

  const user = {
    id: crypto.randomUUID(),
    username: name,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    'INSERT INTO users (id, username, passwordHash, createdAt) VALUES (@id, @username, @passwordHash, @createdAt)',
  ).run(user);
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

export function setPassword(db, username, password) {
  if (String(password ?? '').length < 8) {
    throw new Error('That password is too short — use at least 8 characters.');
  }
  const user = findUser(db, username);
  if (!user) throw new Error(`There is no user called "${normalizeUsername(username)}".`);
  db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(hashPassword(password), user.id);
  return user.id;
}

/** The user, or null. Never says which half was wrong. */
export function authenticate(db, username, password) {
  const user = findUser(db, username);
  // Hash anyway when the user doesn't exist, so a missing username and a wrong
  // password take the same time to answer.
  const stored = user?.passwordHash ?? hashPassword('placeholder', 'placeholder-salt');
  const ok = verifyPassword(password, stored);
  return user && ok ? { id: user.id, username: user.username } : null;
}

/**
 * Everything belonging to one person. Used when deleting a user, and it is the
 * list every user-scoped query has to filter by — kept here so there is one
 * place to check against when a table is added.
 */
export const USER_TABLES = [
  'profile',
  'food_log',
  'exercise_log',
  'weights',
  'day_done',
  'photos',
  'meal_templates',
  'measurements',
  'push_subscriptions',
  'fasts',
];

/** Deletes a user and everything of theirs. Returns what was removed. */
export function deleteUser(db, username) {
  const user = findUser(db, username);
  if (!user) throw new Error(`There is no user called "${normalizeUsername(username)}".`);

  const removed = {};
  db.transaction(() => {
    // Template items hang off templates rather than off the user directly.
    removed.meal_template_items = db
      .prepare(
        'DELETE FROM meal_template_items WHERE templateId IN (SELECT id FROM meal_templates WHERE userId = ?)',
      )
      .run(user.id).changes;
    for (const table of USER_TABLES) {
      removed[table] = db.prepare(`DELETE FROM ${table} WHERE userId = ?`).run(user.id).changes;
    }
    // Their own foods go; the shared reference data and anything with a barcode
    // stays, because those are the app's data rather than theirs.
    removed.foods = db.prepare('DELETE FROM foods WHERE ownerId = ?').run(user.id).changes;
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  })();
  return removed;
}
