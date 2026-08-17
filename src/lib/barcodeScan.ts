// Reading a barcode off the camera.
//
// Two engines, in order of preference:
//
//   1. The browser's own BarcodeDetector, which on Android Chrome is the same
//      decoder the OS uses. It costs nothing to ship and reads codes that a
//      JavaScript decoder gives up on.
//   2. ZXing, loaded only if step 1 is missing — Safari and Firefox have no
//      BarcodeDetector. The dynamic import keeps its ~200KB out of the initial
//      bundle for everyone who never opens the scanner.
//
// A detection is only reported once it passes its check digit (see barcode.ts).
// A misread that happens to look like a number would otherwise miss in every
// database and push the user into typing a label out by hand.

import { expandUpcE, gtinFromGs1, isValidBarcode, normalizeBarcode } from './barcode';

/** The 1D formats found on food packaging. QR and friends aren't products. */
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] as const;

type DetectedBarcode = { rawValue: string; format: string };

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
};

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats?: readonly string[] }): BarcodeDetectorLike;
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

export const hasNativeDetector = () => typeof window !== 'undefined' && 'BarcodeDetector' in window;

/**
 * The number a scan should be looked up by. UPC-E is a squeezed UPC-A and no
 * database stores the squeezed form, so it's expanded here where the format is
 * still known — eight digits alone can't be told apart from an EAN-8.
 */
export function canonicalize(raw: string, format?: string): string | null {
  const digits = normalizeBarcode(raw);
  const code = format === 'upc_e' ? expandUpcE(digits) : digits;
  if (isValidBarcode(code)) return code;
  // Not a product number as it stands: it may still carry one, as a Code 128
  // element string does.
  return gtinFromGs1(digits);
}

/**
 * The platform decoder, or null to use ZXing instead.
 *
 * Presence of the constructor isn't enough. Some builds expose it and then
 * support no formats, or throw on construction; if that were treated as "the
 * native path works", the scanner would sit there decoding nothing. Anything
 * unexpected here means fall back rather than fail.
 */
async function nativeDetector(): Promise<BarcodeDetectorLike | null> {
  if (!hasNativeDetector()) return null;
  try {
    const Detector = window.BarcodeDetector!;
    const supported = (await Detector.getSupportedFormats?.()) ?? [...FORMATS];
    const usable = FORMATS.filter((format) => supported.includes(format));
    if (usable.length === 0) return null;
    return new Detector({ formats: usable });
  } catch {
    return null;
  }
}

export type Scanner = { stop: () => void };

/**
 * A frame the platform decoder refuses to look at at all resolves empty; it
 * does not throw. A throw means the decoder itself is unavailable — on Android
 * the detection service is a Play Services module that may not be installed,
 * and the constructor and format list both succeed before it is ever needed.
 * Swallowing that leaves a live preview decoding nothing, for as long as
 * someone is willing to hold a packet up to it. A few in a row is not a bad
 * frame; it is a decoder that is not going to work, so hand over to ZXing.
 */
const NATIVE_FAILURES_ALLOWED = 5;

/**
 * Starts decoding from `video`, calling `onDetect` once with the first code
 * that checks out. The caller owns the camera stream and the element; this only
 * reads frames.
 *
 * `onReject` fires when a code was read and then thrown away for failing its
 * check digit. It is the difference between "point it at the packet" and "that
 * packet is not going to scan", and without it both look identical: nothing.
 */
export async function startScanning(
  video: HTMLVideoElement,
  onDetect: (code: string) => void,
  { onReject }: { onReject?: () => void } = {},
): Promise<Scanner> {
  let stopped = false;
  let fired = false;

  const report = (raw: string, format?: string) => {
    if (fired || stopped) return;
    const code = canonicalize(raw, format);
    if (!code) {
      onReject?.(); // a misread: keep looking rather than guess
      return;
    }
    fired = true;
    onDetect(code);
  };

  const zxing = async (): Promise<Scanner> => {
    const [{ BrowserMultiFormatReader }, { BarcodeFormat }] = await Promise.all([
      import('@zxing/browser'),
      import('@zxing/library'),
    ]);
    const reader = new BrowserMultiFormatReader();
    const controls = await reader.decodeFromVideoElement(video, (result) => {
      if (!result) return;
      // Only UPC-E changes what happens next, and its enum value is read from
      // the library rather than written down here.
      const format = result.getBarcodeFormat() === BarcodeFormat.UPC_E ? 'upc_e' : undefined;
      report(result.getText(), format);
    });
    if (stopped) controls.stop();
    return { stop: () => controls.stop() };
  };

  const detector = await nativeDetector();
  if (!detector) {
    const engine = await zxing();
    return {
      stop: () => {
        stopped = true;
        engine.stop();
      },
    };
  }

  let failures = 0;
  let handedOver = false;
  // Whatever is currently reading frames: the platform decoder, or ZXing after
  // it has given up. Stopping the scanner stops whichever it is now.
  let engine: Scanner = { stop: () => {} };

  // Roughly five frames a second: fast enough to feel instant, slow enough
  // to leave the phone's CPU alone.
  const timer = setInterval(async () => {
    if (stopped || fired || handedOver || video.readyState < 2) return;
    try {
      const [hit] = await detector.detect(video);
      failures = 0;
      if (hit) report(hit.rawValue, hit.format);
    } catch {
      if (++failures < NATIVE_FAILURES_ALLOWED) return;
      handedOver = true;
      clearInterval(timer);
      // If ZXing cannot start either there is nothing left to try. The preview
      // stays up and the number can still be typed, which is what the screen
      // offers anyway.
      engine = await zxing().catch(() => ({ stop: () => {} }));
      if (stopped) engine.stop();
    }
  }, 200);

  engine = { stop: () => clearInterval(timer) };
  return {
    stop: () => {
      stopped = true;
      engine.stop();
    },
  };
}
