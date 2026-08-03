import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateMeal, PORTION_ERROR } from './mealEstimate.mjs';
import { createMealEstimateHandler } from './mealRoute.mjs';
import { createVisionExtractHandler } from './visionRoute.mjs';
import { TASKS } from './visionTasks.mjs';

// Real foods with their published per-100g figures, so the arithmetic can be
// checked by hand.
const FOODS = [
  ['usda-1', 'usda', 'Chicken, broilers or fryers, breast, meat only, cooked, roasted', 165, 31, 0, 3.6],
  ['usda-2', 'usda', 'Rice, white, long-grain, regular, enriched, cooked', 130, 2.7, 28.2, 0.3],
  ['usda-3', 'usda', 'Broccoli, cooked, boiled, drained, without salt', 35, 2.4, 7.2, 0.4],
  ['usda-4', 'usda', 'Oil, olive, salad or cooking', 884, 0, 0, 100],
];

let db;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE foods (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, source TEXT NOT NULL,
      servingLabel TEXT, servingGrams REAL,
      kcal100 REAL, protein100 REAL, carbs100 REAL, fat100 REAL
    );
    CREATE VIRTUAL TABLE foods_fts USING fts5(
      name, brand, content='foods', content_rowid='rowid', tokenize='porter unicode61'
    );
  `);
  const insert = db.prepare(
    `INSERT INTO foods (id, source, name, servingLabel, servingGrams, kcal100, protein100, carbs100, fat100)
     VALUES (?, ?, ?, '100 g', 100, ?, ?, ?, ?)`,
  );
  for (const row of FOODS) insert.run(row[0], row[1], row[2], row[3], row[4], row[5], row[6]);
  db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')");
});

const item = (name, grams, confidence = 'high') => ({ name, grams, confidence });

describe('estimateMeal', () => {
  it('computes nutrition from the database, for the grams estimated', () => {
    const result = estimateMeal(db, [item('grilled chicken breast', 150)]);
    const [only] = result.items;
    expect(only.food.id).toBe('usda-1');
    expect(only.nutrition.calories).toBe(248); // 165 × 1.5
    expect(only.nutrition.protein).toBe(46.5);
  });

  it('adds a plate up', () => {
    const result = estimateMeal(db, [
      item('grilled chicken breast', 150),
      item('white rice', 200),
      item('broccoli', 100),
    ]);
    expect(result.total.calories).toBe(248 + 260 + 35);
    expect(result.total.protein).toBe(46.5 + 5.4 + 2.4);
    expect(result.unmatched).toBe(0);
  });

  it('states a range, because the portion is the guess', () => {
    // 15% either side of 248 kcal at high confidence.
    const [only] = estimateMeal(db, [item('grilled chicken breast', 150, 'high')]).items;
    expect(only.range.low).toBe(211);
    expect(only.range.high).toBe(285);
  });

  it('widens the range when the model was less sure', () => {
    const high = estimateMeal(db, [item('white rice', 200, 'high')]).items[0];
    const low = estimateMeal(db, [item('white rice', 200, 'low')]).items[0];
    expect(low.range.high - low.range.low).toBeGreaterThan(high.range.high - high.range.low);
    expect(low.error).toBe(PORTION_ERROR.low);
  });

  it('keeps an item it could not match, rather than quietly shrinking the meal', () => {
    const result = estimateMeal(db, [item('grilled chicken breast', 150), item('rendang', 200)]);
    expect(result.items).toHaveLength(2);
    expect(result.items[1].food).toBeNull();
    expect(result.items[1].nutrition).toBeNull();
    expect(result.unmatched).toBe(1);
    // The total counts only what is actually known.
    expect(result.total.calories).toBe(248);
  });

  it('drops an item with no usable weight', () => {
    const result = estimateMeal(db, [item('white rice', 0), item('white rice', null), { name: '' }]);
    expect(result.items).toEqual([]);
  });

  it('treats an unknown confidence as the middle band rather than trusting it', () => {
    const [only] = estimateMeal(db, [item('white rice', 200, 'certain')]).items;
    expect(only.confidence).toBe('medium');
  });

  it('handles a photo with nothing in it', () => {
    expect(estimateMeal(db, []).total.calories).toBe(0);
    expect(estimateMeal(db).items).toEqual([]);
  });

  it('expresses the estimate in servings, which is what the log counts', () => {
    // 150 g of a food whose serving is 100 g is one and a half servings.
    const [only] = estimateMeal(db, [item('grilled chicken breast', 150)]).items;
    expect(only.servings).toBe(1.5);
    expect(only.food.servingLabel).toBe('100 g');
  });

  it('gets oil right, which is where a wrong match hurts most', () => {
    // A tablespoon of oil is more calories than the broccoli it dresses.
    const [only] = estimateMeal(db, [item('olive oil', 14)]).items;
    expect(only.nutrition.calories).toBe(124);
  });
});

describe('the meal task itself', () => {
  it('has nowhere to put a calorie figure', () => {
    // The guarantee this milestone rests on: the model cannot return nutrition
    // because the schema it is constrained to has no field for it.
    const fields = Object.keys(TASKS.meal.schema.properties.items.items.properties);
    expect(fields.sort()).toEqual(['confidence', 'grams', 'name']);
    expect(JSON.stringify(TASKS.meal.schema)).not.toMatch(/calorie|protein|carb|fat|kcal/i);
  });

  it('tells the model in words as well', () => {
    expect(TASKS.meal.prompt).toMatch(/Do not give calories/i);
  });
});

describe('POST /api/meals/estimate', () => {
  let visionDb;

  beforeEach(() => {
    visionDb = new Database(':memory:');
    visionDb.exec(`CREATE TABLE vision_requests (
      id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, task TEXT NOT NULL,
      promptVersion TEXT NOT NULL, model TEXT NOT NULL, imageHash TEXT NOT NULL,
      imageBytes INTEGER NOT NULL, status TEXT NOT NULL, errorCode TEXT,
      latencyMs INTEGER, inputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER,
      responseJson TEXT)`);
  });

  const handlerReturning = (data) =>
    createMealEstimateHandler({
      db,
      visionHandler: createVisionExtractHandler({
        db: visionDb,
        provider: {
          configured: true,
          model: 'test-model',
          extract: vi.fn(async () => ({
            data,
            raw: JSON.stringify(data),
            model: 'test-model',
            latencyMs: 900,
            usage: { inputTokens: 400, outputTokens: 60, totalTokens: 460 },
          })),
        },
        dailyLimit: 10,
      }),
    });

  const post = async (handler, body) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        res.statusCode = code;
        return res;
      },
      json(payload) {
        res.body = payload;
        return res;
      },
    };
    await handler({ body }, res);
    return res;
  };

  const image = Buffer.from('a plate of food').toString('base64');

  it('returns priced items and a total', async () => {
    const handler = handlerReturning({
      items: [
        { name: 'grilled chicken breast', grams: 150, confidence: 'high' },
        { name: 'white rice', grams: 200, confidence: 'medium' },
      ],
    });
    const res = await post(handler, { image });
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total.calories).toBe(508);
    expect(res.body.total.low).toBeLessThan(res.body.total.calories);
    expect(res.body.total.high).toBeGreaterThan(res.body.total.calories);
    expect(res.body.meta.usage.totalTokens).toBe(460);
  });

  it('ignores nutrition the model volunteers anyway', async () => {
    // Structured output should prevent this, but a number that arrives is
    // still not allowed anywhere near the total.
    const handler = handlerReturning({
      items: [{ name: 'white rice', grams: 200, confidence: 'high', calories: 9999 }],
    });
    const res = await post(handler, { image });
    expect(res.body.total.calories).toBe(260); // 130 × 2, from the database
    expect(JSON.stringify(res.body)).not.toContain('9999');
  });

  it('says so when there was no food in the photo', async () => {
    const res = await post(handlerReturning({ items: [] }), { image });
    expect(res.statusCode).toBe(422);
    expect(res.body.error.code).toBe('no_food_found');
  });

  it('passes a provider failure through for the client to handle', async () => {
    const handler = createMealEstimateHandler({
      db,
      visionHandler: createVisionExtractHandler({
        db: visionDb,
        provider: { configured: false, model: 'test-model', extract: vi.fn() },
        dailyLimit: 10,
      }),
    });
    const res = await post(handler, { image });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('unconfigured');
  });

  it('logs the call like any other', async () => {
    await post(handlerReturning({ items: [{ name: 'white rice', grams: 100, confidence: 'high' }] }), {
      image,
    });
    expect(visionDb.prepare('SELECT task FROM vision_requests').get().task).toBe('meal');
  });
});
