import { parseLabel, type ParsedLabel } from './labelParse';
import { itemsToText, type OcrItem } from './ocrRows';

// Reads a nutrition panel from a photo, entirely on-device.
//
// Engine: PP-OCRv6 via ppu-paddle-ocr + ONNX Runtime WASM. Chosen over
// tesseract.js after a head-to-head on rendered US and Dutch panels (clean,
// tilted, blurred): equal field accuracy overall, but Paddle made zero
// character-level errors where Tesseract systematically read the unit "g" as
// a digit 9, and Paddle's failures were blanks rather than wrong numbers.
// Its one weakness — scrambling rows on tilted photos — is fixed by the
// geometry-based row reconstruction in ocrRows.ts.
//
// Everything is served from our own origin: models from /ocr/, the ORT wasm
// as a build asset. No third-party requests, nothing uploaded.

// Vite turns these into hashed asset URLs at build time. Direct file paths
// because the package's exports map doesn't expose its dist assets.
import ortWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';

const MODEL_URLS = {
  detection: '/ocr/PP-OCRv6_tiny_det.ort',
  recognition: '/ocr/PP-OCRv6_tiny_rec.ort',
  charactersDictionary: '/ocr/ppocrv6_tiny_dict.txt',
};

// Detection downsizes internally, but recognition crops from the canvas we
// hand over — so cap huge camera photos for memory, and gently upscale tiny
// images (screenshots, crops) so the crops keep enough pixels per glyph.
const MAX_EDGE = 2200;
const MIN_EDGE = 1000;

export interface ScanResult extends ParsedLabel {
  /** Reconstructed OCR text, shown when the user wants to see what was read. */
  text: string;
}

interface PaddleService {
  recognize(
    image: HTMLCanvasElement,
    options: { flatten: true },
  ): Promise<{ results: OcrItem[]; confidence: number }>;
}

// One engine instance for the session: models stay warm, so a re-scan after
// adjusting the photo is quick.
let servicePromise: Promise<PaddleService> | null = null;

function loadService(): Promise<PaddleService> {
  servicePromise ??= (async () => {
    // The OCR stack is multi-megabyte; it loads only when a scan starts.
    const [{ PaddleOcrService }, ort] = await Promise.all([
      import('ppu-paddle-ocr/web'),
      import('onnxruntime-web'),
    ]);
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
    const service = new PaddleOcrService({
      model: MODEL_URLS,
      session: { executionProviders: ['wasm'] },
    });
    await service.initialize();
    return service as unknown as PaddleService;
  })();
  return servicePromise;
}

function fileToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const longEdge = Math.max(img.width, img.height);
      const scale =
        longEdge > MAX_EDGE
          ? MAX_EDGE / longEdge
          : longEdge < MIN_EDGE
            ? Math.min(3, MIN_EDGE / longEdge)
            : 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Could not process the photo.'));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file doesn't look like a photo."));
    };
    img.src = url;
  });
}

/**
 * Runs OCR and parses the result. Takes a Blob rather than a File: a photo
 * captured in the app has no filename, and nothing here ever wanted one.
 * `onStage` reports coarse progress — the
 * first scan of a session loads ~20MB of engine and models (cached by the
 * browser afterwards), which deserves a different message than the read
 * itself.
 */
export async function scanLabel(
  file: Blob,
  onStage?: (stage: 'loading' | 'reading') => void,
): Promise<ScanResult> {
  onStage?.(servicePromise ? 'reading' : 'loading');
  const [service, canvas] = await Promise.all([loadService(), fileToCanvas(file)]);
  onStage?.('reading');
  const { results } = await service.recognize(canvas, { flatten: true });
  const text = itemsToText(results);
  return { ...parseLabel(text), text };
}
