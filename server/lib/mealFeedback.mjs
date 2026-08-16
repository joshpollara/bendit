// Durable, photo-free feedback for meal estimates.
//
// A run joins the two model calls, the reconciled result, the user's final
// corrections and the food-log rows created from them. Images never enter this
// table; every client field is normalized into a small, versioned shape.

import crypto from 'node:crypto';

const SCHEMA_VERSION = 1;
const TERMINAL_OUTCOMES = new Set(['logged', 'dismissed', 'retake', 'barcode']);
const OUTCOMES = TERMINAL_OUTCOMES;
const RATINGS = new Set(['close', 'needed_edits', 'way_off']);
const ISSUES = new Set([
  'wrong_food',
  'portion_off',
  'food_missing',
  'extra_food',
  'sauce_preparation',
  'calories_macros',
]);
const ACTIONS = new Set([
  'question_answered',
  'item_food_changed',
  'item_amount_changed',
  'item_calories_changed',
  'item_added',
  'item_removed',
]);
const MEALS = new Set(['breakfast', 'lunch', 'dinner', 'snacks']);

const round = (value, digits = 1) =>
  Math.round((Number(value) + Number.EPSILON) * 10 ** digits) / 10 ** digits;

class FeedbackError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FeedbackError(`${label} must be an object.`);
  }
  return value;
}

function allowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new FeedbackError(`${label} contains an unsupported field: ${key}.`);
  }
}

function suspiciousText(value) {
  return /data:image\//i.test(value) ||
    (value.length >= 180 && /^[A-Za-z0-9+/=]+$/.test(value));
}

function text(value, label, { max, nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string') throw new FeedbackError(`${label} must be text.`);
  const clean = value.trim();
  if (!clean && !nullable) throw new FeedbackError(`${label} is required.`);
  if (clean.length > max) throw new FeedbackError(`${label} is too long.`);
  if (suspiciousText(clean)) throw new FeedbackError(`${label} cannot contain image data.`);
  return clean || null;
}

function number(value, label, { min = 0, max = 10_000, nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new FeedbackError(`${label} is outside the supported range.`);
  }
  return value;
}

function sameNumber(left, right) {
  return Math.abs(Number(left) - Number(right)) <= 0.11;
}

function normalizeFinalItem(value, index) {
  const item = object(value, `final.items[${index}]`);
  allowedKeys(
    item,
    new Set([
      'id',
      'kind',
      'foodId',
      'name',
      'grams',
      'calories',
      'protein',
      'carbs',
      'fat',
      'low',
      'high',
    ]),
    `final.items[${index}]`,
  );

  const calories = number(item.calories, `final.items[${index}].calories`, { nullable: true });
  const low = number(item.low, `final.items[${index}].low`, { nullable: true });
  const high = number(item.high, `final.items[${index}].high`, { nullable: true });
  if ((low == null) !== (high == null)) {
    throw new FeedbackError(`final.items[${index}] needs both range bounds or neither.`);
  }
  if (calories == null && (low != null || high != null)) {
    throw new FeedbackError(`final.items[${index}] cannot range calories it does not have.`);
  }
  if (calories != null && low != null && !(low <= calories && calories <= high)) {
    throw new FeedbackError(`final.items[${index}] has an invalid calorie range.`);
  }
  if (item.kind !== 'food' && item.kind !== 'adjustment') {
    throw new FeedbackError(`final.items[${index}].kind is not supported.`);
  }
  const grams = number(item.grams, `final.items[${index}].grams`, { max: 5_000 });
  if (item.kind === 'food' && calories != null && !(grams > 0)) {
    throw new FeedbackError(`final.items[${index}] needs a positive food amount.`);
  }

  return {
    id: text(item.id, `final.items[${index}].id`, { max: 80 }),
    kind: item.kind,
    foodId: text(item.foodId, `final.items[${index}].foodId`, { max: 160, nullable: true }),
    name: text(item.name, `final.items[${index}].name`, { max: 120 }),
    grams,
    calories,
    protein: number(item.protein, `final.items[${index}].protein`, {
      max: 5_000,
      nullable: true,
    }),
    carbs: number(item.carbs, `final.items[${index}].carbs`, { max: 5_000, nullable: true }),
    fat: number(item.fat, `final.items[${index}].fat`, { max: 5_000, nullable: true }),
    low,
    high,
  };
}

function totalsFrom(items) {
  const sum = (pick) => items.reduce((total, item) => total + (pick(item) ?? 0), 0);
  return {
    calories: Math.round(sum((item) => item.calories)),
    protein: round(sum((item) => item.protein)),
    carbs: round(sum((item) => item.carbs)),
    fat: round(sum((item) => item.fat)),
    low: Math.round(sum((item) => item.low ?? item.calories)),
    high: Math.round(sum((item) => item.high ?? item.calories)),
  };
}

function normalizeFinal(value, outcome) {
  if (outcome !== 'logged') {
    if (value != null) throw new FeedbackError('Only a logged meal may include final items.');
    return null;
  }
  if (value == null) {
    throw new FeedbackError('A logged meal needs its final items.');
  }
  const final = object(value, 'final');
  allowedKeys(final, new Set(['meal', 'total', 'items']), 'final');
  if (!MEALS.has(final.meal)) throw new FeedbackError('final.meal is not supported.');
  if (!Array.isArray(final.items) || final.items.length > 20) {
    throw new FeedbackError('final.items must contain at most 20 items.');
  }
  const items = final.items.map(normalizeFinalItem);
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new FeedbackError('final item ids must be unique.');
  }
  if (outcome === 'logged' && !items.some((item) => item.calories != null)) {
    throw new FeedbackError('A logged meal needs at least one item with calories.');
  }

  const supplied = object(final.total, 'final.total');
  allowedKeys(supplied, new Set(['calories', 'protein', 'carbs', 'fat', 'low', 'high']), 'final.total');
  const expected = totalsFrom(items);
  for (const key of Object.keys(expected)) {
    number(supplied[key], `final.total.${key}`, { max: key === 'calories' || key === 'low' || key === 'high' ? 10_000 : 5_000 });
    if (!sameNumber(supplied[key], expected[key])) {
      throw new FeedbackError(`final.total.${key} does not match the final items.`);
    }
  }
  if (!(expected.low <= expected.calories && expected.calories <= expected.high)) {
    throw new FeedbackError('final.total has an invalid calorie range.');
  }
  return { meal: final.meal, total: expected, items };
}

function normalizeActions(value) {
  if (!Array.isArray(value) || value.length > 50) {
    throw new FeedbackError('actions must contain at most 50 entries.');
  }
  const seen = new Set();
  const actions = [];
  for (let index = 0; index < value.length; index++) {
    const action = object(value[index], `actions[${index}]`);
    allowedKeys(action, new Set(['type', 'itemId', 'choiceId']), `actions[${index}]`);
    if (!ACTIONS.has(action.type)) throw new FeedbackError(`actions[${index}].type is not supported.`);
    const itemId = text(action.itemId, `actions[${index}].itemId`, { max: 80 });
    const choiceId = text(action.choiceId, `actions[${index}].choiceId`, {
      max: 80,
      nullable: action.type !== 'question_answered',
    });
    if (action.type !== 'question_answered' && choiceId != null) {
      throw new FeedbackError(`actions[${index}].choiceId only belongs to a question answer.`);
    }
    const key = `${action.type}\u0000${itemId}\u0000${choiceId ?? ''}`;
    if (!seen.has(key)) actions.push({ type: action.type, itemId, ...(choiceId ? { choiceId } : {}) });
    seen.add(key);
  }
  return actions;
}

export function normalizeMealFeedback(value) {
  const body = object(value, 'feedback');
  allowedKeys(body, new Set(['outcome', 'rating', 'issues', 'note', 'actions', 'final']), 'feedback');
  if (!OUTCOMES.has(body.outcome)) throw new FeedbackError('feedback.outcome is not supported.');
  const rating = body.rating == null ? null : body.rating;
  if (rating != null && !RATINGS.has(rating)) throw new FeedbackError('feedback.rating is not supported.');
  if (!Array.isArray(body.issues) || body.issues.length > ISSUES.size) {
    throw new FeedbackError('feedback.issues is not supported.');
  }
  const issues = [...new Set(body.issues)];
  if (issues.some((issue) => !ISSUES.has(issue))) throw new FeedbackError('feedback.issues is not supported.');
  const negative = rating === 'needed_edits' || rating === 'way_off';
  if (!negative && issues.length) throw new FeedbackError('Issue tags require a negative rating.');
  const note = text(body.note, 'feedback.note', { max: 500, nullable: true });
  if (!negative && note != null) throw new FeedbackError('A note requires a negative rating.');

  return {
    outcome: body.outcome,
    rating,
    issues,
    note,
    actions: normalizeActions(body.actions ?? []),
    final: normalizeFinal(body.final, body.outcome),
  };
}

function compactInitialItem(item) {
  return {
    id: String(item?.id ?? '').slice(0, 80),
    kind: item?.kind === 'adjustment' ? 'adjustment' : 'food',
    name: String(item?.food?.name ?? item?.name ?? '').slice(0, 120),
    foodId: item?.food?.id ?? null,
    source: item?.food?.source ?? null,
    grams: Number(item?.grams) || 0,
    portionG: item?.portionG ?? null,
    calories: item?.nutrition?.calories ?? null,
    protein: item?.nutrition?.protein ?? null,
    carbs: item?.nutrition?.carbs ?? null,
    fat: item?.nutrition?.fat ?? null,
    low: item?.range?.low ?? null,
    high: item?.range?.high ?? null,
    confidence: item?.confidence ?? null,
  };
}

export function compactInitialEstimate(estimate) {
  return {
    status: estimate?.status ?? 'ready',
    mealType: estimate?.mealType ?? 'other',
    items: Array.isArray(estimate?.items) ? estimate.items.slice(0, 20).map(compactInitialItem) : [],
    total: estimate?.total ?? null,
    unmatched: estimate?.unmatched ?? 0,
    captureQuality: estimate?.captureQuality ?? null,
    question: estimate?.question
      ? {
          id: estimate.question.id,
          targetItemId: estimate.question.targetItemId,
          expectedReductionKcal: estimate.question.expectedReductionKcal,
          choices: estimate.question.choices?.map((choice) => ({ id: choice.id, grams: choice.grams })) ?? [],
        }
      : null,
    path: estimate?.path ?? null,
    uncertaintyReasons: Array.isArray(estimate?.uncertaintyReasons)
      ? estimate.uncertaintyReasons.slice(0, 8).map((reason) => String(reason).slice(0, 240))
      : [],
  };
}

export function createMealPhotoTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meal_photo_runs (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      status TEXT NOT NULL,
      schemaVersion INTEGER NOT NULL,
      parserRequestId TEXT,
      holisticRequestId TEXT,
      initialJson TEXT,
      finalJson TEXT,
      rating TEXT,
      issuesJson TEXT,
      note TEXT,
      actionsJson TEXT,
      derivedJson TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meal_photo_runs_user_created
      ON meal_photo_runs(userId, createdAt);
  `);
}

export function createMealPhotoRunStore(db) {
  createMealPhotoTables(db);
  const insert = db.prepare(`INSERT INTO meal_photo_runs
    (id, userId, createdAt, updatedAt, status, schemaVersion)
    VALUES (@id, @userId, @createdAt, @createdAt, 'analyzing', @schemaVersion)`);
  const ready = db.prepare(`UPDATE meal_photo_runs SET
    updatedAt = @updatedAt, status = 'reviewing', parserRequestId = @parserRequestId,
    holisticRequestId = @holisticRequestId, initialJson = @initialJson
    WHERE id = @id AND status = 'analyzing'`);
  const failed = db.prepare(`UPDATE meal_photo_runs SET
    updatedAt = @updatedAt, status = 'failed', parserRequestId = @parserRequestId,
    holisticRequestId = @holisticRequestId
    WHERE id = @id AND status = 'analyzing'`);
  const discard = db.prepare("DELETE FROM meal_photo_runs WHERE id = ? AND status = 'analyzing'");

  return {
    start(userId) {
      const run = {
        id: crypto.randomUUID(),
        userId,
        createdAt: new Date().toISOString(),
        schemaVersion: SCHEMA_VERSION,
      };
      insert.run(run);
      return run.id;
    },
    ready(id, { parserRequestId = null, holisticRequestId = null, estimate }) {
      ready.run({
        id,
        updatedAt: new Date().toISOString(),
        parserRequestId,
        holisticRequestId,
        initialJson: JSON.stringify(compactInitialEstimate(estimate)),
      });
    },
    failed(id, { parserRequestId = null, holisticRequestId = null } = {}) {
      failed.run({ id, updatedAt: new Date().toISOString(), parserRequestId, holisticRequestId });
    },
    discard(id) {
      discard.run(id);
    },
  };
}

function deriveChanges(initial, final, actions) {
  if (!final) return null;
  const before = new Map((initial?.items ?? []).map((item) => [item.id, item]));
  const after = new Map(final.items.map((item) => [item.id, item]));
  let identityChanged = 0;
  let portionChanged = 0;
  let caloriesChanged = 0;
  for (const [id, item] of after) {
    const original = before.get(id);
    if (!original) continue;
    if ((original.foodId ?? null) !== (item.foodId ?? null)) identityChanged++;
    if (!sameNumber(original.grams ?? 0, item.grams ?? 0)) portionChanged++;
    if (!sameNumber(original.calories ?? 0, item.calories ?? 0)) caloriesChanged++;
  }
  return {
    initialCalories: Math.round(initial?.total?.calories ?? 0),
    finalCalories: final.total.calories,
    calorieDelta: final.total.calories - Math.round(initial?.total?.calories ?? 0),
    itemsAdded: [...after.keys()].filter((id) => !before.has(id)).length,
    itemsRemoved: [...before.keys()].filter((id) => !after.has(id)).length,
    identityChanged,
    portionChanged,
    caloriesChanged,
    actionTypes: [...new Set(actions.map((action) => action.type))],
  };
}

function storedFeedback(row) {
  return {
    outcome: row.status,
    rating: row.rating ?? null,
    issues: JSON.parse(row.issuesJson ?? '[]'),
    note: row.note ?? null,
    actions: JSON.parse(row.actionsJson ?? '[]'),
    final: row.finalJson ? JSON.parse(row.finalJson) : null,
  };
}

const canonical = (feedback) => JSON.stringify(feedback);

export function createMealFeedbackHandler({ db }) {
  createMealPhotoTables(db);
  const find = db.prepare('SELECT * FROM meal_photo_runs WHERE id = ? AND userId = ?');
  const update = db.prepare(`UPDATE meal_photo_runs SET
    updatedAt = @updatedAt, status = @outcome, rating = @rating,
    issuesJson = @issuesJson, note = @note, actionsJson = @actionsJson,
    finalJson = @finalJson, derivedJson = @derivedJson
    WHERE id = @id AND userId = @userId AND status = 'reviewing'`);

  return function mealFeedbackHandler(req, res) {
    const row = find.get(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.status === 'analyzing' || row.status === 'failed') {
      return res.status(409).json({ error: 'That estimate is not available for review.' });
    }

    let feedback;
    try {
      feedback = normalizeMealFeedback(req.body);
    } catch (error) {
      return res.status(error?.status ?? 400).json({ error: error?.message ?? 'Invalid feedback.' });
    }

    if (TERMINAL_OUTCOMES.has(row.status)) {
      if (row.status === feedback.outcome && canonical(storedFeedback(row)) === canonical(feedback)) {
        return res.json({ ok: true, estimateId: row.id, feedback });
      }
      return res.status(409).json({ error: 'That estimate already has a final outcome.' });
    }

    const initial = JSON.parse(row.initialJson ?? '{}');
    const derived = deriveChanges(initial, feedback.final, feedback.actions);
    const changed = update.run({
      id: row.id,
      userId: req.userId,
      updatedAt: new Date().toISOString(),
      outcome: feedback.outcome,
      rating: feedback.rating,
      issuesJson: JSON.stringify(feedback.issues),
      note: feedback.note,
      actionsJson: JSON.stringify(feedback.actions),
      finalJson: feedback.final ? JSON.stringify(feedback.final) : null,
      derivedJson: derived ? JSON.stringify(derived) : null,
    }).changes;
    if (changed === 0) {
      const current = find.get(row.id, req.userId);
      if (
        current &&
        TERMINAL_OUTCOMES.has(current.status) &&
        current.status === feedback.outcome &&
        canonical(storedFeedback(current)) === canonical(feedback)
      ) {
        return res.json({ ok: true, estimateId: row.id, feedback });
      }
      return res.status(409).json({ error: 'That estimate already has a final outcome.' });
    }
    return res.json({ ok: true, estimateId: row.id, feedback });
  };
}

export function validateMealPhotoLogLink(db, userId, runId, itemId) {
  if (runId == null && itemId == null) return { runId: null, itemId: null };
  if (runId == null || itemId == null) throw new FeedbackError('Meal photo links must be supplied together.');
  const cleanRunId = text(runId, 'mealPhotoRunId', { max: 80 });
  const cleanItemId = text(itemId, 'mealPhotoItemId', { max: 80 });
  const owned = db
    .prepare('SELECT status, initialJson, finalJson FROM meal_photo_runs WHERE id = ? AND userId = ?')
    .get(cleanRunId, userId);
  if (!owned) throw new FeedbackError('Meal photo estimate not found.', 404);
  if (owned.status !== 'reviewing' && owned.status !== 'logged') {
    throw new FeedbackError('That meal photo estimate cannot be logged.', 409);
  }
  const snapshot = owned.status === 'logged' ? owned.finalJson : owned.initialJson;
  const known = new Set((JSON.parse(snapshot ?? '{}').items ?? []).map((item) => item.id));
  const clientItemId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    cleanItemId,
  );
  if (!known.has(cleanItemId) && !(owned.status === 'reviewing' && clientItemId)) {
    throw new FeedbackError('Meal photo item not found.', 404);
  }
  return { runId: cleanRunId, itemId: cleanItemId };
}

/** Remove personal model output without erasing the usage rows that enforce quota. */
export function scrubVisionRequestsForUser(db, userId) {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vision_requests'")
    .get();
  if (!table) return 0;
  const columns = new Set(db.prepare('PRAGMA table_info(vision_requests)').all().map((column) => column.name));
  if (!columns.has('userId')) return 0;
  const assignments = ['userId = NULL'];
  if (columns.has('mealPhotoRunId')) assignments.push('mealPhotoRunId = NULL');
  if (columns.has('imageHash')) assignments.push("imageHash = ''");
  if (columns.has('responseJson')) assignments.push('responseJson = NULL');
  if (columns.has('status')) {
    assignments.push("status = CASE WHEN status = 'pending' THEN 'discarded' ELSE status END");
  }
  return db.prepare(`UPDATE vision_requests SET ${assignments.join(', ')} WHERE userId = ?`).run(userId).changes;
}
