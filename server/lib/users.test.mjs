import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  authenticate,
  countUsers,
  createUser,
  createUsersTable,
  deleteUser,
  findUser,
  hashPassword,
  isValidUsername,
  listUsers,
  setPassword,
  USER_TABLES,
  verifyPassword,
} from './users.mjs';

let db;

beforeEach(() => {
  db = new Database(':memory:');
  createUsersTable(db);
  // Just enough of the rest of the schema to test that deleting a user takes
  // their data with it.
  for (const table of USER_TABLES) {
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, userId TEXT NOT NULL)`);
  }
  db.exec(`
    CREATE TABLE meal_template_items (id TEXT PRIMARY KEY, templateId TEXT NOT NULL);
    CREATE TABLE foods (id TEXT PRIMARY KEY, ownerId TEXT);
  `);
});

describe('passwords', () => {
  it('never stores the password itself', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(stored).not.toContain('correct horse');
    expect(stored.startsWith('scrypt$')).toBe(true);
  });

  it('salts, so the same password hashes differently for two people', () => {
    expect(hashPassword('same password')).not.toBe(hashPassword('same password'));
  });

  it('verifies the right password and refuses the wrong one', () => {
    const stored = hashPassword('a good password');
    expect(verifyPassword('a good password', stored)).toBe(true);
    expect(verifyPassword('a good passwore', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('refuses rather than throws on a hash it cannot read', () => {
    for (const junk of ['', null, 'plaintext', 'bcrypt$x$y$z', 'scrypt$broken']) {
      expect(verifyPassword('anything', junk)).toBe(false);
    }
  });
});

describe('usernames', () => {
  it('accepts ordinary names and rejects awkward ones', () => {
    for (const good of ['josh', 'jo', 'josh.pollara', 'user_1', 'a-b']) {
      expect(isValidUsername(good), good).toBe(true);
    }
    for (const bad of ['j', '', 'has space', 'josh@example.com', 'x'.repeat(33), '../etc']) {
      expect(isValidUsername(bad), bad).toBe(false);
    }
  });

  it('treats case as the same person', () => {
    createUser(db, 'Josh', 'a good password');
    expect(findUser(db, 'josh')).toBeTruthy();
    expect(findUser(db, 'JOSH')).toBeTruthy();
    expect(() => createUser(db, 'JOSH', 'another password')).toThrow(/already a user/);
  });
});

describe('createUser', () => {
  it('creates one and counts it', () => {
    expect(countUsers(db)).toBe(0);
    const user = createUser(db, 'josh', 'a good password');
    expect(user.username).toBe('josh');
    expect(countUsers(db)).toBe(1);
    expect(listUsers(db).map((u) => u.username)).toEqual(['josh']);
  });

  it('refuses a password short enough to guess', () => {
    expect(() => createUser(db, 'josh', 'short')).toThrow(/too short/);
    expect(countUsers(db)).toBe(0);
  });

  it('never returns the hash to a caller', () => {
    expect(JSON.stringify(createUser(db, 'josh', 'a good password'))).not.toMatch(/scrypt/);
  });
});

describe('authenticate', () => {
  beforeEach(() => createUser(db, 'josh', 'a good password'));

  it('lets the right person in', () => {
    expect(authenticate(db, 'josh', 'a good password')?.username).toBe('josh');
  });

  it('turns away a wrong password and an unknown user alike', () => {
    expect(authenticate(db, 'josh', 'not the password')).toBeNull();
    expect(authenticate(db, 'nobody', 'a good password')).toBeNull();
    expect(authenticate(db, '', '')).toBeNull();
  });

  it('takes the same work for an unknown user as for a wrong password', () => {
    // Otherwise the response time answers "does this person have an account?".
    const time = (fn) => {
      const started = process.hrtime.bigint();
      fn();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const wrongPassword = time(() => authenticate(db, 'josh', 'not the password'));
    const noSuchUser = time(() => authenticate(db, 'nobody', 'not the password'));
    // Both do a full scrypt; allow a wide margin for a noisy machine.
    expect(Math.min(wrongPassword, noSuchUser) * 4).toBeGreaterThan(Math.max(wrongPassword, noSuchUser));
  });
});

describe('setPassword', () => {
  it('changes it, and the old one stops working', () => {
    createUser(db, 'josh', 'a good password');
    setPassword(db, 'josh', 'a different password');
    expect(authenticate(db, 'josh', 'a different password')).toBeTruthy();
    expect(authenticate(db, 'josh', 'a good password')).toBeNull();
  });

  it('complains about a user who does not exist', () => {
    expect(() => setPassword(db, 'nobody', 'a good password')).toThrow(/no user called/);
  });
});

describe('deleteUser', () => {
  it('takes their data with them and leaves everyone else alone', () => {
    const josh = createUser(db, 'josh', 'a good password');
    const sam = createUser(db, 'sam', 'another password');

    for (const table of USER_TABLES) {
      db.prepare(`INSERT INTO ${table} (id, userId) VALUES (?, ?)`).run(`${table}-j`, josh.id);
      db.prepare(`INSERT INTO ${table} (id, userId) VALUES (?, ?)`).run(`${table}-s`, sam.id);
    }
    db.prepare('INSERT INTO meal_templates (id, userId) VALUES (?, ?)').run('tpl-j', josh.id);
    db.prepare('INSERT INTO meal_template_items (id, templateId) VALUES (?, ?)').run('item-j', 'tpl-j');
    db.prepare('INSERT INTO foods (id, ownerId) VALUES (?, ?)').run('own-j', josh.id);
    db.prepare('INSERT INTO foods (id, ownerId) VALUES (?, ?)').run('shared', null);

    const removed = deleteUser(db, 'josh');

    expect(countUsers(db)).toBe(1);
    expect(removed.meal_template_items).toBe(1);
    for (const table of USER_TABLES) {
      const left = db.prepare(`SELECT userId FROM ${table}`).all().map((r) => r.userId);
      expect(left, table).toEqual([sam.id]);
    }
    // Shared reference data survives; their own food doesn't.
    expect(db.prepare('SELECT id FROM foods').all().map((f) => f.id)).toEqual(['shared']);
  });

  it('complains about a user who does not exist', () => {
    expect(() => deleteUser(db, 'nobody')).toThrow(/no user called/);
  });
});
