// Reading a nutrition panel from a photo, by whichever route is available.
//
// The order is deliberate. The model reads printed digits better than on-device
// OCR does, so it goes first. But it needs a network, a configured key, and
// quota — and when any of those is missing the OCR engine is still sitting in
// the browser, so the answer is "read it here" rather than "sorry".
//
// Whichever route ran, the numbers go to the server to be checked. The
// arithmetic test is what catches a misread digit, and it would be worth little
// if the offline half of the readings skipped it.

import { scanLabel } from './labelScan';
import type { ParsedLabel } from './labelParse';
import { postToModel, resizeForModel, VisionRequestError, visionErrorMessage } from './vision';

export type LabelIssue = {
  field: string;
  severity: 'error' | 'warning';
  message: string;
};

export type LabelNutrients = {
  calories: number | null;
  energyKj?: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber?: number | null;
  sugar?: number | null;
  satFat?: number | null;
  sodiumMg?: number | null;
  saltG?: number | null;
  alcohol?: number | null;
};

export type ExtractedLabel = {
  name?: string | null;
  brand?: string | null;
  basis: 'g' | 'ml';
  servingLabel?: string | null;
  servingGrams?: number | null;
  servingsPerContainer?: number | null;
  per100?: LabelNutrients | null;
  perServing?: LabelNutrients | null;
  confidence?: 'high' | 'medium' | 'low';
};

export type LabelReading = {
  source: 'vision' | 'ocr';
  label: ExtractedLabel;
  food: Record<string, unknown> | null;
  issues: LabelIssue[];
  ok: boolean;
  confidence: 'high' | 'medium' | 'low';
  /** Set when the model couldn't be used and the device read it instead. */
  fellBackBecause?: string;
  /** The OCR text, so the user can see what was actually read. */
  text?: string;
};

export type ReadStage = 'sending' | 'loading' | 'reading' | 'checking';

/** Failures that mean "the model isn't available", not "the photo is bad". */
const FALL_BACK_ON = new Set([
  'offline',
  'unconfigured',
  'quota_exceeded',
  'rate_limited',
  'timeout',
  'network_error',
]);

/** An OCR result, in the shape the server's validator expects. */
export function ocrToLabel(parsed: ParsedLabel): ExtractedLabel {
  const nutrients: LabelNutrients = {
    calories: parsed.calories,
    protein: parsed.protein,
    carbs: parsed.carbs,
    fat: parsed.fat,
  };
  const perHundred = parsed.basis === '100g' || parsed.basis === '100ml';
  return {
    basis: parsed.basis === '100ml' ? 'ml' : 'g',
    servingLabel: parsed.servingLabel,
    servingGrams: parsed.servingGrams,
    per100: perHundred ? nutrients : null,
    perServing: perHundred ? null : nutrients,
    // On-device OCR never claims more than middling confidence: its failures
    // are silent blanks and the odd transposed digit.
    confidence: 'medium',
  };
}

async function check(
  label: ExtractedLabel,
  source: 'vision' | 'ocr',
  barcode?: string,
): Promise<LabelReading> {
  const response = await fetch('/api/labels/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label, source, barcode: barcode ?? null }),
  });
  if (!response.ok) throw new Error("Couldn't check the numbers that were read.");
  return response.json();
}

/**
 * Reads a label. `onStage` reports progress, because the two routes feel
 * different: sending a photo takes a second, while the first on-device read of
 * a session loads about 20MB of engine first.
 */
export async function readLabel(
  photo: Blob,
  { barcode, onStage }: { barcode?: string; onStage?: (stage: ReadStage) => void } = {},
): Promise<LabelReading> {
  try {
    onStage?.('sending');
    // The label endpoint reads *and* checks before replying, so what comes back
    // is already validated — there is no route that skips the arithmetic.
    return await postToModel<LabelReading>('/api/labels/extract', {
      image: await resizeForModel(photo),
      mimeType: 'image/jpeg',
      barcode: barcode ?? null,
    });
  } catch (error) {
    const code = error instanceof VisionRequestError ? error.code : 'unknown';
    if (!FALL_BACK_ON.has(code)) throw error;

    // The model is unavailable; the device can still read it.
    const scan = await scanLabel(photo, (stage) => onStage?.(stage));
    onStage?.('checking');
    const reading = await check(ocrToLabel(scan), 'ocr', barcode);
    return { ...reading, text: scan.text, fellBackBecause: visionErrorMessage(code) };
  }
}
