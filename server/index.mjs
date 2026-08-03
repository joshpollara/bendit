import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
CREATE TABLE IF NOT EXISTS food_log (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, meal TEXT NOT NULL, foodId TEXT NOT NULL,
  servings REAL NOT NULL, caloriesCached REAL NOT NULL
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
`);

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
  res.json({ entries, exercises, latestWeightKg: latest?.weightKg, yesterdayMealCounts });
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
  const e = { id: newId(), ...req.body };
  db.prepare(`INSERT INTO food_log (id, date, meal, foodId, servings, caloriesCached)
    VALUES (@id, @date, @meal, @foodId, @servings, @caloriesCached)`).run(e);
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

app.delete('/api/all', (_req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM profile').run();
    db.prepare('DELETE FROM food_log').run();
    db.prepare('DELETE FROM exercise_log').run();
    db.prepare('DELETE FROM weights').run();
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
