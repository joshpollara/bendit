// Sending a photo to the server to be read by a model.
//
// The client never holds a key and never picks a prompt — it names a task and
// sends an image. What comes back is either parsed data or a coded failure, so
// the screen can say what went wrong instead of spinning forever.
//
// The photo is downscaled here, not on the server. Meal portions and package
// text lose useful evidence at thumbnail resolution, while full-resolution
// phone photos waste upload time. 1536px keeps roughly 1-2MP for the model.

import { compressPhoto } from './photo';

export const VISION_MAX_EDGE = 1536;

export type VisionErrorCode =
  | 'offline'
  | 'unconfigured'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'timeout'
  | 'network_error'
  | 'provider_error'
  | 'empty_response'
  | 'bad_json'
  | 'bad_request'
  | 'unknown_task'
  | 'image_too_large'
  | 'unknown';

export type VisionMeta = {
  model: string;
  promptVersion: string;
  latencyMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  callsRemainingToday: number;
  models?: Record<string, string>;
  calls?: {
    role: string;
    model: string;
    promptVersion: string;
    latencyMs: number;
    usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  }[];
  partialFailures?: { role: string; code: string }[];
};

export class VisionRequestError extends Error {
  code: VisionErrorCode;

  constructor(code: VisionErrorCode, message: string) {
    super(message);
    this.name = 'VisionRequestError';
    this.code = code;
  }
}

/**
 * What to tell the user. Deliberately specific: "try again" and "give up" are
 * different situations, and so are "not switched on" and "you've used today's
 * allowance".
 */
export function visionErrorMessage(code: VisionErrorCode): string {
  switch (code) {
    case 'offline':
      return "You're offline, so the photo can't be read right now.";
    case 'unconfigured':
      return 'Photo reading is not switched on for this server.';
    case 'quota_exceeded':
      return "That's today's limit on photo reads.";
    case 'rate_limited':
      return 'Photo analysis is at capacity right now. Try again later.';
    case 'timeout':
      return 'Reading the photo took too long. Try again.';
    case 'image_too_large':
      return 'That photo is too large to send.';
    case 'bad_json':
    case 'empty_response':
      return "The photo couldn't be read. Try a straighter, closer shot.";
    default:
      return "The photo couldn't be read. Try again.";
  }
}

/** Base64 without the data: prefix — what the endpoint wants. */
export async function toBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  // Chunked: spreading a megabyte of bytes into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

type ExtractOptions = { fetchImpl?: typeof fetch; online?: boolean; deadlineMs?: number };

/**
 * How long the screen will wait before saying so.
 *
 * The server has a shorter deadline of its own, so an answer or a coded failure
 * normally arrives well inside this. This is for the case where nothing arrives
 * at all — a phone that changed network mid-read, or a request the browser
 * suspended when the app went into the background. Without it that request never
 * settles, and the spinner stays up until the app is closed.
 */
const DEADLINE_MS = 45_000;

/**
 * Posts to one of the model-backed endpoints and turns any failure into a
 * coded one. Split out from the resizing so the failure handling can be tested
 * without a canvas, and shared by every such endpoint so they behave alike.
 */
export async function postToModel<T>(
  endpoint: string,
  payload: Record<string, unknown>,
  { fetchImpl = fetch, online = navigator.onLine, deadlineMs = DEADLINE_MS }: ExtractOptions = {},
): Promise<T> {
  // Worth checking first: this is the branch where the offline OCR path takes
  // over, and a doomed request would only delay it.
  if (!online) throw new VisionRequestError('offline', visionErrorMessage('offline'));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    // Our own deadline, not the network's: told apart so the screen says the
    // read took too long rather than blaming a connection that was fine.
    const code = (error as Error)?.name === 'AbortError' ? 'timeout' : 'network_error';
    throw new VisionRequestError(code, visionErrorMessage(code));
  } finally {
    clearTimeout(timer);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = (body?.error?.code ?? 'unknown') as VisionErrorCode;
    throw new VisionRequestError(code, visionErrorMessage(code));
  }
  return body as T;
}

export const requestExtraction = <T>(task: string, imageBase64: string, options?: ExtractOptions) =>
  postToModel<{ data: T; meta: VisionMeta }>(
    '/api/vision/extract',
    { task, image: imageBase64, mimeType: 'image/jpeg' },
    options,
  );

/** Keep useful meal detail while bounding upload size and model cost. */
export async function resizeForModel(photo: Blob): Promise<string> {
  const resized = await compressPhoto(photo, { maxEdge: VISION_MAX_EDGE, quality: 0.88 });
  return toBase64(resized);
}

/** Resize, encode, send. */
export async function extractFromPhoto<T>(
  task: string,
  photo: Blob,
  options: ExtractOptions = {},
): Promise<{ data: T; meta: VisionMeta }> {
  return requestExtraction<T>(task, await resizeForModel(photo), options);
}
