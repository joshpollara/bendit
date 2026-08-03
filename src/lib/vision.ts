// Sending a photo to the server to be read by a model.
//
// The client never holds a key and never picks a prompt — it names a task and
// sends an image. What comes back is either parsed data or a coded failure, so
// the screen can say what went wrong instead of spinning forever.
//
// The photo is downscaled here, not on the server. A 768px longest edge is one
// image tile to the model; a full-resolution phone photo is several times the
// cost for no more legible digits, and it wastes the upload too.

import { compressPhoto } from './photo';

export const VISION_MAX_EDGE = 768;

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
      return 'Too many photos at once — wait a moment and try again.';
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

type ExtractOptions = { fetchImpl?: typeof fetch; online?: boolean };

/**
 * Posts an already-encoded image. Split out from the resizing so the failure
 * handling can be tested without a canvas.
 */
export async function requestExtraction<T>(
  task: string,
  imageBase64: string,
  { fetchImpl = fetch, online = navigator.onLine }: ExtractOptions = {},
): Promise<{ data: T; meta: VisionMeta }> {
  // Worth checking first: this is the branch where the offline OCR path takes
  // over, and a doomed request would only delay it.
  if (!online) throw new VisionRequestError('offline', visionErrorMessage('offline'));

  let response: Response;
  try {
    response = await fetchImpl('/api/vision/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, image: imageBase64, mimeType: 'image/jpeg' }),
    });
  } catch {
    throw new VisionRequestError('network_error', visionErrorMessage('network_error'));
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = (body?.error?.code ?? 'unknown') as VisionErrorCode;
    throw new VisionRequestError(code, visionErrorMessage(code));
  }
  return body as { data: T; meta: VisionMeta };
}

/** Resize, encode, send. The resize is not optional — it's the cost control. */
export async function extractFromPhoto<T>(
  task: string,
  photo: Blob,
  options: ExtractOptions = {},
): Promise<{ data: T; meta: VisionMeta }> {
  const resized = await compressPhoto(photo, { maxEdge: VISION_MAX_EDGE, quality: 0.85 });
  return requestExtraction<T>(task, await toBase64(resized), options);
}
