// Talking to a vision model, from the server and nowhere else.
//
// The interface is deliberately one method: give it an image and a schema, get
// back parsed JSON that matches the schema. Everything model-specific — how the
// request is shaped, where the key goes, what the response looks like — lives
// behind it, so swapping providers is one file and no caller changes.
//
// The key is read from the environment on the server. It is never sent to the
// client, and no provider SDK is bundled: this is one fetch call, which is all
// the API actually is.

/** What a caller gets when a call fails, rather than an exception of unknown shape. */
export class VisionError extends Error {
  constructor(code, message, { status = null, retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

// Pin the exact generation rather than relying on a moving alias. Model
// generations differ materially on meal and portion estimation, so the model
// id is part of the result's provenance. Overridable with VISION_MODEL for a
// bakeoff or a later, deliberate upgrade.
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
// Overridable so the whole path can be exercised against a local stand-in,
// without a key and without spending anything.
const ENDPOINT =
  process.env.VISION_ENDPOINT ?? 'https://generativelanguage.googleapis.com/v1beta/models';

/** Long enough for a slow model, short enough that a phone isn't left hanging. */
const TIMEOUT_MS = 20_000;
/**
 * And the whole call, retries included, may not take longer than this.
 *
 * The timeout above is per attempt, so three of them and their backoff is over
 * a minute of a phone showing a spinner — long past the point where the person
 * has put it down and decided the feature is broken. A retry is for the failure
 * that clears on its own; it is not worth multiplying the wait for.
 */
const DEADLINE_MS = 30_000;
const MAX_ATTEMPTS = 3;

/** 429 and 5xx are worth retrying; a 400 means the request itself is wrong. */
const isRetryable = (status) => status === 429 || (status >= 500 && status < 600);

const backoffMs = (attempt) => 400 * 2 ** (attempt - 1);

function durationMs(value) {
  if (value && typeof value === 'object') {
    const seconds = Number(value.seconds ?? 0);
    const nanos = Number(value.nanos ?? 0);
    return Number.isFinite(seconds) && Number.isFinite(nanos)
      ? Math.max(0, seconds * 1_000 + nanos / 1_000_000)
      : null;
  }
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Number(match[1]) * 1_000 : null;
}

function retryAfterHeaderMs(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1_000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** The useful, non-secret parts of a provider failure. */
function parseProviderFailure(text, response) {
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Plain-text failures still carry a useful message below.
  }
  const message = String(body?.error?.message ?? text ?? '').slice(0, 300);
  const retryInfo = Array.isArray(body?.error?.details)
    ? body.error.details.find((detail) => String(detail?.['@type'] ?? '').endsWith('RetryInfo'))
    : null;
  const delays = [
    durationMs(retryInfo?.retryDelay),
    retryAfterHeaderMs(response?.headers?.get?.('retry-after')),
  ].filter((value) => value != null);
  return { message, retryAfterMs: delays.length ? Math.max(...delays) : null };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What a call is billed for.
 *
 * A model that thinks before it answers charges those tokens at the output
 * rate but reports them in a field of their own, so counting only the visible
 * answer makes a thinking model look several times cheaper than the invoice
 * says. They are added to the output count rather than kept apart: everything
 * that reads these numbers is working out money, and money doesn't tell the
 * two apart. Nulls are preserved — a call that reported nothing should not
 * read as a call that cost nothing.
 */
export function usageOf(meta) {
  const answer = meta?.candidatesTokenCount;
  // The provider's own documentation and its responses disagree about what this
  // field is called, and being wrong about the name is indistinguishable from a
  // model that didn't think — silently, and in the direction of a smaller bill.
  // Both spellings are read; only one will ever be present.
  const thinking = meta?.thoughtsTokenCount ?? meta?.totalThoughtTokens;
  return {
    inputTokens: meta?.promptTokenCount ?? null,
    outputTokens:
      answer == null && thinking == null ? null : (answer ?? 0) + (thinking ?? 0),
    totalTokens: meta?.totalTokenCount ?? null,
  };
}

/**
 * Gemini rejects the parts of JSON Schema it doesn't implement, so the schema
 * is passed through a filter rather than verbatim. Anything it doesn't
 * understand is dropped here instead of failing the call at request time.
 */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const allowed = ['type', 'description', 'enum', 'nullable', 'format', 'minItems', 'maxItems'];
  const out = {};
  for (const key of allowed) if (schema[key] !== undefined) out[key] = schema[key];
  if (schema.type === 'object' && schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [name, toGeminiSchema(value)]),
    );
    if (schema.required) out.required = schema.required;
    // The model must not invent fields the caller isn't expecting.
    out.propertyOrdering = Object.keys(schema.properties);
  }
  if (schema.type === 'array' && schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

/**
 * Builds a provider. `fetchImpl` is injectable so tests can exercise every path
 * — timeouts, 429s, malformed JSON — without a network or a bill.
 */
export function createVisionProvider({
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.VISION_MODEL ?? DEFAULT_MODEL,
  fallbackModel,
  thinkingLevel = process.env.VISION_THINKING_LEVEL,
  temperature,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
  deadlineMs = DEADLINE_MS,
  maxAttempts = MAX_ATTEMPTS,
  onRetryDelay = sleep,
  random = Math.random,
} = {}) {
  const configured = Boolean(apiKey);
  // It goes inside thinkingConfig, not beside it. Sent only when configured:
  // models that do not support thinking reject the entire request for it.
  const normalizedThinkingLevel = String(thinkingLevel ?? '').trim().toUpperCase();

  async function callOnce({ imageBase64, mimeType, prompt, schema, text, attemptMs, attemptModel }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptMs);
    try {
      const response = await fetchImpl(`${ENDPOINT}/${attemptModel}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              // A page that published no structured data is read as text; a
              // photograph of a page is read as an image. Same task either way.
              parts: [
                { text: prompt },
                imageBase64 ? { inlineData: { mimeType, data: imageBase64 } } : { text },
              ],
            },
          ],
          generationConfig: {
            // Structured output: the model is constrained to the schema rather
            // than asked nicely for JSON and parsed hopefully.
            responseMimeType: 'application/json',
            responseSchema: toGeminiSchema(schema),
            // Newer Gemini models no longer accept temperature. Leave it out by
            // default, but retain an explicit per-provider override for model
            // bakeoffs and older compatible models.
            ...(temperature == null ? {} : { temperature }),
            ...(normalizedThinkingLevel
              ? { thinkingConfig: { thinkingLevel: normalizedThinkingLevel } }
              : {}),
          },
        }),
      });

      if (!response.ok) {
        // The provider's own message is the only thing that says *why*. Without
        // it a retired model reads as an unexplained 404, which is three round
        // trips of guessing instead of one line of text.
        const detail = await response.text().catch(() => '');
        const failure = parseProviderFailure(detail, response);
        // Gemini sometimes reports its own execution deadline as a 5xx. That
        // is still a timeout from the caller's point of view: it is retryable,
        // and the UI can tell the person that reading took too long instead of
        // presenting an unexplained provider failure.
        const providerTimedOut =
          response.status >= 500 &&
          /\b(?:deadline (?:expired|exceeded)|timed out|timeout)\b/i.test(failure.message);
        throw new VisionError(
          response.status === 429
            ? 'rate_limited'
            : providerTimedOut
              ? 'timeout'
              : 'provider_error',
          `Vision provider returned ${response.status}${failure.message ? `: ${failure.message}` : ''}`,
          {
            status: response.status,
            retryable: isRetryable(response.status),
            retryAfterMs: failure.retryAfterMs,
          },
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof VisionError) throw error;
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new VisionError('timeout', 'The vision provider took too long.', { retryable: true });
      }
      throw new VisionError('network_error', 'Could not reach the vision provider.', {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'gemini',
    model,
    configured,

    /**
     * One image in, parsed JSON out. Throws VisionError; never returns half a
     * result, and never returns unparsed text.
     */
    async extract({ imageBase64, mimeType = 'image/jpeg', prompt, schema, text }) {
      if (!configured) {
        throw new VisionError('unconfigured', 'No vision provider is configured.');
      }
      if (!imageBase64 && !text) {
        throw new VisionError('bad_request', 'Nothing was sent to read.');
      }
      const deadline = Date.now() + deadlineMs;
      const timeLeft = () => deadline - Date.now();

      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // No attempt is allowed to run past the deadline: a second try given
        // the full timeout again is how one slow read becomes a minute of
        // waiting for an answer that was never coming.
        const attemptMs = Math.min(timeoutMs, timeLeft());
        // A task may nominate a faster fallback for its retry. Recipe photos
        // are long structured reads: if the stronger model hits its own
        // deadline, repeating the exact call is less useful than trying the
        // already-supported flash-lite model with the remaining budget.
        const attemptModel = attempt > 1 && fallbackModel ? fallbackModel : model;
        try {
          const started = Date.now();
          const body = await callOnce({
            imageBase64,
            mimeType,
            prompt,
            schema,
            text,
            attemptMs,
            attemptModel,
          });
          const answer = body?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (typeof answer !== 'string') {
            // A response with no text part is a refusal or a safety block.
            throw new VisionError('empty_response', 'The vision provider returned nothing usable.');
          }
          let parsed;
          try {
            parsed = JSON.parse(answer);
          } catch {
            throw new VisionError('bad_json', 'The vision provider returned invalid JSON.');
          }
          return {
            data: parsed,
            raw: answer,
            model: attemptModel,
            latencyMs: Date.now() - started,
            usage: usageOf(body?.usageMetadata),
          };
        } catch (error) {
          if (error && typeof error === 'object' && !error.model) error.model = attemptModel;
          lastError = error;
          if (!error.retryable || attempt === maxAttempts) throw error;
          // A bare 429 is often a daily or spend limit. Three retries within a
          // second only multiply the failure. Retry it only when the provider
          // says how long to wait; add jitter so parallel roles do not wake up
          // on the same millisecond.
          if (error.code === 'rate_limited' && error.retryAfterMs == null) throw error;
          const instructed = error.retryAfterMs ?? 0;
          const jitter = error.code === 'rate_limited' ? Math.floor(random() * 250) : 0;
          const delay = Math.max(backoffMs(attempt), instructed) + jitter;
          // A retry that can't finish before the deadline is a wait with no
          // answer at the end of it, and it is billed like any other call.
          if (timeLeft() - delay <= 0) throw error;
          await onRetryDelay(delay);
        }
      }
      throw lastError;
    },
  };
}
