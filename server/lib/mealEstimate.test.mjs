import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  estimateMeal,
  normalizeHolisticEstimate,
  normalizeMealEvidence,
  PORTION_ERROR,
  reconcileMealEstimates,
  selectPortionQuestion,
} from './mealEstimate.mjs';
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
      kcal100 REAL, protein100 REAL, carbs100 REAL, fat100 REAL, ownerId TEXT
    );
    CREATE TABLE food_servings (
      id TEXT PRIMARY KEY, foodId TEXT NOT NULL, label TEXT NOT NULL,
      grams REAL NOT NULL, isDefault INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE foods_fts USING fts5(
      name, brand, content='foods', content_rowid='rowid', tokenize='porter unicode61'
    );
  `);
  // A household portion for the rice, so the unit picker has something to offer.
  db.prepare('INSERT INTO food_servings VALUES (?, ?, ?, ?, ?)').run(
    'usda-2:0', 'usda-2', '1 cup (158g)', 158, 1,
  );
  const insert = db.prepare(
    `INSERT INTO foods (id, source, name, servingLabel, servingGrams, kcal100, protein100, carbs100, fat100)
     VALUES (?, ?, ?, '100 g', 100, ?, ?, ?, ?)`,
  );
  for (const row of FOODS) insert.run(row[0], row[1], row[2], row[3], row[4], row[5], row[6]);
  db.prepare(
    `INSERT INTO foods
      (id, source, name, servingLabel, servingGrams, kcal100, protein100, carbs100, fat100, ownerId)
     VALUES ('private-1', 'custom', 'Private stew', '100 g', 100, 900, 10, 10, 80, 'other-user')`,
  ).run();
  db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')");
});

const item = (name, grams, confidence = 'high') => ({ name, grams, confidence });

describe('estimateMeal', () => {
  it('makes duplicate model item ids unique before they reach logging', () => {
    const normalized = normalizeMealEvidence({
      items: [
        { id: 'same', name: 'white rice', grams: 100 },
        { id: 'same', name: 'broccoli', grams: 100 },
      ],
    });
    expect(normalized.items.map((entry) => entry.id)).toEqual(['same', 'same_2']);
  });

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

  it('looks the food up by how it is catalogued, not by how it is said', () => {
    // The spoken name finds nothing here; the catalogue form is the whole
    // point of asking for both.
    const [only] = estimateMeal(db, [
      { name: 'a bit of chicken', query: 'chicken breast, roasted', grams: 150, confidence: 'high' },
    ]).items;
    expect(only.food.id).toBe('usda-1');
    expect(only.name).toBe('a bit of chicken'); // what the person sees is still their words
  });

  it('falls back to the broader term for a food it could only half place', () => {
    const [only] = estimateMeal(db, [
      { name: 'jasmine rice', query: 'jasmine rice, steamed', alternate: 'white rice', grams: 100, confidence: 'medium' },
    ]).items;
    expect(only.food.id).toBe('usda-2');
  });

  it('still works when the model gives only a name', () => {
    // Nothing forces version 2 of the prompt to be the one that answered.
    const [only] = estimateMeal(db, [item('grilled chicken breast', 150)]).items;
    expect(only.food.id).toBe('usda-1');
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

  it('brings the household portions along, for correcting in cups not grams', () => {
    const [rice] = estimateMeal(db, [item('white rice', 200)]).items;
    expect(rice.food.servings).toEqual([{ label: '1 cup (158g)', grams: 158 }]);
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

  it('uses explicit portion bounds instead of deriving a band from one gram guess', () => {
    const [rice] = estimateMeal(db, {
      mealType: 'simple_plate',
      items: [
        {
          id: 'rice',
          name: 'white rice',
          query: 'white rice cooked',
          portionG: { low: 100, median: 200, high: 300 },
          confidence: { identity: 0.9, portion: 0.5, preparation: 0.8 },
        },
      ],
    }).items;
    expect(rice.grams).toBe(200);
    expect(rice.range).toEqual({ low: 130, high: 390 });
  });

  it('prices hidden oil only into the high scenario, never silently into the point estimate', () => {
    const [broccoli] = estimateMeal(db, {
      items: [
        {
          name: 'broccoli',
          query: 'broccoli cooked',
          portionG: { low: 100, median: 100, high: 100 },
          hiddenIngredientRisks: [
            {
              ingredient: 'olive oil',
              likelihood: 0.6,
              quantityG: { low: 0, high: 14 },
              evidence: 'May have been dressed',
            },
          ],
        },
      ],
    }).items;
    expect(broccoli.nutrition.calories).toBe(35);
    expect(broccoli.range.low).toBe(35);
    expect(broccoli.range.high).toBe(159);
  });

  it('refuses an explicit raw-versus-cooked contradiction', () => {
    const result = estimateMeal(db, {
      items: [
        {
          name: 'white rice',
          query: 'white rice raw',
          preparation: 'raw',
          portionG: { low: 100, median: 100, high: 100 },
        },
      ],
    });
    expect(result.items[0].food).toBeNull();
  });

  it('never searches another user’s private custom foods', () => {
    expect(estimateMeal(db, [item('private stew', 100)]).items[0].food?.id).toBe('private-1');
    expect(estimateMeal(db, [item('private stew', 100)], { ownerId: 'this-user' }).items[0].food).toBeNull();
  });
});

describe('meal evidence normalization', () => {
  it('orders and caps unsafe model values and normalizes candidate probabilities', () => {
    const normalized = normalizeMealEvidence({
      scaleEvidence: {
        available: true,
        source: 'printed ruler',
        knownDimensionMm: -40,
        confidence: 8,
      },
      items: [
        {
          name: 'rice',
          portionG: { low: 9000, median: -20, high: 300 },
          identityCandidates: [
            { name: 'rice', probability: 3 },
            { name: 'risotto', probability: 1 },
            { name: 'porridge', probability: 0 },
            { name: 'fourth', probability: 1 },
          ],
        },
      ],
    });
    expect(normalized.items[0].portionG).toEqual({ low: 0, median: 300, high: 5000 });
    expect(normalized.items[0].identityCandidates).toHaveLength(3);
    expect(sumProbabilities(normalized.items[0].identityCandidates)).toBeCloseTo(1, 4);
    expect(normalized.scaleEvidence).toEqual({
      available: false,
      source: null,
      knownDimensionMm: null,
      confidence: 1,
    });
  });

  it('drops items without a finite positive median', () => {
    expect(normalizeMealEvidence({ items: [{ name: 'rice', portionG: { low: 0, median: 0, high: 5 } }] }).items)
      .toEqual([]);
  });
});

const sumProbabilities = (items) => items.reduce((total, candidate) => total + candidate.probability, 0);

describe('hybrid reconciliation', () => {
  const holistic = (energyKcal, overrides = {}) => ({
    mealType: 'mixed_dish',
    energyKcal,
    macrosG: {
      protein: { low: 20, median: 30, high: 40 },
      carbs: { low: 30, median: 50, high: 70 },
      fat: { low: 10, median: 20, high: 35 },
      fiber: { low: 2, median: 5, high: 8 },
    },
    hiddenIngredientRisks: [],
    uncertaintyReasons: [],
    ...overrides,
  });

  it('rejects a holistic result without a complete finite energy range', () => {
    expect(normalizeHolisticEstimate({ energyKcal: { low: 100, median: 'nope', high: 300 } })).toBeNull();
  });

  it('uses a holistic residual to stop an unresolved mixed dish from counting as zero', () => {
    const database = estimateMeal(db, {
      mealType: 'mixed_dish',
      items: [
        { id: 'chicken', name: 'chicken breast', grams: 150, confidence: 'high' },
        { id: 'rendang', name: 'rendang', grams: 200, confidence: 'low' },
      ],
    });
    const result = reconcileMealEstimates(database, holistic({ low: 600, median: 800, high: 1000 }));
    const rendang = result.items.find((entry) => entry.id === 'rendang');
    expect(result.path.selected).toBe('hybrid');
    expect(result.total.calories).toBe(800);
    expect(rendang.nutrition.calories).toBeGreaterThan(0);
    expect(result.total.low).toBe(Math.min(database.total.low, 600));
    expect(result.total.high).toBe(Math.max(database.total.high, 1000));
    expect(rendang.range.low).toBeLessThanOrEqual(rendang.nutrition.calories);
    expect(rendang.range.high).toBeGreaterThanOrEqual(rendang.nutrition.calories);
  });

  it('keeps a generated holistic row distinct from a parser item with the same id', () => {
    const database = estimateMeal(db, {
      mealType: 'mixed_dish',
      items: [{ id: 'holistic_adjustment', name: 'white rice', grams: 100 }],
    });
    const result = reconcileMealEstimates(database, holistic({ low: 300, median: 500, high: 700 }));
    expect(new Set(result.items.map((entry) => entry.id)).size).toBe(result.items.length);
    expect(result.items.map((entry) => entry.id)).toContain('holistic_adjustment_2');
  });

  it('does not raise a reliable simple plate merely because the holistic point is higher', () => {
    const database = estimateMeal(db, {
      mealType: 'simple_plate',
      items: [{ id: 'rice', name: 'white rice', grams: 200, confidence: 'high' }],
    });
    const result = reconcileMealEstimates(database, holistic({ low: 300, median: 500, high: 700 }));
    expect(result.total.calories).toBe(260);
    expect(result.total.low).toBe(Math.min(database.total.low, 300));
    expect(result.total.high).toBe(Math.max(database.total.high, 700));
  });

  it('does not count a holistic residual range twice', () => {
    const database = estimateMeal(db, {
      mealType: 'mixed_dish',
      items: [
        {
          id: 'rice',
          name: 'white rice',
          portionG: { low: 100, median: 200, high: 400 },
          hiddenIngredientRisks: [
            { ingredient: 'olive oil', likelihood: 0.6, quantityG: { low: 0, high: 20 } },
          ],
        },
      ],
    });
    const result = reconcileMealEstimates(database, holistic({ low: 500, median: 700, high: 900 }));

    expect(result.total.calories).toBe(700);
    expect(result.total.low).toBe(Math.min(database.total.low, 500));
    expect(result.total.high).toBe(Math.max(database.total.high, 900));
    expect(result.total.protein).toBe(30);
    expect(result.total.fat).toBe(20);
  });

  it('falls back to a loggable whole-meal item when item parsing is unavailable', () => {
    const database = estimateMeal(db, { mealType: 'other', items: [] });
    const result = reconcileMealEstimates(database, holistic({ low: 350, median: 500, high: 700 }));
    expect(result.path.selected).toBe('holistic');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].nutrition.calories).toBe(500);
    expect(result.total).toMatchObject({ calories: 500, low: 350, high: 700 });
  });

  it('selects at most the single highest-impact portion question above the threshold', () => {
    const estimate = estimateMeal(db, {
      items: [
        {
          id: 'rice',
          name: 'white rice',
          portionG: { low: 100, median: 200, high: 400 },
        },
        {
          id: 'broccoli',
          name: 'broccoli',
          portionG: { low: 50, median: 100, high: 200 },
        },
      ],
    });
    const question = selectPortionQuestion(estimate);
    expect(question.targetItemId).toBe('rice');
    expect(question.choices).toHaveLength(3);
    expect(question.expectedReductionKcal).toBeGreaterThan(80);
  });

  it('asks nothing when no portion can reduce the interval enough', () => {
    const estimate = estimateMeal(db, [item('broccoli', 100, 'high')]);
    expect(selectPortionQuestion(estimate)).toBeNull();
  });
});

describe('the meal task itself', () => {
  it('names the food before it weighs it', () => {
    // Field order is generation order. A weight produced before the model has
    // committed to what the food is, and to what it measured against, is a
    // guess with nothing behind it.
    const fields = Object.keys(TASKS.meal.schema.properties.items.items.properties);
    expect(Object.keys(TASKS.meal.schema.properties)[0]).toBe('captureQuality');
    expect(Object.keys(TASKS.meal.schema.properties).indexOf('scaleEvidence')).toBeLessThan(
      Object.keys(TASKS.meal.schema.properties).indexOf('items'),
    );
    expect(fields.indexOf('query')).toBeLessThan(fields.indexOf('portionG'));
  });

  it('has nowhere to put a calorie figure', () => {
    // The guarantee this milestone rests on: the model cannot return nutrition
    // because the schema it is constrained to has no field for it.
    const fields = Object.keys(TASKS.meal.schema.properties.items.items.properties);
    expect(fields).toContain('portionG');
    expect(fields).toContain('identityCandidates');
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
      responseJson TEXT, userId TEXT, mealPhotoRunId TEXT)`);
  });

  const handlerReturning = (data, holisticData = {}) =>
    createMealEstimateHandler({
      db,
      visionHandler: createVisionExtractHandler({
        db: visionDb,
        provider: {
          configured: true,
          model: 'test-model',
          extract: vi.fn(async ({ schema }) => {
            const answer = 'energyKcal' in schema.properties ? holisticData : data;
            return {
              data: answer,
              raw: JSON.stringify(answer),
              model: 'test-model',
              latencyMs: 900,
              usage: { inputTokens: 400, outputTokens: 60, totalTokens: 460 },
            };
          }),
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
    await handler({ body, userId: 'test-user' }, res);
    return res;
  };

  const image = Buffer.from('a plate of food').toString('base64');

  it('marks a run failed when an internal analysis handler throws unexpectedly', async () => {
    const handler = createMealEstimateHandler({
      db,
      visionHandler: async () => {
        throw new Error('unexpected');
      },
    });

    await expect(post(handler, { image })).rejects.toThrow('unexpected');
    expect(
      db.prepare("SELECT status FROM meal_photo_runs ORDER BY createdAt DESC LIMIT 1").get().status,
    ).toBe('failed');
  });

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
    expect(res.body.meta.usage.totalTokens).toBe(920);
    expect(res.body.meta.models).toEqual({ parser: 'test-model', holistic: 'test-model' });
    expect(res.body.estimateId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores nutrition the model volunteers anyway', async () => {
    // Structured output should prevent this, but a number that arrives is
    // still not allowed anywhere near the total.
    const handler = handlerReturning({
      items: [{ name: 'white rice', grams: 200, confidence: 'high', calories: 9999 }],
    });
    const res = await post(handler, { image });
    expect(res.body.total.calories).toBe(260); // 130 × 2, from the database
    expect(res.body.items[0]).not.toHaveProperty('calories');
    expect(res.body.evidence.items[0]).not.toHaveProperty('calories');
  });

  it('returns an empty meal when there was no food in the photo', async () => {
    // Not an error: the screen this opens is the one that can rescue it by
    // hand, and an error would have thrown the read away instead.
    const res = await post(handlerReturning({ items: [] }), { image });
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total.calories).toBe(0);
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

  it('keeps the database result when the independent whole-meal call is rate limited', async () => {
    const visionHandler = vi.fn(async (req, res) => {
      if (req.body.task === 'mealHolistic') {
        return res.status(429).json({ error: { code: 'rate_limited', message: 'model quota' } });
      }
      return res.json({
        data: { items: [{ name: 'white rice', grams: 200, confidence: 'high' }] },
        meta: {
          model: 'parser',
          promptVersion: '3',
          latencyMs: 10,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          callsRemainingToday: 8,
        },
      });
    });
    const res = await post(createMealEstimateHandler({ db, visionHandler }), { image });
    expect(res.statusCode).toBe(200);
    expect(res.body.total.calories).toBe(260);
    expect(res.body.path.holistic).toBeNull();
    expect(res.body.meta.partialFailures).toEqual([{ role: 'holistic', code: 'rate_limited' }]);
  });

  it('returns one rate-limit failure when both meal paths are unavailable', async () => {
    const visionHandler = vi.fn(async (_req, res) =>
      res.status(429).json({ error: { code: 'rate_limited', message: 'model quota' } }),
    );
    const res = await post(createMealEstimateHandler({ db, visionHandler }), { image });

    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(visionHandler).toHaveBeenCalledTimes(2);
  });

  it('returns a loggable whole-meal fallback when item parsing fails', async () => {
    const visionHandler = vi.fn(async (req, res) => {
      if (req.body.task === 'meal') {
        return res.status(502).json({ error: { code: 'provider_error', message: 'bad parser' } });
      }
      return res.json({
        data: {
          mealType: 'mixed_dish',
          energyKcal: { low: 400, median: 550, high: 750 },
          macrosG: {
            protein: { low: 20, median: 30, high: 40 },
            carbs: { low: 40, median: 60, high: 80 },
            fat: { low: 10, median: 20, high: 35 },
            fiber: { low: 2, median: 5, high: 8 },
          },
          hiddenIngredientRisks: [],
          uncertaintyReasons: [],
        },
        meta: {
          model: 'holistic',
          promptVersion: '1',
          latencyMs: 10,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          callsRemainingToday: 8,
        },
      });
    });
    const res = await post(createMealEstimateHandler({ db, visionHandler }), { image });
    expect(res.statusCode).toBe(200);
    expect(res.body.path.selected).toBe('holistic');
    expect(res.body.items[0].nutrition.calories).toBe(550);
    expect(res.body.uncertaintyReasons[0]).toMatch(/fallback/i);
  });

  it('logs the call like any other', async () => {
    const res = await post(
      handlerReturning({ items: [{ name: 'white rice', grams: 100, confidence: 'high' }] }),
      { image },
    );
    expect(
      visionDb
        .prepare('SELECT task FROM vision_requests WHERE mealPhotoRunId = ? ORDER BY task')
        .all(res.body.estimateId)
        .map((row) => row.task),
    ).toEqual(['meal', 'mealHolistic']);
    expect(db.prepare('SELECT status FROM meal_photo_runs WHERE id = ?').get(res.body.estimateId).status).toBe(
      'reviewing',
    );
  });
});
