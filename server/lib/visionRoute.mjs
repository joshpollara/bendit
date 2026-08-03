// The only route to a model.
//
// The key lives in the server's environment; the client sends an image and the
// name of a task, and gets back JSON matching that task's schema. Prompts are
// never accepted from the client — a task name can't be turned into a
// general-purpose model proxy.
//
// Kept out of index.mjs so the provider can be substituted in tests: nothing in
// the suite is allowed to make a paid call.

import crypto from 'node:crypto';
import { getTask } from './visionTasks.mjs';

/** Images arrive already downscaled to ~768px; anything much bigger is a mistake. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * A failure the client can act on, rather than a spinner that never ends.
 * Each code maps to the status that says the same thing to a browser.
 */
export const HTTP_STATUS = {
  unconfigured: 503,
  quota_exceeded: 429,
  rate_limited: 429,
  timeout: 504,
  network_error: 502,
  provider_error: 502,
  empty_response: 502,
  bad_json: 502,
  bad_request: 400,
  unknown_task: 400,
  image_too_large: 413,
};

const INSERT = `
  INSERT INTO vision_requests
    (id, createdAt, task, promptVersion, model, imageHash, imageBytes, status, errorCode,
     latencyMs, inputTokens, outputTokens, totalTokens, responseJson)
  VALUES
    (@id, @createdAt, @task, @promptVersion, @model, @imageHash, @imageBytes, @status, @errorCode,
     @latencyMs, @inputTokens, @outputTokens, @totalTokens, @responseJson)`;

/**
 * Builds the POST /api/vision/extract handler.
 *
 * `dailyLimit` is the ceiling on calls per day — a retry loop or a stolen
 * session can't run up an unbounded bill. Failed calls count too: a loop that
 * fails every time is exactly the loop worth stopping.
 */
export function createVisionExtractHandler({ db, provider, dailyLimit = 100 }) {
  const logRequest = db.prepare(INSERT);
  const countToday = db.prepare(
    "SELECT COUNT(*) AS n FROM vision_requests WHERE createdAt >= datetime('now', 'start of day')",
  );

  return async function extractHandler(req, res) {
    const fail = (code, message, extra = {}) =>
      res.status(HTTP_STATUS[code] ?? 500).json({ error: { code, message, ...extra } });

    const { task: taskName, image, mimeType = 'image/jpeg' } = req.body ?? {};
    const task = getTask(taskName);
    if (!task) return fail('unknown_task', `There is no vision task called "${taskName}".`);

    // Either a bare base64 string or a data: URL — both are one line of client
    // code away from each other.
    const base64 = String(image ?? '').replace(/^data:[^;]+;base64,/, '');
    if (!base64) return fail('bad_request', 'No image was sent.');

    const imageBytes = Math.floor((base64.length * 3) / 4);
    if (imageBytes > MAX_IMAGE_BYTES) {
      return fail('image_too_large', 'That photo is too large — it should be resized first.');
    }
    if (!provider.configured) {
      return fail('unconfigured', 'Photo reading is not switched on for this server.');
    }

    const used = countToday.get().n;
    if (used >= dailyLimit) {
      return fail('quota_exceeded', "That's today's limit on photo reads. Try again tomorrow.", {
        limit: dailyLimit,
      });
    }

    // The image itself isn't stored — only a hash, which is enough to tell
    // whether two calls were about the same photo.
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      task: taskName,
      promptVersion: task.version,
      model: provider.model,
      imageHash: crypto.createHash('sha256').update(base64).digest('hex').slice(0, 32),
      imageBytes,
      status: 'error',
      errorCode: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      responseJson: null,
    };

    try {
      const result = await provider.extract({
        imageBase64: base64,
        mimeType,
        prompt: task.prompt,
        schema: task.schema,
      });
      Object.assign(record, {
        status: 'ok',
        latencyMs: result.latencyMs,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        totalTokens: result.usage?.totalTokens ?? null,
        responseJson: result.raw,
      });
      logRequest.run(record);
      return res.json({
        data: result.data,
        meta: {
          model: result.model,
          promptVersion: task.version,
          latencyMs: result.latencyMs,
          usage: result.usage,
          callsRemainingToday: Math.max(0, dailyLimit - used - 1),
        },
      });
    } catch (error) {
      record.errorCode = error?.code ?? 'unknown';
      logRequest.run(record);
      const code = error?.code in HTTP_STATUS ? error.code : 'provider_error';
      return fail(code, error?.message ?? 'The photo could not be read.');
    }
  };
}
