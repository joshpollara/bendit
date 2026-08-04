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

// Flash-Lite 3.1: the cheapest tier that actually reads images for a new API
// key. 2.5 is cheaper on paper and is still listed by the models endpoint, but
// calling it returns "no longer available to new users" — a 404 that says
// nothing until the provider's own message is read, which is why that message
// is now included in the error.
//
// Measured on a real photographed panel: ~1,400 input tokens and ~100 output,
// so about $0.0005 a read at $0.25/M in and $1.50/M out. A 768px photo is more
// than the one 258-token tile the docs quote — a portrait shot spans two.
// 3.5-flash-lite read the same panel identically and costs twice as much.
// Overridable with VISION_MODEL.
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
// Overridable so the whole path can be exercised against a local stand-in,
// without a key and without spending anything.
const ENDPOINT =
  process.env.VISION_ENDPOINT ?? 'https://generativelanguage.googleapis.com/v1beta/models';

/** Long enough for a slow model, short enough that a phone isn't left hanging. */
const TIMEOUT_MS = 20_000;
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
 * Gemini rejects the parts of JSON Schema it doesn't implement, so the schema
 * is passed through a filter rather than verbatim. Anything it doesn't
 * understand is dropped here instead of failing the call at request time.
 */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const allowed = ['type', 'description', 'enum', 'nullable', 'format'];
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
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
  onRetryDelay = sleep,
} = {}) {
  const configured = Boolean(apiKey);

  async function callOnce({ imageBase64, mimeType, prompt, schema, text }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
            temperature: 0,
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
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const started = Date.now();
          const body = await callOnce({ imageBase64, mimeType, prompt, schema, text });
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
            usage: {
              inputTokens: body?.usageMetadata?.promptTokenCount ?? null,
              outputTokens: body?.usageMetadata?.candidatesTokenCount ?? null,
              totalTokens: body?.usageMetadata?.totalTokenCount ?? null,
            },
          };
        } catch (error) {
          lastError = error;
          if (!error.retryable || attempt === maxAttempts) throw error;
          await onRetryDelay(backoffMs(attempt));
        }
      }
      throw lastError;
    },
  };
}
