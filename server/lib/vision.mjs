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
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
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

/** The human-readable part of an error body, if it has one. */
function parseProviderMessage(text) {
  if (!text) return '';
  try {
    return String(JSON.parse(text)?.error?.message ?? '').slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
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
  thinkingLevel = process.env.VISION_THINKING_LEVEL,
  temperature,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
  deadlineMs = DEADLINE_MS,
  maxAttempts = MAX_ATTEMPTS,
  onRetryDelay = sleep,
} = {}) {
  const configured = Boolean(apiKey);
  // It goes inside thinkingConfig, not beside it. Sent only when configured:
  // models that do not support thinking reject the entire request for it.
  const normalizedThinkingLevel = String(thinkingLevel ?? '').trim().toUpperCase();

  async function callOnce({ imageBase64, mimeType, prompt, schema, text, attemptMs }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptMs);
    try {
      const response = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
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
        const reason = parseProviderMessage(detail);
        throw new VisionError(
          response.status === 429 ? 'rate_limited' : 'provider_error',
          `Vision provider returned ${response.status}${reason ? `: ${reason}` : ''}`,
          { status: response.status, retryable: isRetryable(response.status) },
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
        try {
          const started = Date.now();
          const body = await callOnce({ imageBase64, mimeType, prompt, schema, text, attemptMs });
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
            model,
            latencyMs: Date.now() - started,
            usage: usageOf(body?.usageMetadata),
          };
        } catch (error) {
          lastError = error;
          const delay = backoffMs(attempt);
          if (!error.retryable || attempt === maxAttempts) throw error;
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
