import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, startScanning } from './barcodeScan';

// What the decoder hands over, and what it should turn into before anything is
// looked up. The camera part isn't tested here — this is the decision layer.

describe('canonicalize', () => {
  it('passes a clean EAN-13 through', () => {
    expect(canonicalize('8712345678906', 'ean_13')).toBe('8712345678906');
  });

  it('expands a UPC-E, because no database stores the short form', () => {
    expect(canonicalize('04963406', 'upc_e')).toBe('049000006346');
  });

  it('leaves an eight-digit EAN-8 alone', () => {
    // Same length as a UPC-E and a completely different number — the format the
    // scanner reported is what tells them apart.
    expect(canonicalize('96385074', 'ean_8')).toBe('96385074');
  });

  it('refuses a misread rather than looking up a number that cannot exist', () => {
    expect(canonicalize('8712345678905', 'ean_13')).toBeNull();
    expect(canonicalize('871234567', 'code_128')).toBeNull();
    expect(canonicalize('', 'ean_13')).toBeNull();
  });

  it('handles a code with no format reported', () => {
    expect(canonicalize('8712345678906')).toBe('8712345678906');
  });

  it('takes the product number out of a Code 128 element string', () => {
    // (01) 08712345678906 (10) BATCH42 — what a packed-in-store label carries.
    // Read whole it matches nothing, which is what the scanner used to do.
    expect(canonicalize('010871234567890610042', 'code_128')).toBe('08712345678906');
    // A plain GTIN-14 that happens to start "01" is itself, not an AI.
    expect(canonicalize('01234567890128', 'code_128')).toBe('01234567890128');
    // The check digit still decides. A long number that isn't a GTIN is refused.
    expect(canonicalize('019999999999999910042', 'code_128')).toBeNull();
  });
});

// The decoding loop, with the platform detector standing in for the one a phone
// provides. There is no DOM here: the loop only reads readyState and hands the
// element to the detector, so a plain object is the whole of what it needs.
describe('the platform decoder', () => {
  const video = { readyState: 4 } as unknown as HTMLVideoElement;
  const global = globalThis as unknown as { window?: unknown; BarcodeDetector?: unknown };

  const install = (detect: () => Promise<unknown>) => {
    const Detector = function () {
      return { detect };
    } as unknown as { getSupportedFormats: () => Promise<string[]> };
    Detector.getSupportedFormats = async () => ['ean_13'];
    global.window = globalThis;
    global.BarcodeDetector = Detector;
  };

  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    delete global.BarcodeDetector;
    delete global.window;
  });

  it('is abandoned when every call throws, rather than decoding nothing forever', async () => {
    // Android with the detection service missing: the constructor and the
    // format list both succeed, and then no frame is ever read.
    const detect = vi.fn(async () => {
      throw new Error('Barcode detection service unavailable');
    });
    install(detect);

    const scanner = await startScanning(video, () => {});
    for (let frame = 0; frame < 30; frame++) await vi.advanceTimersByTimeAsync(200);

    // Five failures, then it stops asking and hands over. Without that it would
    // have asked thirty times and gone on asking for as long as the screen was
    // open, with nothing on screen to say why.
    expect(detect).toHaveBeenCalledTimes(5);
    scanner.stop();
  });

  it('says a code was read and thrown away, instead of looking identical to nothing', async () => {
    install(async () => [{ rawValue: '8712345678905', format: 'ean_13' }]); // bad check digit
    const onDetect = vi.fn();
    const onReject = vi.fn();

    const scanner = await startScanning(video, onDetect, { onReject });
    await vi.advanceTimersByTimeAsync(200);

    expect(onDetect).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalled();
    scanner.stop();
  });

  it('reports a good code once and then stops', async () => {
    install(async () => [{ rawValue: '8712345678906', format: 'ean_13' }]);
    const onDetect = vi.fn();

    const scanner = await startScanning(video, onDetect);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onDetect).toHaveBeenCalledExactlyOnceWith('8712345678906');
    scanner.stop();
  });
});
