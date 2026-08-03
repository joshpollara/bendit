// Rebuilds text rows from OCR word boxes.
//
// The OCR engine returns each snippet of text with its bounding box, in an
// order that falls apart when the photo is tilted: on a wide nutrition table,
// a few degrees of rotation shifts the far column vertically by more than a
// row height, so naive top-to-bottom ordering pairs each label with the next
// row's number ("Eiwitten 0,45 g" — the salt value). Measured, not
// hypothetical: this exact off-by-one happened at 4° tilt.
//
// Fix: find the tilt angle that makes the rows line up, then group in that
// rotated frame. The angle search works purely on box centers, no image
// processing involved.

export interface OcrBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrItem {
  text: string;
  box: OcrBox;
  confidence: number;
}

const MAX_TILT_DEG = 8;
const STEP_DEG = 0.25;

// Same-row box centers project within a few pixels of each other at the true
// angle; anything looser lets accidental alignments at wrong angles win.
// (0.5·height was tried first and picked the wrong angle on real scans.)
const ALIGN_FRACTION = 0.12;

// Rows break where the across-row gap exceeds this fraction of the text
// height. Ragged baselines stay merged; adjacent rows don't.
const ROW_GAP_FRACTION = 0.6;

interface Projected {
  item: OcrItem;
  /** Along-row coordinate (reading direction). */
  u: number;
  /** Across-row coordinate (line position). */
  v: number;
}

function project(items: OcrItem[], thetaRad: number): Projected[] {
  const cos = Math.cos(thetaRad);
  const sin = Math.sin(thetaRad);
  return items.map((item) => {
    const cx = item.box.x + item.box.width / 2;
    const cy = item.box.y + item.box.height / 2;
    return { item, u: cx * cos + cy * sin, v: cy * cos - cx * sin };
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The height of a line of text, estimated from boxes that are close to
 * square. A rotated snippet's axis-aligned box grows by width·sin(tilt), so
 * wide boxes overstate the text height badly; narrow ones barely move.
 */
function textHeight(items: OcrItem[]): number {
  const narrow = items.filter((i) => i.box.width < 3 * i.box.height);
  return median((narrow.length >= 3 ? narrow : items).map((i) => i.box.height));
}

/**
 * Alignment evidence at a candidate angle: for every pair of boxes whose
 * projected row-positions coincide within a tight tolerance, add their
 * horizontal distance — a label agreeing with a number across the full width
 * of a table is strong evidence; near neighbours agreeing is weak.
 *
 * Validated against real scans: picks the exact tilt (±4° photos → ±4.00°,
 * upright → 0°) where gap-statistics and nearest-neighbour estimators both
 * chose wrong angles on the same data.
 */
function alignmentScore(projected: Projected[], tolerance: number): number {
  let score = 0;
  for (let i = 0; i < projected.length; i++) {
    for (let j = i + 1; j < projected.length; j++) {
      if (Math.abs(projected[i].v - projected[j].v) < tolerance) {
        score += Math.abs(projected[i].u - projected[j].u);
      }
    }
  }
  return score;
}

function bestAngle(items: OcrItem[], height: number): number {
  const tolerance = ALIGN_FRACTION * height;
  let best = 0;
  let bestScore = -Infinity;
  for (let deg = -MAX_TILT_DEG; deg <= MAX_TILT_DEG; deg += STEP_DEG) {
    const theta = (deg * Math.PI) / 180;
    const score = alignmentScore(project(items, theta), tolerance);
    if (score > bestScore) {
      bestScore = score;
      best = theta;
    }
  }
  return best;
}

/** Groups OCR items into rows and joins them into parseable lines of text. */
export function itemsToLines(items: OcrItem[]): string[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [items[0].text];

  const height = textHeight(items);
  const theta = bestAngle(items, height);
  const projected = project(items, theta).sort((a, b) => a.v - b.v);

  const rowGap = ROW_GAP_FRACTION * height;
  const rows: Projected[][] = [];
  let current: Projected[] = [projected[0]];
  for (let i = 1; i < projected.length; i++) {
    if (projected[i].v - projected[i - 1].v > rowGap) {
      rows.push(current);
      current = [];
    }
    current.push(projected[i]);
  }
  rows.push(current);

  return rows.map((row) =>
    row
      .sort((a, b) => a.u - b.u)
      .map((p) => p.item.text)
      .join(' '),
  );
}

export function itemsToText(items: OcrItem[]): string {
  return itemsToLines(items).join('\n');
}
