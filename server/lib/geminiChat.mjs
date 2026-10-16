// A conversation with Gemini that can call tools.
//
// The vision provider takes one image and returns JSON in a schema; this takes
// a whole conversation and a list of functions, and returns the model's next
// turn — which is either text, or a request to call some of those functions.
// Same key, same endpoint, same token accounting; a different shape of call.

import { usageOf, VisionError } from './vision.mjs';

const ENDPOINT =
  process.env.VISION_ENDPOINT ?? 'https://generativelanguage.googleapis.com/v1beta/models';

/** One turn of a conversation can take a while when the model thinks first. */
const TIMEOUT_MS = 45_000;
const isRetryable = (status) => status === 429 || (status >= 500 && status < 600);

export function createChatModel({
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.ASSISTANT_MODEL ?? 'gemini-3.7-flash',
  thinkingLevel = process.env.ASSISTANT_THINKING_LEVEL ?? 'low',
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const level = String(thinkingLevel ?? '').trim().toUpperCase();

  async function once(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        throw new VisionError(
          response.status === 429 ? 'rate_limited' : 'provider_error',
          `Model returned ${response.status}${detail ? `: ${detail}` : ''}`,
          { status: response.status, retryable: isRetryable(response.status) },
        );
      }
      const json = await response.json();
      const content = json?.candidates?.[0]?.content;
      if (!content?.parts?.length) {
        throw new VisionError('empty_response', 'The model returned nothing usable.');
      }
      return { content, usage: usageOf(json.usageMetadata), latencyMs: Date.now() - started, model };
    } catch (error) {
      if (error instanceof VisionError) throw error;
      if (error?.name === 'AbortError') {
        throw new VisionError('timeout', 'The model took too long.', { retryable: true });
      }
      throw new VisionError('network_error', 'Could not reach the model.', { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    model,
    configured: Boolean(apiKey),

    /**
     * The model's next turn. `contents` is the conversation in Gemini's own
     * shape, passed back exactly as it came — model turns carry signatures
     * that must be returned untouched for the next turn to be accepted.
     */
    async generate({ system, contents, tools }) {
      if (!apiKey) throw new VisionError('unconfigured', 'No model is configured.');
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: tools }],
        generationConfig: level ? { thinkingConfig: { thinkingLevel: level } } : {},
      };
      try {
        return await once(body);
      } catch (error) {
        // One retry, for the failures that clear on their own.
        if (!error.retryable) throw error;
        await sleep(800);
        return once(body);
      }
    },
  };
}
