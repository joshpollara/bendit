import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assessLabel, createLabelExtractHandler, createLabelValidateHandler } from './labelRoute.mjs';
import { createVisionExtractHandler } from './visionRoute.mjs';
import { VisionError } from './vision.mjs';

// A clean US panel and its Dutch equivalent, as the model would return them.
const US_PANEL = {
  name: 'Rolled Oats',
  brand: 'Quaker',
  basis: 'g',
  servingLabel: '1/2 cup dry (40g)',
  servingGrams: 40,
  servingsPerContainer: 13,
  perServing: { calories: 150, protein: 5, carbs: 27, fat: 3, fiber: 4 },
  per100: null,
  confidence: 'high',
};

const MISREAD_PANEL = {
  ...US_PANEL,
  // 550 where the macros come to 155: a leading digit invented.
  perServing: { ...US_PANEL.perServing, calories: 550 },
};

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE vision_requests (
    id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, task TEXT NOT NULL,
    promptVersion TEXT NOT NULL, model TEXT NOT NULL, imageHash TEXT NOT NULL,
    imageBytes INTEGER NOT NULL, status TEXT NOT NULL, errorCode TEXT,
    latencyMs INTEGER, inputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER,
    responseJson TEXT, userId TEXT, mealPhotoRunId TEXT)`);
});

const providerReturning = (data) => ({
  configured: true,
  model: 'test-model',
  extract: vi.fn(async () => ({
    data,
    raw: JSON.stringify(data),
    model: 'test-model',
    latencyMs: 700,
    usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
  })),
});

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

const extractHandler = (provider) =>
  createLabelExtractHandler({
    visionHandler: createVisionExtractHandler({ db, provider, dailyLimit: 10 }),
  });

const post = async (handler, body) => {
  const res = fakeRes();
  await handler({ body }, res);
  return res;
};

const image = Buffer.from('a photo of a packet').toString('base64');

describe('POST /api/labels/extract', () => {
  it('turns a photographed panel into a food ready to save', async () => {
    const res = await post(extractHandler(providerReturning(US_PANEL)), { image });
    expect(res.statusCode).toBe(200);
    expect(res.body.food.name).toBe('Rolled Oats');
    expect(res.body.food.kcal100).toBe(375); // 150 kcal in 40 g
    expect(res.body.food.servingLabel).toBe('1/2 cup dry (40g)');
    expect(res.body.food.caloriesPerServing).toBe(150);
    expect(res.body.issues).toEqual([]);
    expect(res.body.confidence).toBe('high');
    expect(res.body.source).toBe('vision');
  });

  it('passes the cost of the call back with the result', async () => {
    const res = await post(extractHandler(providerReturning(US_PANEL)), { image });
    expect(res.body.meta.usage.totalTokens).toBe(340);
    expect(res.body.meta.promptVersion).toBeTruthy();
  });

  it('flags a misread figure and names the field', async () => {
    const res = await post(extractHandler(providerReturning(MISREAD_PANEL)), { image });
    expect(res.body.issues.map((i) => i.field)).toContain('perServing.calories');
    expect(res.body.confidence).toBe('low');
    // Still returned: the user is holding the packet and can correct it.
    expect(res.body.food).toBeTruthy();
  });

  it('never claims high confidence when nothing could be cross-checked', async () => {
    const noMacros = {
      ...US_PANEL,
      perServing: { calories: 150, protein: null, carbs: null, fat: null },
      confidence: 'high',
    };
    const res = await post(extractHandler(providerReturning(noMacros)), { image });
    expect(res.body.confidence).toBe('medium');
  });

  it('keeps the model’s own doubt', async () => {
    const blurred = { ...US_PANEL, confidence: 'low' };
    const res = await post(extractHandler(providerReturning(blurred)), { image });
    expect(res.body.confidence).toBe('low');
  });

  it('attaches the barcode so the next scan of this packet is a hit', async () => {
    const res = await post(extractHandler(providerReturning(US_PANEL)), {
      image,
      barcode: '8712345678906',
    });
    expect(res.body.food.barcode).toBe('8712345678906');
  });

  it('passes a provider failure straight through, typed', async () => {
    const failing = {
      configured: true,
      model: 'test-model',
      extract: async () => {
        throw new VisionError('timeout', 'too slow', { retryable: true });
      },
    };
    const res = await post(extractHandler(failing), { image });
    expect(res.statusCode).toBe(504);
    expect(res.body.error.code).toBe('timeout');
  });

  it('passes the quota refusal through, so the client can fall back to OCR', async () => {
    const provider = providerReturning(US_PANEL);
    const handler = createLabelExtractHandler({
      visionHandler: createVisionExtractHandler({ db, provider, dailyLimit: 1 }),
    });
    await post(handler, { image });
    const res = await post(handler, { image });
    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('quota_exceeded');
  });

  it('counts a label read against the vision log like any other call', async () => {
    await post(extractHandler(providerReturning(US_PANEL)), { image });
    const row = db.prepare('SELECT * FROM vision_requests').get();
    expect(row.task).toBe('label');
    expect(row.status).toBe('ok');
  });
});

describe('POST /api/labels/validate — the offline path', () => {
  const handler = createLabelValidateHandler();

  it('holds an on-device OCR read to the same arithmetic', async () => {
    const res = await post(handler, { label: MISREAD_PANEL, source: 'ocr' });
    expect(res.body.issues.map((i) => i.field)).toContain('perServing.calories');
    expect(res.body.confidence).toBe('low');
    expect(res.body.source).toBe('ocr');
  });

  it('builds the same food a photo read would have', async () => {
    const online = assessLabel(US_PANEL, { source: 'vision' });
    const res = await post(handler, { label: US_PANEL, source: 'ocr' });
    expect(res.body.food.kcal100).toBe(online.food.kcal100);
    expect(res.body.food.servings).toEqual(online.food.servings);
  });

  it('costs nothing — no model is involved', async () => {
    await post(handler, { label: US_PANEL, source: 'ocr' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM vision_requests').get().n).toBe(0);
  });

  it('refuses a request with no label', async () => {
    const res = await post(handler, {});
    expect(res.statusCode).toBe(400);
  });

  it('reports honestly when a reading cannot become a food', async () => {
    // A portion column with no weight: nothing can be scaled from it.
    const res = await post(handler, {
      label: { basis: 'g', servingLabel: '1 bar', perServing: { calories: 150, protein: 5, carbs: 20, fat: 5 } },
    });
    expect(res.body.food).toBeNull();
    expect(res.body.ok).toBe(false);
    expect(res.body.confidence).toBe('low');
  });
});
