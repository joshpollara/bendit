import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMealFeedbackHandler,
  createMealPhotoRunStore,
  scrubVisionRequestsForUser,
  validateMealPhotoLogLink,
} from './mealFeedback.mjs';

let db;
let estimateId;

const initialEstimate = {
  status: 'ready',
  mealType: 'simple_plate',
  items: [
    {
      id: 'rice',
      kind: 'food',
      name: 'white rice',
      grams: 100,
      portionG: { low: 80, median: 100, high: 120 },
      confidence: 'medium',
      food: { id: 'seed-rice', name: 'White rice, cooked', source: 'seed' },
      nutrition: { calories: 130, protein: 2.7, carbs: 28.2, fat: 0.3 },
      range: { low: 104, high: 156 },
    },
  ],
  total: { calories: 130, protein: 2.7, carbs: 28.2, fat: 0.3, low: 104, high: 156 },
  unmatched: 0,
  question: {
    id: 'portion:rice',
    targetItemId: 'rice',
    expectedReductionKcal: 90,
    choices: [{ id: 'small', label: 'Small', grams: 80 }],
  },
  path: {
    selected: 'hybrid',
    database: { calories: 130, low: 104, high: 156, matchedItems: 1, totalItems: 1 },
    holistic: { calories: 140, low: 100, high: 180 },
    disagreementKcal: 10,
  },
};

const feedback = {
  outcome: 'logged',
  rating: 'needed_edits',
  issues: ['portion_off'],
  note: 'Bowl was larger.',
  actions: [{ type: 'item_amount_changed', itemId: 'rice' }],
  final: {
    meal: 'dinner',
    total: { calories: 195, protein: 4.1, carbs: 42.3, fat: 0.5, low: 195, high: 195 },
    items: [
      {
        id: 'rice',
        kind: 'food',
        foodId: 'seed-rice',
        name: 'White rice, cooked',
        grams: 150,
        calories: 195,
        protein: 4.1,
        carbs: 42.3,
        fat: 0.5,
        low: 195,
        high: 195,
      },
    ],
  },
};

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function put(body, { userId = 'alice', id = estimateId } = {}) {
  const res = fakeRes();
  createMealFeedbackHandler({ db })({ params: { id }, userId, body }, res);
  return res;
}

beforeEach(() => {
  db = new Database(':memory:');
  const runs = createMealPhotoRunStore(db);
  estimateId = runs.start('alice');
  runs.ready(estimateId, {
    parserRequestId: 'parser-request',
    holisticRequestId: 'holistic-request',
    estimate: initialEstimate,
  });
});

describe('meal photo runs', () => {
  it('stores the server result and both independent request links without a photo', () => {
    const row = db.prepare('SELECT * FROM meal_photo_runs WHERE id = ?').get(estimateId);
    expect(row).toMatchObject({
      userId: 'alice',
      status: 'reviewing',
      parserRequestId: 'parser-request',
      holisticRequestId: 'holistic-request',
    });
    expect(JSON.parse(row.initialJson).items[0]).toMatchObject({
      id: 'rice',
      foodId: 'seed-rice',
      calories: 130,
    });
    expect(row.initialJson).not.toMatch(/base64|data:image/i);
  });

  it('persists compact feedback and server-derived correction deltas', () => {
    const res = put(feedback);
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT * FROM meal_photo_runs WHERE id = ?').get(estimateId);
    expect(row.status).toBe('logged');
    expect(JSON.parse(row.finalJson).items[0]).toEqual(feedback.final.items[0]);
    expect(JSON.parse(row.derivedJson)).toMatchObject({
      initialCalories: 130,
      finalCalories: 195,
      calorieDelta: 65,
      portionChanged: 1,
    });
  });

  it('is idempotent for the same terminal outcome and rejects a conflicting one', () => {
    expect(put(feedback).statusCode).toBe(200);
    expect(put(feedback).statusCode).toBe(200);
    expect(put({ ...feedback, outcome: 'dismissed', final: null }).statusCode).toBe(409);
  });

  it('never lets another account write the feedback', () => {
    expect(put(feedback, { userId: 'bob' }).statusCode).toBe(404);
    expect(db.prepare('SELECT status FROM meal_photo_runs WHERE id = ?').get(estimateId).status).toBe(
      'reviewing',
    );
  });

  it('rejects image-bearing and unknown fields at every payload boundary', () => {
    expect(put({ ...feedback, image: 'not allowed' }).statusCode).toBe(400);
    const withNestedImage = {
      ...feedback,
      final: {
        ...feedback.final,
        items: [{ ...feedback.final.items[0], imageBase64: 'abc' }],
      },
    };
    expect(put(withNestedImage).statusCode).toBe(400);
    expect(put({ ...feedback, note: `data:image/jpeg;base64,${'a'.repeat(220)}` }).statusCode).toBe(400);
  });

  it('rejects client totals that disagree with the normalized items', () => {
    const wrong = {
      ...feedback,
      final: { ...feedback.final, total: { ...feedback.final.total, calories: 999 } },
    };
    expect(put(wrong).statusCode).toBe(400);
  });

  it('stores no final meal snapshot for a non-logged outcome', () => {
    const minimal = { ...feedback, outcome: 'retake', final: null };
    expect(put(minimal).statusCode).toBe(200);
    expect(db.prepare('SELECT finalJson FROM meal_photo_runs WHERE id = ?').get(estimateId).finalJson).toBeNull();
  });

  it('rejects a final meal snapshot for a non-logged outcome', () => {
    expect(put({ ...feedback, outcome: 'dismissed' }).statusCode).toBe(400);
  });

  it('closes a run that was read again with a description', () => {
    const reread = { ...feedback, outcome: 'reanalyzed', final: null };
    expect(put(reread).statusCode).toBe(200);
    expect(db.prepare('SELECT status FROM meal_photo_runs WHERE id = ?').get(estimateId).status).toBe(
      'reanalyzed',
    );
    // Still terminal: whatever happens on the second reading belongs to the
    // second run, not to this one.
    expect(put(feedback).statusCode).toBe(409);
  });
});

describe('a second reading of the same photograph', () => {
  it('links to the run it replaces, and only when that run is the caller’s', () => {
    const runs = createMealPhotoRunStore(db);
    expect(runs.priorRun('alice', estimateId)).toBe(estimateId);
    expect(runs.priorRun('mallory', estimateId)).toBeNull();
    expect(runs.priorRun('alice', 'no-such-run')).toBeNull();
    expect(runs.priorRun('alice', undefined)).toBeNull();

    const second = runs.start('alice', { hint: 'kalfsvlees', previousRunId: estimateId });
    expect(db.prepare('SELECT hint, previousRunId FROM meal_photo_runs WHERE id = ?').get(second)).toEqual({
      hint: 'kalfsvlees',
      previousRunId: estimateId,
    });
  });
});

describe('meal photo links', () => {
  it('accepts a complete owned link and rejects partial or foreign links', () => {
    expect(validateMealPhotoLogLink(db, 'alice', estimateId, 'rice')).toEqual({
      runId: estimateId,
      itemId: 'rice',
    });
    expect(() => validateMealPhotoLogLink(db, 'alice', estimateId, null)).toThrow(/together/i);
    expect(() => validateMealPhotoLogLink(db, 'bob', estimateId, 'rice')).toThrow(/not found/i);
    expect(() => validateMealPhotoLogLink(db, 'alice', estimateId, 'made-up-item')).toThrow(/item not found/i);
  });

  it('allows a new client UUID while reviewing, then validates the stored final items once logged', () => {
    const added = 'f0dfe149-f799-42e9-99a9-3b0f0d93ed5a';
    expect(validateMealPhotoLogLink(db, 'alice', estimateId, added).itemId).toBe(added);
    expect(put(feedback).statusCode).toBe(200);
    expect(validateMealPhotoLogLink(db, 'alice', estimateId, 'rice').itemId).toBe('rice');
    expect(() => validateMealPhotoLogLink(db, 'alice', estimateId, added)).toThrow(/item not found/i);
  });

  it('does not link food logs to failed or abandoned runs', () => {
    db.prepare("UPDATE meal_photo_runs SET status = 'failed' WHERE id = ?").run(estimateId);
    expect(() => validateMealPhotoLogLink(db, 'alice', estimateId, 'rice')).toThrow(/cannot be logged/i);
  });
});

describe('vision request privacy', () => {
  it('scrubs personal fields while retaining the row used by quota accounting', () => {
    db.exec(`CREATE TABLE vision_requests (
      id TEXT PRIMARY KEY, userId TEXT, mealPhotoRunId TEXT, imageHash TEXT NOT NULL,
      responseJson TEXT, task TEXT, model TEXT, totalTokens INTEGER
    )`);
    db.prepare('INSERT INTO vision_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'request',
      'alice',
      estimateId,
      'private-hash',
      '{"meal":"rice"}',
      'meal',
      'test-model',
      100,
    );

    expect(scrubVisionRequestsForUser(db, 'alice')).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM vision_requests').get().n).toBe(1);
    expect(db.prepare('SELECT * FROM vision_requests').get()).toMatchObject({
      userId: null,
      mealPhotoRunId: null,
      imageHash: '',
      responseJson: null,
      totalTokens: 100,
    });
  });
});
