import { parseLabel, type ParsedLabel } from './labelParse';

// Reads a nutrition panel from a photo, entirely on-device. Tesseract's
// weakness is small, low-contrast, skewed text, so the preprocessing below
// matters as much as the OCR call itself.

// Tesseract wants roughly 30px-tall glyphs. Big camera photos come down to
// MAX_EDGE; small images (a crop, a screenshot) are scaled *up* to MIN_EDGE,
// which measurably improves how often the unit "g" survives as a letter.
const MAX_EDGE = 2000;
const MIN_EDGE = 1500;

/**
 * Downscale to a workable size, then flatten to high-contrast greyscale.
 * Package photos are glossy and unevenly lit; a plain threshold destroys text
 * in shadow, so this stretches contrast around the image's own mean instead.
 */
export function preprocess(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const longEdge = Math.max(img.width, img.height);
      const scale =
        longEdge > MAX_EDGE ? MAX_EDGE / longEdge : longEdge < MIN_EDGE ? Math.min(3, MIN_EDGE / longEdge) : 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return reject(new Error('Could not process the photo.'));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = image.data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) {
        const grey = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        px[i] = px[i + 1] = px[i + 2] = grey;
        sum += grey;
      }
      const mean = sum / (px.length / 4);
      // Push each pixel away from the mean: dark ink darker, paper whiter.
      const CONTRAST = 1.8;
      for (let i = 0; i < px.length; i += 4) {
        const v = Math.max(0, Math.min(255, (px[i] - mean) * CONTRAST + mean));
        px[i] = px[i + 1] = px[i + 2] = v;
      }
      ctx.putImageData(image, 0, 0);

      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not process the photo.'))),
        'image/png',
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file doesn't look like a photo."));
    };
    img.src = url;
  });
}

export interface ScanResult extends ParsedLabel {
  /** Raw OCR text, shown when parsing finds nothing so the user can see why. */
  text: string;
}

/**
 * Runs OCR and parses the result. `onProgress` receives 0–1; the first scan
 * downloads the language data (~4MB, then cached by the browser), so progress
 * matters more here than in a typical async call.
 */
export async function scanLabel(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<ScanResult> {
  const image = await preprocess(file);
  // tesseract.js is multi-megabyte; keep it out of the app's main bundle.
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng+nld', 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress);
    },
  });
  try {
    const {
      data: { text },
    } = await worker.recognize(image);
    return { ...parseLabel(text), text };
  } finally {
    await worker.terminate();
  }
}
