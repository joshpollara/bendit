import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  estimateMeal,
  normalizeMealEvidence,
  PORTION_ERROR,
  selectPortionQuestion,
} from './mealEstimate.mjs';
import { createMealEstimateHandler } from './mealRoute.mjs';
import { createVisionExtractHandler } from './visionRoute.mjs';
import { TASKS } from './visionTasks.mjs';

// Nothing here seeds a foods table, because nothing here looks one up. The
// numbers come from the model, and what is tested is whether they survive the
// trip intact and are refused when they are not usable.

/** A model item in the shape the meal task now returns. */
const item = (name, overrides = {}) => ({
  id: name.replace(/\s+/g, '_'),
  name,
  portionG: { low: 80, median: 100, high: 130 },
  energyKcal: { low: 120, median: 160, high: 220 },
  macrosG: { protein: 6, carbs: 20, fat: 4 },
  confidence: { identity: 0.8, portion: 0.6 },
  hiddenIngredientRisks: [],
  uncertainties: [],
  ...overrides,
});

describe('estimateMeal', () => {
  it('takes the calories and macros the model gave, for the portion it saw', () => {
    const { items } = estimateMeal({ items: [item('white rice')] });
    expect(items[0]).toMatchObject({
      name: 'white rice',
      grams: 100,
      nutrition: { calories: 160, protein: 6, carbs: 20, fat: 4 },
      range: { low: 120, high: 220 },
    });
  });

  it('attaches no food record to anything', () => {
    // The whole point: a plate photographed in a restaurant used to come back
    // as whichever packet shared a word with it, priced to the calorie off that
    // packet's label. A food record now only ever arrives by someone choosing it.
    const { items } = estimateMeal({
      items: [item('smoked salmon salad'), item('chicken')],
    });
    expect(items.map((entry) => entry.food)).toEqual([null, null]);
    for (const entry of items) expect(entry).not.toHaveProperty('match');
  });

  it('adds a plate up, bands and all', () => {
    const { total } = estimateMeal({
      items: [
        item('rice', { energyKcal: { low: 200, median: 250, high: 320 }, macrosG: { protein: 5, carbs: 55, fat: 1 } }),
        item('chicken', { energyKcal: { low: 180, median: 210, high: 260 }, macrosG: { protein: 40, carbs: 0, fat: 5 } }),
      ],
    });
    expect(total).toMatchObject({
      calories: 460,
      protein: 45,
      carbs: 55,
      fat: 6,
      low: 380,
      high: 580,
    });
  });

  it('states a range, because the meal was looked at and not weighed', () => {
    const { items } = estimateMeal({ items: [item('stew')] });
    expect(items[0].range.low).toBeLessThan(items[0].nutrition.calories);
    expect(items[0].range.high).toBeGreaterThan(items[0].nutrition.calories);
    // Half the interval, over the estimate: (220 - 120) / (2 × 160).
    expect(items[0].error).toBeCloseTo(0.313, 3);
  });

  it('refuses a range so tight it claims the meal was weighed', () => {
    // A single repeated number is not certainty, it is a model declining to
    // answer the question. The stated portion confidence sets the band instead.
    const { items } = estimateMeal({
      items: [item('rice', { energyKcal: { low: 200, median: 200, high: 200 }, confidence: 'high' })],
    });
    expect(items[0].nutrition.calories).toBe(200);
    expect(items[0].range).toEqual({ low: 170, high: 230 }); // ±15%, the high-confidence band
  });

  it('keeps an item it could not price, rather than quietly shrinking the meal', () => {
    const { items, total, unpriced } = estimateMeal({
      items: [item('rice'), item('mystery sauce', { energyKcal: { low: 0, median: 0, high: 0 } })],
    });
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ name: 'mystery sauce', nutrition: null, range: null });
    expect(total.calories).toBe(160);
    expect(unpriced).toBe(1);
  });

  it('says so when something on the plate has no number on it', () => {
    const { uncertaintyReasons } = estimateMeal({
      items: [item('rice'), item('sauce', { energyKcal: null })],
    });
    expect(uncertaintyReasons.join(' ')).toMatch(/1 visible item has no estimate/i);
  });

  it('makes duplicate model item ids unique before they reach logging', () => {
    const { items } = estimateMeal({
      items: [item('rice', { id: 'x' }), item('beans', { id: 'x' })],
    });
    expect(items.map((entry) => entry.id)).toEqual(['x', 'x_2']);
  });

  it('drops an item with no usable weight', () => {
    expect(estimateMeal({ items: [item('rice', { portionG: null, grams: 0 })] }).items).toEqual([]);
  });

  it('handles a photo with nothing in it', () => {
    const result = estimateMeal({ items: [] });
    expect(result.items).toEqual([]);
    expect(result.total.calories).toBe(0);
    expect(result.mealType).toBe('not_food');
    expect(result.status).toBe('ready');
  });

  it('asks for a retake when the photograph cannot answer the question', () => {
    const result = estimateMeal({
      mealType: 'simple_plate',
      captureQuality: { needsRetake: true, retakeReason: 'too dark' },
      items: [item('rice')],
    });
    expect(result.status).toBe('retake');
    expect(result.captureQuality.retakeReason).toBe('too dark');
  });

  it('carries hidden-ingredient risk through as a reason, not as a number', () => {
    // Pricing invisible oil used to mean looking oil up and adding it. What is
    // hidden belongs in the model's own range and in what the screen says.
    const result = estimateMeal({
      items: [
        item('salad', {
          hiddenIngredientRisks: [
            { ingredient: 'olive oil', likelihood: 0.6, quantityG: { low: 0, high: 20 }, evidence: 'glossy leaves' },
          ],
        }),
      ],
    });
    expect(result.items[0].hiddenIngredientRisks[0].ingredient).toBe('olive oil');
    expect(result.total.calories).toBe(160);
    expect(result.uncertaintyReasons.join(' ')).toMatch(/hidden ingredients/i);
  });

  it('still works when the model gives only a name and a weight', () => {
    // The older shape, kept working so a prompt rollback is not a data outage.
    const { items } = estimateMeal([{ name: 'rice', grams: 200, confidence: 'medium' }]);
    expect(items[0]).toMatchObject({ name: 'rice', grams: 200, nutrition: null });
    expect(items[0].error).toBe(PORTION_ERROR.medium);
  });
});

describe('meal evidence normalization', () => {
  it('orders and caps unsafe model values', () => {
    const normalized = normalizeMealEvidence({
      scaleEvidence: { available: true, source: 'printed ruler', knownDimensionMm: -40, confidence: 8 },
      items: [item('rice', { portionG: { low: 9000, median: -20, high: 300 } })],
    });
    expect(normalized.items[0].portionG).toEqual({ low: 0, median: 300, high: 5000 });
    expect(normalized.scaleEvidence).toEqual({
      available: false,
      source: null,
      knownDimensionMm: null,
      confidence: 1,
    });
  });

  it('puts an out-of-order energy range back in order', () => {
    const normalized = normalizeMealEvidence({
      items: [item('rice', { energyKcal: { low: 400, median: 100, high: 250 } })],
    });
    expect(normalized.items[0].energyKcal).toEqual({ low: 100, median: 250, high: 400 });
  });

  it('refuses a nutrition figure that is not a number', () => {
    const normalized = normalizeMealEvidence({
      items: [item('rice', { energyKcal: { low: 100, median: 'nope', high: 300 }, macrosG: { protein: 'x' } })],
    });
    expect(normalized.items[0].energyKcal).toBeNull();
    expect(normalized.items[0].macrosG.protein).toBeNull();
  });

  it('drops items without a finite positive median', () => {
    expect(
      normalizeMealEvidence({ items: [item('rice', { portionG: { low: 0, median: 0, high: 5 } })] }).items,
    ).toEqual([]);
  });
});

describe('the portion question', () => {
  it('selects at most the single highest-impact portion question above the threshold', () => {
    const estimate = estimateMeal({
      items: [
        item('rice', {
          portionG: { low: 100, median: 200, high: 400 },
          energyKcal: { low: 150, median: 250, high: 450 },
        }),
        item('broccoli', { energyKcal: { low: 30, median: 35, high: 40 } }),
      ],
    });
    expect(estimate.question.targetItemId).toBe('rice');
    expect(estimate.question.choices).toHaveLength(3);
    expect(estimate.question.expectedReductionKcal).toBe(300);
    expect(estimate.status).toBe('needs_question');
  });

  it('asks nothing when no portion can reduce the interval enough', () => {
    const estimate = estimateMeal({ items: [item('broccoli', { energyKcal: { low: 33, median: 35, high: 37 } })] });
    expect(selectPortionQuestion(estimate)).toBeNull();
    expect(estimate.status).toBe('ready');
  });

  it('asks about the food by the name on the screen', () => {
    const estimate = estimateMeal({
      items: [
        item('roast potatoes', {
          portionG: { low: 100, median: 200, high: 400 },
          energyKcal: { low: 150, median: 250, high: 450 },
        }),
      ],
    });
    expect(estimate.question.question).toMatch(/roast potatoes/);
  });
});

describe('the meal task itself', () => {
  it('names and weighs the food before it prices it', () => {
    // Field order is generation order. Energy committed before the model has
    // said what the food is, and how much of it there is, is a guess with
    // nothing behind it.
    const fields = Object.keys(TASKS.meal.schema.properties.items.items.properties);
    expect(fields.indexOf('name')).toBeLessThan(fields.indexOf('portionG'));
    expect(fields.indexOf('portionG')).toBeLessThan(fields.indexOf('energyKcal'));
    expect(fields.indexOf('energyKcal')).toBeLessThan(fields.indexOf('macrosG'));
  });

  it('has somewhere to put a calorie figure, which is the point', () => {
    const fields = Object.keys(TASKS.meal.schema.properties.items.items.properties);
    expect(fields).toContain('energyKcal');
    expect(fields).toContain('macrosG');
  });

  it('tells the model in words that the range is not decoration', () => {
    expect(TASKS.meal.prompt).toMatch(/Never return a range so tight/i);
  });
});

describe('POST /api/meals/estimate', () => {
  let db;
  let visionDb;

  beforeEach(() => {
    db = new Database(':memory:');
    visionDb = new Database(':memory:');
    visionDb.exec(`CREATE TABLE vision_requests (
      id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, task TEXT NOT NULL,
      promptVersion TEXT NOT NULL, model TEXT NOT NULL, imageHash TEXT NOT NULL,
      imageBytes INTEGER NOT NULL, status TEXT NOT NULL, errorCode TEXT,
      latencyMs INTEGER, inputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER,
      responseJson TEXT, userId TEXT, mealPhotoRunId TEXT)`);
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

  const post = async (handler, body, userId = 'test-user') => {
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
    await handler({ body, userId }, res);
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
      db.prepare('SELECT status FROM meal_photo_runs ORDER BY createdAt DESC LIMIT 1').get().status,
    ).toBe('failed');
  });

  it('returns priced items and a total', async () => {
    const res = await post(handlerReturning({ items: [item('rice'), item('chicken')] }), { image });
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total.calories).toBe(320);
    expect(res.body.total.low).toBeLessThan(res.body.total.calories);
    expect(res.body.total.high).toBeGreaterThan(res.body.total.calories);
    expect(res.body.meta.usage.totalTokens).toBe(460);
    expect(res.body.estimateId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reads the photograph once', async () => {
    // Two calls were needed only to hold a database lookup against something.
    const visionHandler = vi.fn(async (_req, res) =>
      res.json({ data: { items: [item('rice')] }, meta: { model: 'm', promptVersion: '5' } }),
    );
    await post(createMealEstimateHandler({ db, visionHandler }), { image });
    expect(visionHandler).toHaveBeenCalledOnce();
    expect(visionHandler.mock.calls[0][0].body.task).toBe('meal');
  });

  it('gives the reading the description someone typed, and keeps it with the run', async () => {
    const visionHandler = vi.fn(async (_req, res) =>
      res.json({ data: { items: [item('white rice')] }, meta: { model: 'm', promptVersion: '5+hint' } }),
    );
    const res = await post(createMealEstimateHandler({ db, visionHandler }), {
      image,
      hint: '  white  rice  ',
    });

    expect(visionHandler.mock.calls[0][0].body.hint).toBe('  white  rice  ');
    // Normalized once for the record, so a hinted run can be told from an
    // unhinted one long after the photo is gone.
    expect(res.body.hint).toBe('white rice');
    expect(db.prepare('SELECT hint FROM meal_photo_runs WHERE id = ?').get(res.body.estimateId).hint).toBe(
      'white rice',
    );
  });

  it('chains a second reading of the same photograph to the first', async () => {
    const handler = handlerReturning({ items: [item('white rice')] });
    const first = await post(handler, { image });
    const second = await post(handler, {
      image,
      hint: 'white rice',
      previousEstimateId: first.body.estimateId,
    });

    expect(second.body.estimateId).not.toBe(first.body.estimateId);
    expect(
      db.prepare('SELECT previousRunId FROM meal_photo_runs WHERE id = ?').get(second.body.estimateId)
        .previousRunId,
    ).toBe(first.body.estimateId);
  });

  it('ignores a previous estimate that is not the caller’s', async () => {
    const handler = handlerReturning({ items: [item('white rice')] });
    const mine = await post(handler, { image });
    const res = await post(handler, { image, previousEstimateId: mine.body.estimateId }, 'mallory');

    expect(
      db.prepare('SELECT previousRunId FROM meal_photo_runs WHERE id = ?').get(res.body.estimateId)
        .previousRunId,
    ).toBeNull();
  });

  it('records no description when none was typed', async () => {
    const res = await post(handlerReturning({ items: [item('white rice')] }), { image, hint: '   ' });
    expect(res.body.hint).toBeNull();
    expect(
      db.prepare('SELECT hint FROM meal_photo_runs WHERE id = ?').get(res.body.estimateId).hint,
    ).toBeNull();
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

  it('passes a rate limit through rather than inventing a meal', async () => {
    const visionHandler = vi.fn(async (_req, res) =>
      res.status(429).json({ error: { code: 'rate_limited', message: 'model quota' } }),
    );
    const res = await post(createMealEstimateHandler({ db, visionHandler }), { image });

    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(visionHandler).toHaveBeenCalledOnce();
  });

  it('discards a run rejected before the model was ever reached', async () => {
    // Otherwise a client retrying against the daily limit fills the run table.
    const visionHandler = vi.fn(async (_req, res) =>
      res.status(429).json({ error: { code: 'quota_exceeded', message: 'daily limit' } }),
    );
    await post(createMealEstimateHandler({ db, visionHandler }), { image });
    expect(db.prepare('SELECT count(*) n FROM meal_photo_runs').get().n).toBe(0);
  });

  it('logs the call like any other', async () => {
    const res = await post(handlerReturning({ items: [item('white rice')] }), { image });
    expect(
      visionDb
        .prepare('SELECT task FROM vision_requests WHERE mealPhotoRunId = ?')
        .all(res.body.estimateId)
        .map((row) => row.task),
    ).toEqual(['meal']);
    expect(
      db.prepare('SELECT status FROM meal_photo_runs WHERE id = ?').get(res.body.estimateId).status,
    ).toBe('reviewing');
  });
});
