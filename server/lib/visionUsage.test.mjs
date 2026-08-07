import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { costOf, createVisionUsageHandler, summarizeVisionUsage } from './visionUsage.mjs';

// The summary is a pure function of the logged rows, so a month of usage can be
// tested without a month of calls — or a single call to a paid model.

const TODAY = '2026-08-07';

/** A logged call. Tokens default to the measured size of a real label read. */
const call = (over = {}) => ({
  id: `id-${Math.round(Math.random() * 1e9)}`,
  createdAt: `${TODAY}T09:00:00.000Z`,
  task: 'label',
  model: 'gemini-3.1-flash-lite',
  status: 'ok',
  errorCode: null,
  latencyMs: 800,
  inputTokens: 1400,
  outputTokens: 100,
  ...over,
});

const summarize = (rows, over = {}) =>
  summarizeVisionUsage(rows, {
    today: TODAY,
    dailyLimit: 100,
    model: 'gemini-3.1-flash-lite',
    provider: 'gemini',
    configured: true,
    ...over,
  });

describe('costOf', () => {
  it('prices a call from its tokens', () => {
    // 1,400 in at $0.25/M and 100 out at $1.50/M.
    expect(costOf(call())).toBeCloseTo(0.0005, 6);
  });

  it('returns nothing for a model it has no rate for', () => {
    expect(costOf(call({ model: 'some-future-model' }))).toBeNull();
  });

  it('treats a failed call with no tokens as free', () => {
    expect(costOf(call({ status: 'error', inputTokens: null, outputTokens: null }))).toBe(0);
  });
});

describe('summarizeVisionUsage', () => {
  it('counts today separately from the rest', () => {
    const summary = summarize([
      call(),
      call(),
      call({ createdAt: '2026-08-05T09:00:00.000Z' }),
      call({ createdAt: '2026-06-01T09:00:00.000Z' }),
    ]);

    expect(summary.windows.today.calls).toBe(2);
    expect(summary.windows.week.calls).toBe(3);
    expect(summary.windows.month.calls).toBe(3);
    expect(summary.windows.all.calls).toBe(4);
  });

  it('includes the whole of the earliest day in a window', () => {
    // Seven days means today and the six before it, not 168 hours.
    const summary = summarize([
      call({ createdAt: '2026-08-01T00:00:01.000Z' }),
      call({ createdAt: '2026-07-31T23:59:59.000Z' }),
    ]);
    expect(summary.windows.week.calls).toBe(1);
    expect(summary.windows.week.from).toBe('2026-08-01');
  });

  it('adds up tokens and what they cost', () => {
    const summary = summarize([call(), call()]);
    expect(summary.windows.today.inputTokens).toBe(2800);
    expect(summary.windows.today.outputTokens).toBe(200);
    expect(summary.windows.today.costUsd).toBeCloseTo(0.001, 6);
  });

  it('counts calls it cannot price rather than pricing them at zero', () => {
    const summary = summarize([call(), call({ model: 'some-future-model' })]);
    expect(summary.windows.today.costUsd).toBeCloseTo(0.0005, 6);
    expect(summary.windows.today.unpricedCalls).toBe(1);
    expect(summary.byModel.find((m) => m.model === 'some-future-model').priced).toBe(false);
  });

  it('splits successes from failures and says why they failed', () => {
    const summary = summarize([
      call(),
      call({ status: 'error', errorCode: 'timeout', latencyMs: null, inputTokens: null }),
      call({ status: 'error', errorCode: 'timeout', latencyMs: null, inputTokens: null }),
      call({ status: 'error', errorCode: 'rate_limited', latencyMs: null, inputTokens: null }),
    ]);

    expect(summary.windows.today).toMatchObject({ calls: 4, ok: 1, errors: 3 });
    expect(summary.byError).toEqual([
      { code: 'timeout', calls: 2 },
      { code: 'rate_limited', calls: 1 },
    ]);
  });

  it('reports latency from the calls that worked', () => {
    // A timeout has no latency to report; including it as zero — or as the
    // timeout itself — would describe a read nobody experienced.
    const summary = summarize([
      call({ latencyMs: 500 }),
      call({ latencyMs: 900 }),
      call({ latencyMs: 1300 }),
      call({ status: 'error', errorCode: 'timeout', latencyMs: null }),
    ]);
    expect(summary.windows.today.medianLatencyMs).toBe(900);
    expect(summary.windows.today.p95LatencyMs).toBe(1300);
  });

  it('leaves latency unknown when nothing succeeded', () => {
    const summary = summarize([call({ status: 'error', errorCode: 'timeout', latencyMs: null })]);
    expect(summary.windows.today.medianLatencyMs).toBeNull();
  });

  it('breaks the last month down by task, busiest first', () => {
    const summary = summarize([
      call({ task: 'meal' }),
      call({ task: 'meal' }),
      call({ task: 'label' }),
      call({ task: 'recipe', createdAt: '2026-01-01T09:00:00.000Z' }), // older than the breakdown
    ]);
    expect(summary.byTask.map((t) => [t.task, t.calls])).toEqual([
      ['meal', 2],
      ['label', 1],
    ]);
  });

  it('counts what is left of today against the ceiling', () => {
    const summary = summarize([call(), call(), call()], { dailyLimit: 10 });
    expect(summary.usedToday).toBe(3);
    expect(summary.remainingToday).toBe(7);
  });

  it('never reports a negative allowance', () => {
    const summary = summarize([call(), call(), call()], { dailyLimit: 2 });
    expect(summary.remainingToday).toBe(0);
  });

  it('lists recent calls newest first', () => {
    const summary = summarize([
      call({ id: 'older', createdAt: '2026-08-06T09:00:00.000Z' }),
      call({ id: 'newest', createdAt: '2026-08-07T18:00:00.000Z' }),
      call({ id: 'middle', createdAt: '2026-08-07T08:00:00.000Z' }),
    ]);
    expect(summary.recent.map((r) => r.id)).toEqual(['newest', 'middle', 'older']);
    expect(summary.recent[0].costUsd).toBeCloseTo(0.0005, 6);
  });

  it('holds nothing the model said', () => {
    const summary = summarize([call()]);
    expect(Object.keys(summary.recent[0])).not.toContain('responseJson');
  });

  it('reads as empty on a server that has never called the model', () => {
    const summary = summarize([], { configured: false });
    expect(summary.configured).toBe(false);
    expect(summary.windows.all.calls).toBe(0);
    expect(summary.windows.all.costUsd).toBe(0);
    expect(summary.recent).toEqual([]);
    expect(summary.byTask).toEqual([]);
  });
});

describe('GET /api/vision/usage', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE vision_requests (
      id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, task TEXT NOT NULL,
      promptVersion TEXT NOT NULL, model TEXT NOT NULL, imageHash TEXT NOT NULL,
      imageBytes INTEGER NOT NULL, status TEXT NOT NULL, errorCode TEXT,
      latencyMs INTEGER, inputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER,
      responseJson TEXT
    )`);
  });

  const insert = (row) =>
    db
      .prepare(
        `INSERT INTO vision_requests (id, createdAt, task, promptVersion, model, imageHash,
          imageBytes, status, errorCode, latencyMs, inputTokens, outputTokens, totalTokens, responseJson)
         VALUES (@id, @createdAt, @task, 'v1', @model, 'hash', 100, @status, @errorCode,
          @latencyMs, @inputTokens, @outputTokens, 1500, @responseJson)`,
      )
      .run({ responseJson: '{"servingGrams":40}', ...call(row) });

  const get = (over = {}) => {
    const res = { body: null, json: (payload) => ((res.body = payload), res) };
    createVisionUsageHandler({
      db,
      provider: { name: 'gemini', model: 'gemini-3.1-flash-lite', configured: true },
      dailyLimit: 50,
      ...over,
    })({}, res);
    return res.body;
  };

  it('summarises what the table holds', () => {
    insert({ createdAt: new Date().toISOString() });
    insert({ createdAt: new Date().toISOString(), status: 'error', errorCode: 'timeout' });

    const body = get();
    expect(body.windows.all.calls).toBe(2);
    expect(body.windows.today.calls).toBe(2);
    expect(body.usedToday).toBe(2);
    expect(body.remainingToday).toBe(48);
    expect(body.model).toBe('gemini-3.1-flash-lite');
    expect(body.dailyLimit).toBe(50);
  });

  it('never returns what the model answered', () => {
    insert({ createdAt: new Date().toISOString() });
    expect(JSON.stringify(get())).not.toContain('servingGrams');
  });

  it('says plainly when no model is configured', () => {
    const body = get({ provider: { name: 'gemini', model: 'none', configured: false } });
    expect(body.configured).toBe(false);
    expect(body.windows.all.calls).toBe(0);
  });
});
