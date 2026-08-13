// What the model has been asked to do, and what that came to.
//
// Every call is already written to vision_requests by the one route that makes
// them, successes and failures alike, so nothing new is recorded here. This
// reads that table back and adds the one thing it doesn't hold: money.
//
// Cost is worked out from the stored token counts and a rate per model. The
// provider doesn't report a price with the response, so this is an estimate of
// the bill rather than the bill — and it re-prices old calls at today's rates.
// A model with no entry in the table below is counted separately instead of
// being silently priced at zero.

/**
 * US dollars per million tokens, on the paid tier. These are the rates the
 * choice of model was made on; see the note at the top of vision.mjs. When the
 * model changes, or the provider's prices do, this is the one place to change.
 *
 * Output covers thinking as well as the answer, which is how the provider bills
 * it and how vision.mjs counts it — the Flash models here think, and the
 * thinking is usually the larger half.
 *
 * The Flash rates are introductory and end on 31 December 2026, after which
 * they double. A model priced from this table is being priced at today's rate,
 * not the rate on the day it ran.
 */
export const MODEL_PRICES = {
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  // Dominated by 3.7-flash on both axes while the introductory rate holds.
  'gemini-3.5-flash': { input: 1.5, output: 9 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75 },
  'gemini-3.7-flash': { input: 0.75, output: 3.75 },
  // Prompts over 200k tokens cost more; a photograph is nowhere near it.
  'gemini-3.1-pro-preview': { input: 2, output: 12 },
};

/** The last calls listed one by one, newest first. */
const RECENT_LIMIT = 50;

/** Task and error breakdowns cover this many days; the windows cover the rest. */
const BREAKDOWN_DAYS = 30;

// Days are UTC days, which is what the server writes and what the daily quota
// already resets on.
const WINDOWS = [
  { key: 'today', label: 'Today', days: 1 },
  { key: 'week', label: 'Last 7 days', days: 7 },
  { key: 'month', label: 'Last 30 days', days: 30 },
  { key: 'all', label: 'All time', days: null },
];

/** `days` back from a YYYY-MM-DD date, as another YYYY-MM-DD date. */
export function shiftDate(date, days) {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** What one call cost, or null if this server has no rate for that model. */
export function costOf(row) {
  const price = MODEL_PRICES[row.model];
  if (!price) return null;
  return ((row.inputTokens ?? 0) * price.input + (row.outputTokens ?? 0) * price.output) / 1e6;
}

/** True for a call that spent tokens this server can't put a price on. */
const unpriced = (row) => !MODEL_PRICES[row.model] && Boolean(row.inputTokens || row.outputTokens);

const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);

/** Nearest-rank percentile of an already-sorted list; null if there's nothing. */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function tally(rows) {
  const errors = rows.filter((row) => row.status !== 'ok');
  // A failed call has no latency worth averaging — a timeout would drag the
  // typical read up to the timeout itself.
  const latencies = rows
    .filter((row) => row.status === 'ok' && typeof row.latencyMs === 'number')
    .map((row) => row.latencyMs)
    .sort((a, b) => a - b);

  return {
    calls: rows.length,
    ok: rows.length - errors.length,
    errors: errors.length,
    inputTokens: sum(rows, (row) => row.inputTokens),
    outputTokens: sum(rows, (row) => row.outputTokens),
    costUsd: sum(rows, costOf),
    unpricedCalls: rows.filter(unpriced).length,
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

/** Groups rows by one field, biggest group first. */
function groupBy(rows, pick) {
  const groups = new Map();
  for (const row of rows) {
    const key = pick(row);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups]
    .map(([key, group]) => ({ key, ...tally(group) }))
    .sort((a, b) => b.calls - a.calls);
}

/**
 * The whole picture, from the logged rows and nothing else. Pure, so the shape
 * of a month's usage can be tested without a month of calls.
 *
 * `rows` may arrive in any order; `today` is a YYYY-MM-DD UTC date.
 */
export function summarizeVisionUsage(rows, { today, dailyLimit, model, provider, configured }) {
  const windows = {};
  for (const { key, label, days } of WINDOWS) {
    // '' sorts below every timestamp, which is what "all time" means here.
    const from = days ? shiftDate(today, -(days - 1)) : '';
    windows[key] = { label, from: from || null, ...tally(rows.filter((r) => r.createdAt >= from)) };
  }

  const recentFrom = shiftDate(today, -(BREAKDOWN_DAYS - 1));
  const recent = rows.filter((row) => row.createdAt >= recentFrom);
  const newestFirst = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return {
    provider,
    model,
    configured,
    dailyLimit,
    usedToday: windows.today.calls,
    remainingToday: Math.max(0, dailyLimit - windows.today.calls),
    prices: MODEL_PRICES,
    windows,
    breakdownDays: BREAKDOWN_DAYS,
    byTask: groupBy(recent, (row) => row.task).map(({ key, ...rest }) => ({ task: key, ...rest })),
    byError: groupBy(
      recent.filter((row) => row.status !== 'ok'),
      (row) => row.errorCode ?? 'unknown',
    ).map(({ key, calls }) => ({ code: key, calls })),
    byModel: groupBy(rows, (row) => row.model).map(({ key, ...rest }) => ({
      model: key,
      priced: Boolean(MODEL_PRICES[key]),
      ...rest,
    })),
    recent: newestFirst.slice(0, RECENT_LIMIT).map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      task: row.task,
      model: row.model,
      status: row.status,
      errorCode: row.errorCode,
      latencyMs: row.latencyMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: costOf(row),
    })),
  };
}

/**
 * Builds the GET /api/vision/usage handler. Reads only; the response carries no
 * model output and no image, just counts.
 */
export function createVisionUsageHandler({ db, provider, dailyLimit = 100 }) {
  // responseJson is deliberately not selected: it is the largest column in the
  // table and none of this needs it.
  const selectAll = db.prepare(`
    SELECT id, createdAt, task, model, status, errorCode, latencyMs, inputTokens, outputTokens
    FROM vision_requests ORDER BY createdAt DESC`);

  return function usage(_req, res) {
    res.json(
      summarizeVisionUsage(selectAll.all(), {
        today: new Date().toISOString().slice(0, 10),
        dailyLimit,
        model: provider.model,
        provider: provider.name,
        configured: provider.configured,
      }),
    );
  };
}
