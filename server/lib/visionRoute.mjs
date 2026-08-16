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

/** Images arrive already resized on-device; this fits a detailed 1536px JPEG. */
export const MAX_IMAGE_BYTES = Math.floor(2.75 * 1024 * 1024);

/**
 * A page's text is stripped of markup before it gets here and truncated to
 * ~12,000 characters. This is the ceiling on what any caller may send, so a
 * request with a novel attached costs no more than a long recipe page.
 */
export const MAX_TEXT_BYTES = 64 * 1024;

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
  text_too_large: 413,
};

const INSERT = `
  INSERT INTO vision_requests
    (id, createdAt, task, promptVersion, model, imageHash, imageBytes, status, errorCode,
     latencyMs, inputTokens, outputTokens, totalTokens, responseJson, userId, mealPhotoRunId)
  VALUES
    (@id, @createdAt, @task, @promptVersion, @model, @imageHash, @imageBytes, @status, @errorCode,
     @latencyMs, @inputTokens, @outputTokens, @totalTokens, @responseJson, @userId, @mealPhotoRunId)`;

const UPDATE = `
  UPDATE vision_requests SET
    status = @status, errorCode = @errorCode, model = @model, latencyMs = @latencyMs,
    inputTokens = @inputTokens, outputTokens = @outputTokens,
    totalTokens = @totalTokens, responseJson = @responseJson
  WHERE id = @id AND userId IS @userId`;

/**
 * Builds the POST /api/vision/extract handler.
 *
 * `dailyLimit` is the ceiling on calls per day — a retry loop or a stolen
 * session can't run up an unbounded bill. Failed calls count too: a loop that
 * fails every time is exactly the loop worth stopping.
 */
export function createVisionExtractHandler({ db, provider, providers = {}, dailyLimit = 100 }) {
  const reserveRequest = db.prepare(INSERT);
  const finishRequest = db.prepare(UPDATE);
  const countToday = db.prepare(
    "SELECT COUNT(*) AS n FROM vision_requests WHERE createdAt >= datetime('now', 'start of day')",
  );

  return async function extractHandler(req, res) {
    const fail = (code, message, extra = {}) =>
      res.status(HTTP_STATUS[code] ?? 500).json({ error: { code, message, ...extra } });

    const { task: taskName, image, text, mimeType = 'image/jpeg' } = req.body ?? {};
    const task = getTask(taskName);
    if (!task) return fail('unknown_task', `There is no vision task called "${taskName}".`);
    const taskProvider = providers[taskName] ?? provider;

    // Either a bare base64 string or a data: URL — both are one line of client
    // code away from each other.
    const base64 = String(image ?? '').replace(/^data:[^;]+;base64,/, '');
    // A page that published no structured data arrives as text rather than as a
    // photograph of itself. Same task, same prompt, same quota, same log row —
    // only the part handed to the model differs.
    const pageText = typeof text === 'string' ? text : '';
    if (!base64 && !pageText) return fail('bad_request', 'Nothing was sent to read.');

    const inputBytes = base64
      ? Math.floor((base64.length * 3) / 4)
      : Buffer.byteLength(pageText, 'utf8');
    if (base64 && inputBytes > MAX_IMAGE_BYTES) {
      return fail('image_too_large', 'That photo is too large — it should be resized first.');
    }
    if (!base64 && inputBytes > MAX_TEXT_BYTES) {
      return fail('text_too_large', 'That page is too long to read.');
    }
    if (!taskProvider?.configured) {
      return fail('unconfigured', 'Photo reading is not switched on for this server.');
    }

    const used = countToday.get().n;
    if (used >= dailyLimit) {
      return fail('quota_exceeded', "That's today's limit on photo reads. Try again tomorrow.", {
        limit: dailyLimit,
      });
    }

    // What was sent isn't stored — only a hash, which is enough to tell whether
    // two calls were about the same photo or the same page. The two columns are
    // named for images because that came first; for a text read they hold the
    // text's hash and its size, which is what they mean either way.
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      task: taskName,
      promptVersion: task.version,
      model: taskProvider.model,
      imageHash: crypto
        .createHash('sha256')
        .update(base64 || pageText)
        .digest('hex')
        .slice(0, 32),
      imageBytes: inputBytes,
      // Inserted before the network call. Besides preserving an audit row if the
      // process exits mid-call, this reserves quota synchronously. Concurrent
      // requests therefore see one another instead of all passing the same
      // count-then-call check and overshooting the daily ceiling.
      status: 'pending',
      errorCode: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      responseJson: null,
      // Ownership and run linkage come from authenticated/internal request
      // context, never from the client body.
      userId: req.userId ?? null,
      mealPhotoRunId: req.mealPhotoRunId ?? null,
    };

    reserveRequest.run(record);
    if (typeof req.captureVisionRequestId === 'function') req.captureVisionRequestId(record.id);

    try {
      const result = await taskProvider.extract({
        imageBase64: base64,
        text: pageText,
        mimeType,
        prompt: task.prompt,
        schema: task.schema,
      });
      Object.assign(record, {
        status: 'ok',
        model: result.model ?? record.model,
        latencyMs: result.latencyMs,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        totalTokens: result.usage?.totalTokens ?? null,
        responseJson: result.raw,
      });
      finishRequest.run(record);
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
      if (error?.model) record.model = error.model;
      record.errorCode = error?.code ?? 'unknown';
      record.status = 'error';
      // Failed provider responses contain the distinction we need in order to
      // diagnose RPM versus daily/spend quota. Keep only bounded error metadata,
      // never the image or request body.
      record.responseJson = JSON.stringify({
        error: {
          code: record.errorCode,
          status: error?.status ?? null,
          message: String(error?.message ?? 'The photo could not be read.').slice(0, 500),
          retryAfterMs: error?.retryAfterMs ?? null,
        },
      });
      finishRequest.run(record);
      const code = error?.code in HTTP_STATUS ? error.code : 'provider_error';
      return fail(code, error?.message ?? 'The photo could not be read.', {
        ...(error?.retryAfterMs == null
          ? {}
          : { retryAfterSeconds: Math.ceil(error.retryAfterMs / 1_000) }),
      });
    }
  };
}
