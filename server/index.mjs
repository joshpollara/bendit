import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import compression from 'compression';
import { barcodeVariants } from './lib/barcode.mjs';
import { per100FromServing } from './lib/foodSchema.mjs';
import { matchFood, searchFoods } from './lib/foodSearch.mjs';
import webpush from 'web-push';
import Database from 'better-sqlite3';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SQLITE_PATH ?? path.join(__dirname, 'dev.db');
const PORT = Number(process.env.PORT ?? 8080);
const PROFILE_ID = 'me';

// ——— database ———

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS profile (
  id TEXT PRIMARY KEY, sex TEXT NOT NULL, birthDate TEXT NOT NULL,
  heightCm REAL NOT NULL, startWeightKg REAL NOT NULL, goalWeightKg REAL NOT NULL,
  activityLevel TEXT NOT NULL, weeklyRateKg REAL NOT NULL, units TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS foods (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, barcode TEXT,
  servingLabel TEXT NOT NULL, servingGrams REAL, caloriesPerServing REAL NOT NULL,
  protein REAL, carbs REAL, fat REAL, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_foods_barcode ON foods(barcode);
-- foodId is null for quick-add entries (calories typed straight into a meal);
-- label names those, and preserves the name of a food that is later deleted.
CREATE TABLE IF NOT EXISTS food_log (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, meal TEXT NOT NULL, foodId TEXT,
  servings REAL NOT NULL, caloriesCached REAL NOT NULL, label TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_date ON food_log(date);
CREATE TABLE IF NOT EXISTS exercise_log (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, name TEXT NOT NULL,
  minutes REAL NOT NULL, caloriesBurned REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ex_date ON exercise_log(date);
CREATE TABLE IF NOT EXISTS weights (
  id TEXT PRIMARY KEY, date TEXT NOT NULL UNIQUE, weightKg REAL NOT NULL
);
-- One row per day the user declared logging finished. Purely a marker.
CREATE TABLE IF NOT EXISTS day_done (
  date TEXT PRIMARY KEY, completedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_date ON photos(date);
-- A saved meal: a named bundle of items logged together in one tap.
CREATE TABLE IF NOT EXISTS meal_templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL
);
-- Items mirror food_log: a food reference, or a label-only calorie amount.
CREATE TABLE IF NOT EXISTS meal_template_items (
  id TEXT PRIMARY KEY, templateId TEXT NOT NULL, foodId TEXT, servings REAL NOT NULL,
  caloriesCached REAL NOT NULL, label TEXT, position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tpl_items ON meal_template_items(templateId);
CREATE TABLE IF NOT EXISTS measurements (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, site TEXT NOT NULL, valueCm REAL NOT NULL,
  UNIQUE(date, site)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, createdAt TEXT NOT NULL
);
`);

// Columns added after the first release. SQLite only supports ADD COLUMN, which
// is all these need — every one is nullable or defaulted.
function ensureColumns(table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

// ——— canonical nutrition schema ———
//
// The original foods table stored one serving and its calories, which is what
// the app logs against. Everything downstream of a photo needs the opposite:
// nutrition per 100g, so an estimated portion in grams can be turned into
// numbers. Both now live on the row — per-100g is the canonical form, the
// per-serving fields stay as the logging surface and are derived from it.
ensureColumns('foods', {
  // Where the number came from, so any figure can be traced back.
  sourceId: 'TEXT',
  // 'g' for solids, 'ml' for liquids — per-100 values are per 100 of this.
  basis: "TEXT NOT NULL DEFAULT 'g'",
  kcal100: 'REAL',
  protein100: 'REAL',
  carbs100: 'REAL',
  fat100: 'REAL',
  fiber100: 'REAL',
  sugar100: 'REAL',
  satFat100: 'REAL',
  sodiumMg100: 'REAL',
  updatedAt: 'TEXT',
});

db.exec(`
-- A food can have several ways of being eaten: "1 medium (182g)", "1 cup",
-- "100 g". The photo path estimates grams; people think in the others.
CREATE TABLE IF NOT EXISTS food_servings (
  id TEXT PRIMARY KEY, foodId TEXT NOT NULL, label TEXT NOT NULL,
  grams REAL NOT NULL, isDefault INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_servings_food ON food_servings(foodId);
CREATE INDEX IF NOT EXISTS idx_foods_source ON foods(source, sourceId);

-- Search index over the foods table. External-content FTS5: the index holds no
-- copy of the data, just the terms, so it stays small on a 1GB volume.
-- Porter stemming, not plain unicode61: the index would otherwise store
-- "beans" while a query for "black beans" normalises to "bean", matching only
-- rows containing the literal singular — which is how "black beans" found
-- "black bean soup" instead of "Beans, black, cooked".
CREATE VIRTUAL TABLE IF NOT EXISTS foods_fts USING fts5(
  name, brand, content='foods', content_rowid='rowid', tokenize='porter unicode61'
);
`);

// Whether the index has been populated can't be read from the index itself:
// on an external-content table COUNT(*) counts the *content* table, so it
// reports "full" while the index is empty — and the update trigger then tries
// to delete terms that were never written, which SQLite reports as a malformed
// image. A marker row records the build instead.
db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const FTS_VERSION = '2'; // bumped when the tokenizer changed
const ftsBuilt = db.prepare("SELECT value FROM schema_meta WHERE key = 'foods_fts'").get()?.value;
if (ftsBuilt !== FTS_VERSION) {
  db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')");
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('foods_fts', ?)").run(FTS_VERSION);
}

// Triggers go on after the rebuild, so nothing fires against a half-built index.
db.exec(`
CREATE TRIGGER IF NOT EXISTS foods_fts_insert AFTER INSERT ON foods BEGIN
  INSERT INTO foods_fts(rowid, name, brand) VALUES (new.rowid, new.name, new.brand);
END;
CREATE TRIGGER IF NOT EXISTS foods_fts_delete AFTER DELETE ON foods BEGIN
  INSERT INTO foods_fts(foods_fts, rowid, name, brand) VALUES('delete', old.rowid, old.name, old.brand);
END;
CREATE TRIGGER IF NOT EXISTS foods_fts_update AFTER UPDATE ON foods BEGIN
  INSERT INTO foods_fts(foods_fts, rowid, name, brand) VALUES('delete', old.rowid, old.name, old.brand);
  INSERT INTO foods_fts(rowid, name, brand) VALUES (new.rowid, new.name, new.brand);
END;
`);

// Existing rows predate the canonical schema. Where a serving weight is known,
// per-100g follows by division; where it isn't, the row stays per-serving only
// and is excluded from gram-based estimation rather than guessed at.
const needsBackfill = db
  .prepare('SELECT * FROM foods WHERE kcal100 IS NULL AND servingGrams > 0')
  .all();
if (needsBackfill.length > 0) {
  const update = db.prepare(
    `UPDATE foods SET kcal100 = @kcal100, protein100 = @protein100, carbs100 = @carbs100,
     fat100 = @fat100, sourceId = COALESCE(sourceId, @sourceId), updatedAt = @updatedAt WHERE id = @id`,
  );
  db.transaction(() => {
    for (const row of needsBackfill) {
      const per100 = per100FromServing(row);
      if (!per100) continue;
      update.run({
        ...per100,
        id: row.id,
        sourceId: row.barcode ?? null,
        updatedAt: new Date().toISOString(),
      });
    }
  })();
  console.log(`Backfilled per-100g nutrition for ${needsBackfill.length} foods`);
}

ensureColumns('profile', {
  proteinTargetG: 'REAL',
  // 'formula' (Mifflin-St Jeor) or 'measured' (from logged intake vs weight trend)
  budgetSource: "TEXT NOT NULL DEFAULT 'formula'",
  measuredTdee: 'REAL',
  reminderHour: 'INTEGER',
  timezone: 'TEXT',
});

// Progress photos live next to the database — on Fly that's the persistent
// volume, so they survive deploys like everything else.
const PHOTOS_DIR = process.env.PHOTOS_PATH ?? path.join(path.dirname(DB_PATH), 'photos');
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// Migration: older databases have food_log without `label` and with a NOT NULL
// foodId. SQLite can't relax NOT NULL in place, so rebuild the table once.
const logColumns = db.prepare('PRAGMA table_info(food_log)').all().map((c) => c.name);
if (!logColumns.includes('label')) {
  db.exec(`
    BEGIN;
    ALTER TABLE food_log RENAME TO food_log_old;
    CREATE TABLE food_log (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, meal TEXT NOT NULL, foodId TEXT,
      servings REAL NOT NULL, caloriesCached REAL NOT NULL, label TEXT
    );
    INSERT INTO food_log (id, date, meal, foodId, servings, caloriesCached)
      SELECT id, date, meal, foodId, servings, caloriesCached FROM food_log_old;
    DROP TABLE food_log_old;
    CREATE INDEX IF NOT EXISTS idx_log_date ON food_log(date);
    COMMIT;
  `);
  console.log('Migrated food_log for quick-add entries');
}

const seedCount = db.prepare("SELECT COUNT(*) AS c FROM foods WHERE source = 'seed'").get().c;
if (seedCount === 0) {
  const seeds = JSON.parse(fs.readFileSync(path.join(__dirname, 'seedFoods.json'), 'utf8'));
  const ins = db.prepare(`INSERT OR REPLACE INTO foods
    (id, name, brand, barcode, servingLabel, servingGrams, caloriesPerServing, protein, carbs, fat, source)
    VALUES (@id, @name, @brand, @barcode, @servingLabel, @servingGrams, @caloriesPerServing, @protein, @carbs, @fat, @source)`);
  db.transaction(() => {
    for (const f of seeds) {
      ins.run({ brand: null, barcode: null, servingGrams: null, protein: null, carbs: null, fat: null, ...f });
    }
  })();
  console.log(`Seeded ${seeds.length} foods`);
}

// ——— app & auth ———

const app = express();
// The OCR runtime (wasm ~13MB) and its models (~6MB) compress well and are
// too big to send raw to a phone. Compress .ort model files too — the default
// filter skips application/octet-stream.
app.use(
  compression({
    filter: (req, res) => req.path.endsWith('.ort') || compression.filter(req, res),
  }),
);
app.use(express.json());

const AUTH_PASS = process.env.BASIC_AUTH_PASSWORD;

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// A session is a signed expiry, nothing more — there's one user, so there's no
// session state worth storing. The signing key is derived from the password, so
// changing the password signs every device out, which is the behaviour you want.
const SESSION_COOKIE = 'bendit_session';
const SESSION_DAYS = 365;
const sessionKey = sha(`bendit-session:${AUTH_PASS ?? ''}`);

const signature = (expiry) =>
  crypto.createHmac('sha256', sessionKey).update(String(expiry)).digest('base64url');

function issueSession(res, secure) {
  const expiry = Date.now() + SESSION_DAYS * 86_400_000;
  res.setHeader(
    'Set-Cookie',
    [
      `${SESSION_COOKIE}=${expiry}.${signature(expiry)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${SESSION_DAYS * 86_400}`,
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; '),
  );
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function hasValidSession(req) {
  if (!AUTH_PASS) return false;
  const value = readCookie(req, SESSION_COOKIE);
  if (!value) return false;
  const [rawExpiry, mac] = value.split('.');
  const expiry = Number(rawExpiry);
  if (!Number.isFinite(expiry) || expiry < Date.now() || !mac) return false;
  const expected = signature(expiry);
  return (
    mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
  );
}

function passwordMatches(password) {
  return typeof password === 'string' && !!AUTH_PASS && safeEqual(password, AUTH_PASS);
}

/**
 * For scripts: `Authorization: Bearer <password>`.
 *
 * Deliberately not HTTP Basic. Browsers cache Basic credentials for an origin
 * and re-send them on every request, which silently un-did signing out — the
 * cookie was cleared and the cached header immediately signed you back in.
 * Nothing makes a browser send a Bearer header on its own.
 */
function hasValidBearer(req) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  return scheme === 'Bearer' && passwordMatches(token);
}

// One password, so brute force is the only attack worth blunting.
const loginAttempts = [];
function tooManyAttempts() {
  const cutoff = Date.now() - 60_000;
  while (loginAttempts.length && loginAttempts[0] < cutoff) loginAttempts.shift();
  return loginAttempts.length >= 10;
}

const isSecure = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

app.get('/api/session', (req, res) => {
  res.json({ authed: hasValidSession(req) || hasValidBearer(req), configured: !!AUTH_PASS });
});

app.post('/api/login', (req, res) => {
  if (!AUTH_PASS) return res.status(503).json({ error: 'No password is configured on the server.' });
  if (tooManyAttempts()) {
    return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  }
  if (!passwordMatches(req.body?.password)) {
    loginAttempts.push(Date.now()); // only failures count toward the limit
    return res.status(401).json({ error: "That password doesn't match." });
  }
  loginAttempts.length = 0; // a correct password clears the slate
  issueSession(res, isSecure(req));
  res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

// Only the API is guarded. The app shell and its assets are public — they hold
// no data, and the login screen has to load before anyone can sign in. Every
// byte of personal data goes through /api.
//
// Deliberately no WWW-Authenticate header on failure: that header is what makes
// the browser throw its own login box up on every cold start of the app.
app.use('/api', (req, res, next) => {
  if (hasValidSession(req) || hasValidBearer(req)) return next();
  res.status(401).json({ error: 'Not signed in.' });
});

// ——— helpers ———

const newId = () => crypto.randomUUID();

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Only the fields a client is allowed to change, and only those it sent. */
function pick(body, keys) {
  const out = {};
  for (const key of keys) if (body?.[key] !== undefined) out[key] = body[key];
  return out;
}

const foodColumns =
  'f.id AS f_id, f.name AS f_name, f.brand AS f_brand, f.barcode AS f_barcode, ' +
  'f.servingLabel AS f_servingLabel, f.servingGrams AS f_servingGrams, ' +
  'f.caloriesPerServing AS f_caloriesPerServing, f.protein AS f_protein, ' +
  'f.carbs AS f_carbs, f.fat AS f_fat, f.source AS f_source';

function rowFood(row) {
  if (!row.f_id) return undefined;
  return {
    id: row.f_id,
    name: row.f_name,
    brand: row.f_brand ?? undefined,
    barcode: row.f_barcode ?? undefined,
    servingLabel: row.f_servingLabel,
    servingGrams: row.f_servingGrams ?? undefined,
    caloriesPerServing: row.f_caloriesPerServing,
    protein: row.f_protein ?? undefined,
    carbs: row.f_carbs ?? undefined,
    fat: row.f_fat ?? undefined,
    source: row.f_source,
  };
}

const upsertFood = db.prepare(`INSERT OR REPLACE INTO foods
  (id, name, brand, barcode, servingLabel, servingGrams, caloriesPerServing, protein, carbs, fat, source)
  VALUES (@id, @name, @brand, @barcode, @servingLabel, @servingGrams, @caloriesPerServing, @protein, @carbs, @fat, @source)`);

function saveFood(f) {
  upsertFood.run({
    brand: null,
    barcode: null,
    servingGrams: null,
    protein: null,
    carbs: null,
    fat: null,
    ...f,
  });
}

// ——— API ———

app.get('/api/profile', (_req, res) => {
  res.json(db.prepare('SELECT * FROM profile WHERE id = ?').get(PROFILE_ID) ?? null);
});

app.put('/api/profile', (req, res) => {
  const p = {
    proteinTargetG: null,
    budgetSource: 'formula',
    measuredTdee: null,
    reminderHour: null,
    timezone: null,
    ...req.body,
    id: PROFILE_ID,
  };
  db.prepare(`INSERT OR REPLACE INTO profile
    (id, sex, birthDate, heightCm, startWeightKg, goalWeightKg, activityLevel, weeklyRateKg, units, createdAt,
     proteinTargetG, budgetSource, measuredTdee, reminderHour, timezone)
    VALUES (@id, @sex, @birthDate, @heightCm, @startWeightKg, @goalWeightKg, @activityLevel, @weeklyRateKg, @units, @createdAt,
     @proteinTargetG, @budgetSource, @measuredTdee, @reminderHour, @timezone)`).run(p);
  res.json(p);
});

app.get('/api/day', (req, res) => {
  const { date, yesterday } = req.query;
  const entries = db
    .prepare(`SELECT l.*, ${foodColumns} FROM food_log l LEFT JOIN foods f ON f.id = l.foodId WHERE l.date = ?`)
    .all(date)
    .map((row) => ({
      id: row.id,
      date: row.date,
      meal: row.meal,
      foodId: row.foodId,
      servings: row.servings,
      caloriesCached: row.caloriesCached,
      label: row.label ?? undefined,
      food: rowFood(row),
    }));
  const exercises = db.prepare('SELECT * FROM exercise_log WHERE date = ?').all(date);
  const latest = db.prepare('SELECT weightKg FROM weights ORDER BY date DESC LIMIT 1').get();
  const yesterdayMealCounts = {};
  if (yesterday) {
    for (const row of db
      .prepare('SELECT meal, COUNT(*) AS c FROM food_log WHERE date = ? GROUP BY meal')
      .all(yesterday)) {
      yesterdayMealCounts[row.meal] = row.c;
    }
  }
  const done = db.prepare('SELECT 1 FROM day_done WHERE date = ?').get(date) != null;
  res.json({ entries, exercises, latestWeightKg: latest?.weightKg, yesterdayMealCounts, done });
});

// Browsing the whole database: every food, newest sources first, with how many
// log entries reference each one so deletes are an informed choice.
// The Monday-to-Sunday week containing `date`, for the week-so-far line.
app.get('/api/week', (req, res) => {
  const { date } = req.query;
  if (!isDate(date)) return res.status(400).json({ error: 'bad date' });
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const from = monday.toISOString().slice(0, 10);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const to = sunday.toISOString().slice(0, 10);

  const days = new Map();
  const day = (d) => {
    if (!days.has(d)) days.set(d, { date: d, food: 0, exercise: 0, entries: 0 });
    return days.get(d);
  };
  for (const row of db
    .prepare(`SELECT date, SUM(caloriesCached) AS food, COUNT(*) AS n FROM food_log
              WHERE date BETWEEN ? AND ? GROUP BY date`)
    .all(from, to)) {
    const d = day(row.date);
    d.food = row.food;
    d.entries = row.n;
  }
  for (const row of db
    .prepare(`SELECT date, SUM(caloriesBurned) AS burned FROM exercise_log
              WHERE date BETWEEN ? AND ? GROUP BY date`)
    .all(from, to)) {
    day(row.date).exercise = row.burned;
  }
  res.json({ from, to, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) });
});

app.get('/api/foods/browse', (req, res) => {
  const { q, source } = req.query;
  const where = [];
  const params = [];
  if (q) {
    where.push('(f.name LIKE ? OR f.brand LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (source) {
    where.push('f.source = ?');
    params.push(source);
  }
  res.json(
    db
      .prepare(
        `SELECT f.*, (SELECT COUNT(*) FROM food_log l WHERE l.foodId = f.id) AS usageCount
         FROM foods f
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         -- Your own foods first, then the curated ones, and the 300,000
         -- crowd-sourced products last: unfiltered, they would be the entire
         -- list and nothing you recognise would appear in it.
         ORDER BY CASE f.source
                    WHEN 'custom' THEN 0 WHEN 'seed' THEN 1 WHEN 'usda' THEN 2 ELSE 3 END,
                  f.name COLLATE NOCASE
         LIMIT 500`,
      )
      .all(...params),
  );
});

app.get('/api/foods/counts', (_req, res) => {
  const counts = { custom: 0, openfoodfacts: 0, seed: 0 };
  for (const row of db.prepare('SELECT source, COUNT(*) AS c FROM foods GROUP BY source').all()) {
    counts[row.source] = row.c;
  }
  res.json(counts);
});

// Everything the reports screen needs for a date range, in one round trip.
// Only days with data come back; the client fills the gaps.
app.get('/api/report', (req, res) => {
  const bounds = db
    .prepare(
      `SELECT MIN(d) AS first, MAX(d) AS last FROM (
         SELECT MIN(date) AS d FROM food_log UNION ALL SELECT MAX(date) FROM food_log
         UNION ALL SELECT MIN(date) FROM exercise_log UNION ALL SELECT MAX(date) FROM exercise_log
         UNION ALL SELECT MIN(date) FROM weights UNION ALL SELECT MAX(date) FROM weights
       ) WHERE d IS NOT NULL`,
    )
    .get();
  if (!bounds?.first) return res.json({ from: null, to: null, days: [], weights: [] });
  // Clamp to the data that exists, so a 3-month range on a week-old account
  // reports on that week rather than on 90 mostly-empty days.
  const from = req.query.from > bounds.first ? req.query.from : bounds.first;
  const to = req.query.to && req.query.to < bounds.last ? req.query.to : bounds.last;

  const byDate = new Map();
  const day = (date) => {
    let d = byDate.get(date);
    if (!d) {
      d = { date, food: 0, exercise: 0, entries: 0, protein: 0, meals: {} };
      byDate.set(date, d);
    }
    return d;
  };
  for (const row of db
    .prepare(
      `SELECT date, meal, SUM(caloriesCached) AS calories, COUNT(*) AS n
       FROM food_log WHERE date BETWEEN ? AND ? GROUP BY date, meal`,
    )
    .all(from, to)) {
    const d = day(row.date);
    d.food += row.calories;
    d.entries += row.n;
    d.meals[row.meal] = row.calories;
  }
  // Macros only exist for entries backed by a food that carries them.
  for (const row of db
    .prepare(
      `SELECT l.date, SUM(f.protein * l.servings) AS protein
       FROM food_log l JOIN foods f ON f.id = l.foodId
       WHERE l.date BETWEEN ? AND ? AND f.protein IS NOT NULL GROUP BY l.date`,
    )
    .all(from, to)) {
    day(row.date).protein = Math.round(row.protein * 10) / 10;
  }
  for (const row of db
    .prepare(
      `SELECT date, SUM(caloriesBurned) AS calories FROM exercise_log
       WHERE date BETWEEN ? AND ? GROUP BY date`,
    )
    .all(from, to)) {
    day(row.date).exercise += row.calories;
  }

  res.json({
    from,
    to,
    done: db
      .prepare('SELECT date FROM day_done WHERE date BETWEEN ? AND ? ORDER BY date')
      .all(from, to)
      .map((r) => r.date),
    days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    weights: db
      .prepare('SELECT date, weightKg FROM weights WHERE date BETWEEN ? AND ? ORDER BY date')
      .all(from, to),
  });
});

app.get('/api/foods', (req, res) => {
  const { q, source } = req.query;
  if (source) {
    return res.json(db.prepare('SELECT * FROM foods WHERE source = ? ORDER BY name').all(source));
  }
  if (!q) return res.json([]);
  // Ranked full-text search. A LIKE scan can't tell "Chicken breast" from
  // "Chicken breast flavoured crisps", and can't match a phrase against USDA's
  // qualifiers-last naming at all.
  res.json(searchFoods(db, q, { limit: 50 }));
});

// The lookup the meal-photo path will use: one answer or none, never a guess.
app.get('/api/foods/match', (req, res) => {
  const food = matchFood(db, req.query.q ?? '');
  res.json(food ?? null);
});

// Serving options for a food, so portions can be offered in units people use.
app.get('/api/foods/:id/servings', (req, res) => {
  res.json(
    db
      .prepare('SELECT * FROM food_servings WHERE foodId = ? ORDER BY isDefault DESC, grams DESC')
      .all(req.params.id),
  );
});

app.get('/api/foods/barcode/:code', (req, res) => {
  // Local first: with the bulk import in place this answers without touching
  // the network, which is the whole point of the barcode path. The same product
  // may be stored under either its UPC-A or EAN-13 form, so both are tried.
  const variants = barcodeVariants(req.params.code);
  if (variants.length === 0) return res.json(null);

  const local = db
    .prepare(
      `SELECT * FROM foods WHERE barcode IN (${variants.map(() => '?').join(', ')})
       ORDER BY (kcal100 IS NULL), (source = 'custom') DESC LIMIT 1`,
    )
    .get(...variants);
  res.json(local ?? null);
});

app.post('/api/foods', (req, res) => {
  const foods = Array.isArray(req.body) ? req.body : [req.body];
  db.transaction(() => foods.forEach(saveFood))();
  res.json({ ok: true, count: foods.length });
});

app.delete('/api/foods/:id', (req, res) => {
  const food = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
  if (!food) return res.status(404).json({ error: 'not found' });
  if (food.source === 'seed') {
    return res.status(400).json({ error: 'built-in foods cannot be deleted' });
  }
  // Past log entries keep their calories; stamp the name so history stays readable.
  db.transaction(() => {
    db.prepare('UPDATE food_log SET label = COALESCE(label, ?), foodId = NULL WHERE foodId = ?').run(
      food.brand ? `${food.name} (${food.brand})` : food.name,
      food.id,
    );
    db.prepare('DELETE FROM foods WHERE id = ?').run(food.id);
  })();
  res.json({ ok: true });
});

app.get('/api/recents', (_req, res) => {
  res.json(
    db
      .prepare(`SELECT f.* FROM foods f JOIN (
          SELECT foodId, MAX(rowid) AS r FROM food_log GROUP BY foodId ORDER BY r DESC LIMIT 25
        ) l ON l.foodId = f.id ORDER BY l.r DESC`)
      .all(),
  );
});

// Quick adds have no food behind them, so they can never show up in /api/recents.
// Their labels are the next best handle: the ten you've typed most recently.
app.get('/api/recent-quick-adds', (_req, res) => {
  res.json(
    db
      .prepare(`SELECT label, caloriesCached AS calories, MAX(rowid) AS r
                FROM food_log
                WHERE foodId IS NULL AND label IS NOT NULL AND label != ''
                GROUP BY label COLLATE NOCASE
                ORDER BY r DESC LIMIT 10`)
      .all()
      .map(({ label, calories }) => ({ label, calories: Math.round(calories) })),
  );
});

app.post('/api/food-log', (req, res) => {
  const e = { id: newId(), foodId: null, label: null, servings: 1, ...req.body };
  // INSERT OR IGNORE, not INSERT: an entry queued offline may be sent twice if
  // the reply is lost on a flaky connection. The client generates the id, so a
  // repeat is the same row and lands as a no-op rather than a duplicate meal.
  db.prepare(`INSERT OR IGNORE INTO food_log (id, date, meal, foodId, servings, caloriesCached, label)
    VALUES (@id, @date, @meal, @foodId, @servings, @caloriesCached, @label)`).run(e);
  res.json(e);
});

app.delete('/api/food-log/:id', (req, res) => {
  db.prepare('DELETE FROM food_log WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Editing a logged entry in place, rather than delete-and-re-add.
app.patch('/api/food-log/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM food_log WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const e = {
    ...existing,
    ...pick(req.body, ['meal', 'servings', 'caloriesCached', 'label']),
    id: existing.id,
  };
  db.prepare(`UPDATE food_log SET meal = @meal, servings = @servings,
    caloriesCached = @caloriesCached, label = @label WHERE id = @id`).run(e);
  res.json(e);
});

// ——— saved meals ———

const templateItems = db.prepare(
  `SELECT i.*, ${foodColumns} FROM meal_template_items i
   LEFT JOIN foods f ON f.id = i.foodId WHERE i.templateId = ? ORDER BY i.position`,
);

function templateWithItems(row) {
  return {
    ...row,
    items: templateItems.all(row.id).map((i) => ({
      id: i.id,
      foodId: i.foodId,
      servings: i.servings,
      caloriesCached: i.caloriesCached,
      label: i.label ?? undefined,
      food: rowFood(i),
    })),
  };
}

app.get('/api/meal-templates', (_req, res) => {
  const rows = db.prepare('SELECT * FROM meal_templates ORDER BY name COLLATE NOCASE').all();
  res.json(rows.map(templateWithItems));
});

const insertTemplate = db.prepare(
  'INSERT INTO meal_templates (id, name, createdAt) VALUES (@id, @name, @createdAt)',
);
const insertTemplateItem = db.prepare(
  `INSERT INTO meal_template_items (id, templateId, foodId, servings, caloriesCached, label, position)
   VALUES (@id, @templateId, @foodId, @servings, @caloriesCached, @label, @position)`,
);

function createTemplate(name, items) {
  const template = { id: newId(), name, createdAt: new Date().toISOString() };
  db.transaction(() => {
    insertTemplate.run(template);
    items.forEach((item, position) =>
      insertTemplateItem.run({
        id: newId(),
        templateId: template.id,
        foodId: item.foodId ?? null,
        servings: item.servings ?? 1,
        caloriesCached: Math.round(item.caloriesCached ?? 0),
        label: item.label ?? null,
        position,
      }),
    );
  })();
  return template;
}

app.post('/api/meal-templates', (req, res) => {
  const { name, items } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'at least one item required' });
  }
  const template = createTemplate(name.trim(), items);
  res.json(templateWithItems(db.prepare('SELECT * FROM meal_templates WHERE id = ?').get(template.id)));
});

// The everyday path: turn what you just logged into a reusable meal.
app.post('/api/meal-templates/from-day', (req, res) => {
  const { name, date, meal } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const entries = db
    .prepare('SELECT * FROM food_log WHERE date = ? AND meal = ? ORDER BY rowid')
    .all(date, meal);
  if (entries.length === 0) return res.status(400).json({ error: 'nothing logged for that meal' });
  const template = createTemplate(name.trim(), entries);
  res.json(templateWithItems(db.prepare('SELECT * FROM meal_templates WHERE id = ?').get(template.id)));
});

app.post('/api/meal-templates/:id/log', (req, res) => {
  const { date, meal } = req.body ?? {};
  const items = templateItems.all(req.params.id);
  if (items.length === 0) return res.status(404).json({ error: 'not found' });
  const insert = db.prepare(`INSERT INTO food_log (id, date, meal, foodId, servings, caloriesCached, label)
    VALUES (@id, @date, @meal, @foodId, @servings, @caloriesCached, @label)`);
  db.transaction(() => {
    for (const item of items) {
      insert.run({
        id: newId(),
        date,
        meal,
        foodId: item.foodId,
        servings: item.servings,
        caloriesCached: item.caloriesCached,
        label: item.label,
      });
    }
  })();
  res.json({ ok: true, count: items.length });
});

// A recipe is a saved meal divided into portions: sum the ingredients, split by
// how many servings it makes, and store that as an ordinary custom food.
app.post('/api/meal-templates/:id/as-food', (req, res) => {
  const { name, servings } = req.body ?? {};
  const makes = Number(servings);
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  if (!Number.isFinite(makes) || makes <= 0) return res.status(400).json({ error: 'servings required' });
  const items = templateItems.all(req.params.id);
  if (items.length === 0) return res.status(404).json({ error: 'not found' });

  const total = { calories: 0, protein: 0, carbs: 0, fat: 0, grams: 0 };
  let macrosKnown = true;
  for (const item of items) {
    total.calories += item.caloriesCached;
    const food = rowFood(item);
    if (!food) {
      macrosKnown = false; // a label-only item contributes calories and nothing else
      continue;
    }
    total.protein += (food.protein ?? 0) * item.servings;
    total.carbs += (food.carbs ?? 0) * item.servings;
    total.fat += (food.fat ?? 0) * item.servings;
    total.grams += (food.servingGrams ?? 0) * item.servings;
    if (food.protein == null && food.carbs == null && food.fat == null) macrosKnown = false;
  }

  const per = (v) => Math.round((v / makes) * 10) / 10;
  const food = {
    id: `custom-${newId()}`,
    name: name.trim(),
    brand: null,
    barcode: null,
    servingLabel: makes === 1 ? '1 recipe' : `1 of ${makes} servings`,
    servingGrams: total.grams > 0 ? per(total.grams) : null,
    caloriesPerServing: Math.round(total.calories / makes),
    protein: macrosKnown ? per(total.protein) : null,
    carbs: macrosKnown ? per(total.carbs) : null,
    fat: macrosKnown ? per(total.fat) : null,
    source: 'custom',
  };
  saveFood(food);
  res.json(food);
});

app.delete('/api/meal-templates/:id', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM meal_template_items WHERE templateId = ?').run(req.params.id);
    db.prepare('DELETE FROM meal_templates WHERE id = ?').run(req.params.id);
  })();
  res.json({ ok: true });
});

app.post('/api/exercise', (req, res) => {
  const e = { id: newId(), ...req.body };
  db.prepare(`INSERT OR IGNORE INTO exercise_log (id, date, name, minutes, caloriesBurned)
    VALUES (@id, @date, @name, @minutes, @caloriesBurned)`).run(e);
  res.json(e);
});

app.patch('/api/exercise/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM exercise_log WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const e = { ...existing, ...pick(req.body, ['name', 'minutes', 'caloriesBurned']), id: existing.id };
  db.prepare(
    'UPDATE exercise_log SET name = @name, minutes = @minutes, caloriesBurned = @caloriesBurned WHERE id = @id',
  ).run(e);
  res.json(e);
});

app.delete('/api/exercise/:id', (req, res) => {
  db.prepare('DELETE FROM exercise_log WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/weights', (_req, res) => {
  res.json(db.prepare('SELECT * FROM weights ORDER BY date').all());
});

app.put('/api/weights', (req, res) => {
  const { date, weightKg } = req.body;
  const existing = db.prepare('SELECT id FROM weights WHERE date = ?').get(date);
  const id = existing?.id ?? newId();
  db.prepare('INSERT OR REPLACE INTO weights (id, date, weightKg) VALUES (?, ?, ?)').run(id, date, weightKg);
  res.json({ id, date, weightKg });
});

app.delete('/api/weights/:id', (req, res) => {
  db.prepare('DELETE FROM weights WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.put('/api/day-done', (req, res) => {
  const { date, done } = req.body ?? {};
  if (!isDate(date)) return res.status(400).json({ error: 'bad date' });
  if (done) {
    db.prepare('INSERT OR REPLACE INTO day_done (date, completedAt) VALUES (?, ?)').run(
      date,
      new Date().toISOString(),
    );
  } else {
    db.prepare('DELETE FROM day_done WHERE date = ?').run(date);
  }
  res.json({ date, done: !!done });
});

// ——— progress photos ———

const photoPath = (id) => path.join(PHOTOS_DIR, `${id}.jpg`);

app.get('/api/photos', (_req, res) => {
  res.json(db.prepare('SELECT * FROM photos ORDER BY date, createdAt').all());
});

// Raw JPEG body; date in the query string. Client compresses before upload.
app.post('/api/photos', express.raw({ type: 'image/jpeg', limit: '10mb' }), (req, res) => {
  const { date } = req.query;
  if (!isDate(date)) return res.status(400).json({ error: 'bad date' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'no image' });
  }
  const photo = { id: newId(), date, createdAt: new Date().toISOString() };
  fs.writeFileSync(photoPath(photo.id), req.body);
  db.prepare('INSERT INTO photos (id, date, createdAt) VALUES (@id, @date, @createdAt)').run(photo);
  res.json(photo);
});

// The id must be one we issued — never a path fragment from the client.
function knownPhoto(req, res) {
  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!row) res.status(404).json({ error: 'not found' });
  return row;
}

app.get('/api/photos/:id/image', (req, res) => {
  const row = knownPhoto(req, res);
  if (!row) return;
  res.set('Cache-Control', 'private, max-age=31536000, immutable'); // content never changes
  res.sendFile(photoPath(row.id));
});

app.patch('/api/photos/:id', (req, res) => {
  const row = knownPhoto(req, res);
  if (!row) return;
  if (!isDate(req.body?.date)) return res.status(400).json({ error: 'bad date' });
  db.prepare('UPDATE photos SET date = ? WHERE id = ?').run(req.body.date, row.id);
  res.json({ ...row, date: req.body.date });
});

app.delete('/api/photos/:id', (req, res) => {
  const row = knownPhoto(req, res);
  if (!row) return;
  fs.rmSync(photoPath(row.id), { force: true });
  db.prepare('DELETE FROM photos WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ——— body measurements ———

app.get('/api/measurements', (_req, res) => {
  res.json(db.prepare('SELECT * FROM measurements ORDER BY date, site').all());
});

app.put('/api/measurements', (req, res) => {
  const { date, site, valueCm } = req.body ?? {};
  if (!isDate(date) || !site || !Number.isFinite(Number(valueCm))) {
    return res.status(400).json({ error: 'date, site and value required' });
  }
  const existing = db.prepare('SELECT id FROM measurements WHERE date = ? AND site = ?').get(date, site);
  const id = existing?.id ?? newId();
  db.prepare('INSERT OR REPLACE INTO measurements (id, date, site, valueCm) VALUES (?, ?, ?, ?)').run(
    id,
    date,
    site,
    Number(valueCm),
  );
  res.json({ id, date, site, valueCm: Number(valueCm) });
});

app.delete('/api/measurements/:id', (req, res) => {
  db.prepare('DELETE FROM measurements WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ——— evening reminder ———
//
// A push at your chosen hour, only when the day is still empty and unclosed.
// Needs a VAPID key pair (fly secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=...);
// without one the feature reports itself unavailable instead of half-working.

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const pushReady = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushReady) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:nobody@example.com',
    VAPID_PUBLIC,
    VAPID_PRIVATE,
  );
} else {
  console.log('Push reminders disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable.');
}

app.get('/api/push/config', (_req, res) => {
  res.json({
    enabled: pushReady,
    publicKey: VAPID_PUBLIC ?? null,
    subscriptions: db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get().c,
  });
});

app.post('/api/push/subscribe', (req, res) => {
  const { endpoint, keys } = req.body ?? {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'incomplete subscription' });
  }
  db.prepare(
    `INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, createdAt)
     VALUES (?, ?, ?, ?)`,
  ).run(endpoint, keys.p256dh, keys.auth, new Date().toISOString());
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  if (req.body?.endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(req.body.endpoint);
  }
  res.json({ ok: true });
});

app.post('/api/push/test', async (req, res) => {
  const sent = await sendReminder('Bend It!', 'Reminders are working.');
  res.json({ sent });
});

async function sendReminder(title, body) {
  if (!pushReady) return 0;
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body }),
      );
      sent++;
    } catch (err) {
      // 404/410 mean the browser threw the subscription away; stop trying.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
      } else {
        console.error('push failed:', err?.statusCode ?? '', err?.message ?? err);
      }
    }
  }
  return sent;
}

/** The user's own wall-clock date and hour, wherever they are. */
function localNow(timezone, at = new Date()) {
  const zone = timezone || 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

/** True when the day deserves a nudge: nothing logged and not marked done. */
function dayNeedsNudge(date) {
  const logged = db.prepare('SELECT 1 FROM food_log WHERE date = ? LIMIT 1').get(date);
  const done = db.prepare('SELECT 1 FROM day_done WHERE date = ?').get(date);
  return !logged && !done;
}

let lastReminderDate = null;

async function reminderTick() {
  if (!pushReady) return;
  const profile = db.prepare('SELECT * FROM profile WHERE id = ?').get(PROFILE_ID);
  if (!profile || profile.reminderHour == null) return;
  const { date, hour } = localNow(profile.timezone);
  if (hour !== profile.reminderHour || lastReminderDate === date) return;
  if (!dayNeedsNudge(date)) return;
  lastReminderDate = date;
  await sendReminder("Today isn't logged", 'A minute now beats guessing tomorrow.');
}

// Every five minutes: cheap, and fine-grained enough for an hourly trigger.
if (pushReady) setInterval(() => void reminderTick(), 5 * 60_000).unref();


// ——— backup & export ———

// RFC 4180: quote every field, double the quotes inside.
const csv = (rows) =>
  rows.map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';

function sendCsv(res, filename, rows) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv(rows));
}

app.get('/api/export/food-log.csv', (_req, res) => {
  const rows = db
    .prepare(`SELECT l.date, l.meal, COALESCE(f.name, l.label, '') AS item, f.brand,
                     l.servings, f.servingLabel, l.caloriesCached,
                     f.protein, f.carbs, f.fat
              FROM food_log l LEFT JOIN foods f ON f.id = l.foodId
              ORDER BY l.date, l.meal, l.rowid`)
    .all();
  sendCsv(res, 'bendit-food-log.csv', [
    ['date', 'meal', 'item', 'brand', 'servings', 'serving', 'calories', 'protein_g', 'carbs_g', 'fat_g'],
    ...rows.map((r) => [
      r.date,
      r.meal,
      r.item,
      r.brand,
      r.servings,
      r.servingLabel,
      Math.round(r.caloriesCached),
      r.protein == null ? '' : +(r.protein * r.servings).toFixed(1),
      r.carbs == null ? '' : +(r.carbs * r.servings).toFixed(1),
      r.fat == null ? '' : +(r.fat * r.servings).toFixed(1),
    ]),
  ]);
});

app.get('/api/export/weights.csv', (_req, res) => {
  const rows = db.prepare('SELECT date, weightKg FROM weights ORDER BY date').all();
  sendCsv(res, 'bendit-weights.csv', [
    ['date', 'weight_kg', 'weight_lb'],
    ...rows.map((r) => [r.date, r.weightKg, +(r.weightKg / 0.45359237).toFixed(2)]),
  ]);
});

app.get('/api/export/exercise.csv', (_req, res) => {
  const rows = db.prepare('SELECT date, name, minutes, caloriesBurned FROM exercise_log ORDER BY date').all();
  sendCsv(res, 'bendit-exercise.csv', [
    ['date', 'activity', 'minutes', 'calories_burned'],
    ...rows.map((r) => [r.date, r.name, r.minutes, Math.round(r.caloriesBurned)]),
  ]);
});

app.get('/api/export/measurements.csv', (_req, res) => {
  const rows = db.prepare('SELECT date, site, valueCm FROM measurements ORDER BY date, site').all();
  sendCsv(res, 'bendit-measurements.csv', [
    ['date', 'site', 'cm', 'inches'],
    ...rows.map((r) => [r.date, r.site, r.valueCm, +(r.valueCm / 2.54).toFixed(2)]),
  ]);
});

// Everything, in one file: a consistent copy of the database plus the photos.
// db.backup() rather than reading the file directly — with WAL on, a plain copy
// can catch a write half-finished.
app.get('/api/backup', async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const tmp = path.join(os.tmpdir(), `bendit-backup-${Date.now()}.db`);
  try {
    await db.backup(tmp);
  } catch (err) {
    console.error('backup failed:', err?.message ?? err);
    return res.status(500).json({ error: 'Could not copy the database.' });
  }

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="bendit-backup-${stamp}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  const cleanup = () => fs.rmSync(tmp, { force: true });
  archive.on('error', (err) => {
    console.error('backup archive failed:', err?.message ?? err);
    cleanup();
    res.destroy();
  });
  archive.on('close', cleanup);
  req.on('close', cleanup);

  archive.pipe(res);
  archive.file(tmp, { name: 'bendit.db' });
  for (const row of db.prepare('SELECT id, date FROM photos ORDER BY date').all()) {
    const file = photoPath(row.id);
    if (fs.existsSync(file)) archive.file(file, { name: `photos/${row.date}-${row.id}.jpg` });
  }
  archive.append(
    `Bend It! backup — ${new Date().toISOString()}\n\n` +
      `bendit.db   SQLite database (open with any SQLite tool)\n` +
      `photos/     progress photos, named by date\n\n` +
      `To restore: stop the app, put bendit.db where SQLITE_PATH points,\n` +
      `and the photos into the "photos" folder beside it.\n`,
    { name: 'README.txt' },
  );
  await archive.finalize();
});

app.delete('/api/all', (_req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM profile').run();
    db.prepare('DELETE FROM food_log').run();
    db.prepare('DELETE FROM exercise_log').run();
    db.prepare('DELETE FROM weights').run();
    db.prepare('DELETE FROM day_done').run();
    db.prepare('DELETE FROM meal_template_items').run();
    db.prepare('DELETE FROM meal_templates').run();
    db.prepare('DELETE FROM measurements').run();
    for (const row of db.prepare('SELECT id FROM photos').all()) {
      fs.rmSync(photoPath(row.id), { force: true });
    }
    db.prepare('DELETE FROM photos').run();
    db.prepare("DELETE FROM foods WHERE source != 'seed'").run();
  })();
  res.json({ ok: true });
});

// ——— static files (built client) ———

const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  // SPA fallback for React Router paths.
  app.use((req, res) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    }
    res.status(404).json({ error: 'not found' });
  });
}

app.listen(PORT, () => {
  console.log(`bendit server on :${PORT}, db at ${DB_PATH}`);
});
