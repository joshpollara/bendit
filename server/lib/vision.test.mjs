import { describe, expect, it, vi } from 'vitest';
import { createVisionProvider, toGeminiSchema, VisionError } from './vision.mjs';
import { getTask, TASKS } from './visionTasks.mjs';

// Every test here uses a fake fetch. Nothing in this file reaches the network,
// and CI never spends money to run it.

const SCHEMA = {
  type: 'object',
  properties: { calories: { type: 'number' } },
  required: ['calories'],
};

/** A response in the shape the provider actually returns. */
const geminiResponse = (payload, usage = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40, totalTokenCount: 340, ...usage },
  }),
});

const errorResponse = (status, { retryAfter = null, body = null } = {}) => ({
  ok: false,
  status,
  headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
  text: async () => body ?? `error ${status}`,
});

const provider = (fetchImpl, options = {}) =>
  createVisionProvider({
    apiKey: 'test-key',
    fetchImpl,
    thinkingLevel: null,
    // No real waiting between retries.
    onRetryDelay: async () => {},
    ...options,
  });

const call = { imageBase64: 'AAAA', prompt: 'read it', schema: SCHEMA };

describe('vision provider', () => {
  it('returns parsed JSON, not text', async () => {
    const result = await provider(async () => geminiResponse({ calories: 210 })).extract(call);
    expect(result.data).toEqual({ calories: 210 });
    expect(result.usage.totalTokens).toBe(340);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('counts thinking as output, because that is how it is billed', async () => {
    // A model that thinks reports those tokens separately. Counting only the
    // visible answer would report a call at a fraction of what it cost.
    const result = await provider(async () =>
      geminiResponse({ calories: 210 }, { candidatesTokenCount: 40, thoughtsTokenCount: 900 }),
    ).extract(call);
    expect(result.usage.outputTokens).toBe(940);
  });

  it('reads the thinking count under either name the provider gives it', async () => {
    const result = await provider(async () =>
      geminiResponse({ calories: 210 }, { candidatesTokenCount: 40, totalThoughtTokens: 500 }),
    ).extract(call);
    expect(result.usage.outputTokens).toBe(540);
  });

  it('asks for no particular thinking level unless one is set', async () => {
    // The models that don't take the field reject the whole request for it.
    const fetchImpl = vi.fn(async () => geminiResponse({ calories: 1 }));
    await provider(fetchImpl).extract(call);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.generationConfig).not.toHaveProperty('thinkingConfig');
    expect(body.generationConfig).not.toHaveProperty('thinkingLevel');
  });

  it('accepts a per-instance thinking level and nests it where the provider expects it', async () => {
    // Beside thinkingConfig rather than inside it, this is an unknown field:
    // the request either fails or the setting is ignored and billed at the
    // default. Neither announces itself.
    const fetchImpl = vi.fn(async () => geminiResponse({ calories: 1 }));
    await provider(fetchImpl, { thinkingLevel: 'high' }).extract(call);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });
  });

  it('pins the default model generation', () => {
    const configuredModel = process.env.VISION_MODEL;
    delete process.env.VISION_MODEL;
    try {
      expect(provider(vi.fn()).model).toBe('gemini-3.5-flash-lite');
    } finally {
      if (configuredModel === undefined) delete process.env.VISION_MODEL;
      else process.env.VISION_MODEL = configuredModel;
    }
  });

  it('leaves a call that reported no tokens as unknown, not as free', async () => {
    const result = await provider(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"calories":1}' }] } }] }),
    })).extract(call);
    expect(result.usage.outputTokens).toBeNull();
    expect(result.usage.inputTokens).toBeNull();
  });

  it('sends the key in a header and never in the URL', async () => {
    // A key in a query string ends up in proxy logs and browser histories.
    const fetchImpl = vi.fn(async () => geminiResponse({ calories: 1 }));
    await provider(fetchImpl).extract(call);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).not.toContain('test-key');
    expect(init.headers['x-goog-api-key']).toBe('test-key');
  });

  it('asks for structured output rather than hoping for JSON', async () => {
    const fetchImpl = vi.fn(async () => geminiResponse({ calories: 1 }));
    await provider(fetchImpl).extract(call);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema.properties.calories.type).toBe('number');
    expect(body.generationConfig).not.toHaveProperty('temperature');
  });

  it('sends temperature only when the provider instance explicitly requests it', async () => {
    const fetchImpl = vi.fn(async () => geminiResponse({ calories: 1 }));
    await provider(fetchImpl, { temperature: 0 }).extract(call);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.generationConfig.temperature).toBe(0);
  });

  it('retries a rate limit when the provider says how long to wait', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts++;
      return attempts < 3
        ? errorResponse(429, { retryAfter: '1' })
        : geminiResponse({ calories: 99 });
    });
    const onRetryDelay = vi.fn(async () => {});
    const result = await provider(fetchImpl, { onRetryDelay, random: () => 0 }).extract(call);
    expect(result.data.calories).toBe(99);
    expect(attempts).toBe(3);
    expect(onRetryDelay).toHaveBeenNthCalledWith(1, 1000);
    expect(onRetryDelay).toHaveBeenNthCalledWith(2, 1000);
  });

  it('does not amplify a rate limit that gives no retry timing', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(429));
    await expect(provider(fetchImpl).extract(call)).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: null,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reads Gemini RetryInfo as well as the HTTP header', async () => {
    const fetchImpl = vi.fn(async () =>
      errorResponse(429, {
        body: JSON.stringify({
          error: {
            message: 'Quota exceeded for this model.',
            details: [
              { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12.5s' },
            ],
          },
        }),
      }),
    );
    await expect(provider(fetchImpl, { maxAttempts: 1 }).extract(call)).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 12_500,
      message: expect.stringMatching(/Quota exceeded/),
    });
  });

  it('gives up after the last attempt rather than retrying forever', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(503));
    await expect(provider(fetchImpl).extract(call)).rejects.toMatchObject({ code: 'provider_error' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('can retry a deadline failure on a faster fallback model', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(503, {
          body: JSON.stringify({ error: { message: 'Deadline expired.' } }),
        }),
      )
      .mockResolvedValueOnce(geminiResponse({ calories: 210 }));

    const result = await provider(fetchImpl, {
      model: 'gemini-strong',
      fallbackModel: 'gemini-fast',
      maxAttempts: 2,
    }).extract(call);

    expect(fetchImpl.mock.calls[0][0]).toContain('/gemini-strong:generateContent');
    expect(fetchImpl.mock.calls[1][0]).toContain('/gemini-fast:generateContent');
    expect(result.model).toBe('gemini-fast');
  });

  it('treats Gemini\'s own deadline 503 as a retryable timeout', async () => {
    const fetchImpl = vi.fn(async () =>
      errorResponse(503, {
        body: JSON.stringify({
          error: { message: 'Deadline expired before operation could complete.' },
        }),
      }),
    );

    await expect(provider(fetchImpl).extract(call)).rejects.toMatchObject({
      code: 'timeout',
      status: 503,
      retryable: true,
      message: expect.stringMatching(/Deadline expired/),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a request that was wrong to begin with', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(400));
    await expect(provider(fetchImpl).extract(call)).rejects.toBeInstanceOf(VisionError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a timeout as a timeout', async () => {
    const fetchImpl = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    await expect(provider(fetchImpl, { timeoutMs: 10 }).extract(call)).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('stops retrying once the deadline leaves no room for another attempt', async () => {
    // Three full timeouts and the backoff between them is over a minute of a
    // phone showing a spinner. The budget is the whole call, not each try.
    const fetchImpl = vi.fn(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    await expect(
      provider(fetchImpl, { timeoutMs: 50, deadlineMs: 700 }).extract(call),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses to guess when the model returns something that is not JSON', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'sorry, I cannot' }] } }] }),
    });
    await expect(provider(fetchImpl).extract(call)).rejects.toMatchObject({ code: 'bad_json' });
  });

  it('treats a blocked response as an error, not an empty result', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
    });
    await expect(provider(fetchImpl).extract(call)).rejects.toMatchObject({ code: 'empty_response' });
  });

  it('carries the provider\'s own explanation into the error', async () => {
    // A retired model returns a 404 whose body is the only thing that says why.
    const fetchImpl = async () => ({
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({ error: { message: 'This model is no longer available to new users.' } }),
    });
    await expect(provider(fetchImpl).extract(call)).rejects.toThrow(/no longer available to new users/);
  });

  it('says so when no key is configured instead of calling anything', async () => {
    const fetchImpl = vi.fn();
    const unconfigured = createVisionProvider({ apiKey: '', fetchImpl });
    await expect(unconfigured.extract(call)).rejects.toMatchObject({ code: 'unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(unconfigured.configured).toBe(false);
  });
});

describe('schema translation', () => {
  it('drops the JSON Schema keywords the provider rejects', () => {
    const translated = toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: { calories: { type: 'number', minimum: 0, nullable: true } },
      required: ['calories'],
    });
    expect(translated.additionalProperties).toBeUndefined();
    expect(translated.$schema).toBeUndefined();
    expect(translated.properties.calories.minimum).toBeUndefined();
    expect(translated.properties.calories.nullable).toBe(true);
    expect(translated.required).toEqual(['calories']);
  });

  it('translates nested objects and arrays', () => {
    const translated = toGeminiSchema({
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { type: 'object', properties: { name: { type: 'string', pattern: '.*' } } },
    });
    expect(translated).toMatchObject({ minItems: 1, maxItems: 3 });
    expect(translated.items.properties.name).toEqual({ type: 'string' });
  });
});

describe('tasks', () => {
  it('only answers to tasks it defines', () => {
    expect(getTask('label')).toBeTruthy();
    expect(getTask('anything-else')).toBeNull();
    expect(getTask(undefined)).toBeNull();
  });

  it('carries a version on every task, so results can be compared later', () => {
    for (const [name, task] of Object.entries(TASKS)) {
      expect(task.version, name).toBeTruthy();
      expect(task.prompt.length, name).toBeGreaterThan(50);
      expect(task.schema.type, name).toBe('object');
    }
  });

  it('tells the model to transcribe rather than estimate', () => {
    // The whole point of the label path: a number that was read is worth
    // having, a number that was guessed is worse than none.
    expect(TASKS.label.prompt).toMatch(/Do not estimate/i);
    expect(TASKS.label.prompt).toMatch(/use null/i);
  });

  it('keeps the two label columns apart', () => {
    // A per-100g figure logged as a per-portion one is off by a factor of three.
    expect(TASKS.label.schema.properties.per100).toBeTruthy();
    expect(TASKS.label.schema.properties.perServing).toBeTruthy();
  });

  it('produces a schema the provider will accept', () => {
    const translated = toGeminiSchema(TASKS.label.schema);
    expect(translated.properties.basis.enum).toEqual(['g', 'ml']);
    expect(translated.properties.per100.properties.calories.nullable).toBe(true);
  });

  it('uses structured visual evidence for meal parsing without nutrition fields', () => {
    const meal = TASKS.meal;
    const item = meal.schema.properties.items.items;

    expect(meal.version).toBe('4');
    expect(meal.schema.required).toEqual([
      'captureQuality',
      'mealType',
      'scaleEvidence',
      'items',
      'uncertainties',
    ]);
    expect(meal.schema.properties.captureQuality.properties).toHaveProperty('needsRetake');
    expect(meal.schema.properties.captureQuality.properties).toHaveProperty('retakeReason');
    expect(meal.schema.properties.mealType.enum).toEqual(
      expect.arrayContaining(['simple_plate', 'mixed_dish', 'packaged']),
    );
    expect(item.properties.identityCandidates.maxItems).toBe(3);
    expect(item.properties.identityCandidates.minItems).toBe(1);
    expect(item.properties.portionG.required).toEqual(['low', 'median', 'high']);
    expect(item.properties.confidence.required).toEqual([
      'identity',
      'portion',
      'preparation',
    ]);
    expect(
      item.properties.hiddenIngredientRisks.items.properties.quantityG.required,
    ).toEqual(['low', 'high']);
    expect(JSON.stringify(meal.schema)).not.toMatch(/calorie|protein|carb|fat|kcal/i);
    expect(meal.prompt).toMatch(/Never assume a standard plate/i);
    expect(meal.prompt).toMatch(/do not silently/i);
  });

  it('defines a separate independent whole-meal estimate', () => {
    const holistic = TASKS.mealHolistic;

    expect(holistic.version).toBe('1');
    expect(holistic.schema.properties.energyKcal.required).toEqual(['low', 'median', 'high']);
    for (const macro of ['protein', 'carbs', 'fat', 'fiber']) {
      expect(holistic.schema.properties.macrosG.properties[macro].required).toEqual([
        'low',
        'median',
        'high',
      ]);
    }
    expect(holistic.schema.properties).toHaveProperty('uncertaintyReasons');
    expect(holistic.prompt).toMatch(/never see the application database result/i);
    expect(holistic.prompt).toMatch(/hidden possibilities/i);
  });
});
