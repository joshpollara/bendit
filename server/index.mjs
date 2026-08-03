import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
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
`);

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
const AUTH_USER = process.env.BASIC_AUTH_USER || 'bendit';

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// PWA assets must be reachable without credentials: Chrome fetches manifest
// icons credential-less, and without them installs degrade to a browser
// shortcut. Nothing sensitive lives in these files.
const PUBLIC_PATHS = new Set([
  '/manifest.webmanifest',
  '/sw.js',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-512-maskable.png',
  '/apple-touch-icon.png',
  '/favicon.ico',
]);

// Fails closed: with no BASIC_AUTH_PASSWORD set, every request is denied.
app.use((req, res, next) => {
  if (req.method === 'GET' && PUBLIC_PATHS.has(req.path)) return next();
  let ok = false;
  const [scheme, cred] = (req.headers.authorization ?? '').split(' ');
  if (AUTH_PASS && scheme === 'Basic' && cred) {
    const decoded = Buffer.from(cred, 'base64').toString();
    const i = decoded.indexOf(':');
    if (i > 0) {
      ok = safeEqual(decoded.slice(0, i), AUTH_USER) && safeEqual(decoded.slice(i + 1), AUTH_PASS);
    }
  }
  if (!ok) {
    res.set('WWW-Authenticate', 'Basic realm="Bend It!"');
    return res.status(401).send('Authentication required');
  }
  next();
});

// ——— helpers ———

const newId = () => crypto.randomUUID();

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
  const p = { ...req.body, id: PROFILE_ID };
  db.prepare(`INSERT OR REPLACE INTO profile
    (id, sex, birthDate, heightCm, startWeightKg, goalWeightKg, activityLevel, weeklyRateKg, units, createdAt)
    VALUES (@id, @sex, @birthDate, @heightCm, @startWeightKg, @goalWeightKg, @activityLevel, @weeklyRateKg, @units, @createdAt)`).run(p);
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
         ORDER BY CASE f.source WHEN 'custom' THEN 0 WHEN 'openfoodfacts' THEN 1 ELSE 2 END,
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
      d = { date, food: 0, exercise: 0, entries: 0, meals: {} };
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
  const like = `%${q}%`;
  res.json(
    db
      .prepare('SELECT * FROM foods WHERE name LIKE ? OR brand LIKE ? LIMIT 100')
      .all(like, like),
  );
});

app.get('/api/foods/barcode/:code', (req, res) => {
  res.json(db.prepare('SELECT * FROM foods WHERE barcode = ?').get(req.params.code) ?? null);
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

app.post('/api/food-log', (req, res) => {
  const e = { id: newId(), foodId: null, label: null, servings: 1, ...req.body };
  db.prepare(`INSERT INTO food_log (id, date, meal, foodId, servings, caloriesCached, label)
    VALUES (@id, @date, @meal, @foodId, @servings, @caloriesCached, @label)`).run(e);
  res.json(e);
});

app.delete('/api/food-log/:id', (req, res) => {
  db.prepare('DELETE FROM food_log WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/exercise', (req, res) => {
  const e = { id: newId(), ...req.body };
  db.prepare(`INSERT INTO exercise_log (id, date, name, minutes, caloriesBurned)
    VALUES (@id, @date, @name, @minutes, @caloriesBurned)`).run(e);
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return res.status(400).json({ error: 'bad date' });
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return res.status(400).json({ error: 'bad date' });
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

app.delete('/api/photos/:id', (req, res) => {
  const row = knownPhoto(req, res);
  if (!row) return;
  fs.rmSync(photoPath(row.id), { force: true });
  db.prepare('DELETE FROM photos WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

app.delete('/api/all', (_req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM profile').run();
    db.prepare('DELETE FROM food_log').run();
    db.prepare('DELETE FROM exercise_log').run();
    db.prepare('DELETE FROM weights').run();
    db.prepare('DELETE FROM day_done').run();
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
