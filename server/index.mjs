import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
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
