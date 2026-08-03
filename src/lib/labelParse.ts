// Pulls numbers out of OCR'd nutrition-panel text. Pure and synchronous so it
// can be tested against real-world label transcriptions.
//
// Two panel conventions matter here:
//   • US-style: one column, "per serving", with a stated serving size.
//   • EU/NL-style: a "per 100 g" column, sometimes with a per-portion column
//     beside it. Values are read from the first column, and `basis` says which
//     it was so the caller can rescale to a serving the user actually eats.

export type Basis = 'serving' | '100g' | '100ml';

export interface ParsedLabel {
  basis: Basis | null;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  servingLabel: string | null;
  servingGrams: number | null;
  /** Field names that were found, for telling the user what to check. */
  found: string[];
}

const KJ_PER_KCAL = 4.184;

// Sub-nutrients and other rows that must never be mistaken for the main macro.
const EXCLUDE =
  /\b(waarvan|of which|saturat|verzadig|suiker|sugar|trans|mono|poly|onverzadig|fibre|fiber|vezel|zout|salt|sodium|natrium|cholesterol|vitamin)/;

const KEYWORDS = {
  protein: /\b(protein|eiwit)/,
  carbs: /\b(carbohydrate|carbs?|koolhydra)/,
  fat: /\b(fat|vet)/,
  energy: /\b(calories|energie|energy|kcal|kj)\b/,
} as const;

/**
 * OCR reliably confuses letters with digits inside numbers. Only rewrite a
 * token when it is already mostly numeric — "1O5" becomes "105", while a word
 * like "olie" is left alone.
 */
function repairNumbers(line: string): string {
  return line.replace(/[\dOoIlSB.,]+/g, (token) => {
    const digits = (token.match(/\d/g) ?? []).length;
    if (digits === 0 || digits < token.replace(/[.,]/g, '').length - 2) return token;
    return token.replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  });
}

export function normalize(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => repairNumbers(l).toLowerCase().replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** First number in a string, tolerating a decimal comma. */
function firstNumber(s: string): number | null {
  const m = s.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads a gram value, correcting Tesseract's most consistent mistake on these
 * panels: the unit "g" is read as the digit 9 and glued onto the number, so
 * "3g" arrives as "39" and "28,5 g" as "28,59".
 *
 * The correction only fires when no unit letter actually follows the number,
 * which makes it safe in both directions — "19 g" keeps its unit and is left
 * alone, while a real "29 g" whose unit was eaten ("299") drops back to 29.
 */
function gramsAfter(line: string, keyword: RegExp): number | null {
  const m = line.match(keyword);
  if (!m || m.index == null) return null;
  const rest = line.slice(m.index + m[0].length);
  const value = rest.match(/(\d+(?:[.,]\d+)?)\s*(g\b|gram|mg\b|%)?/);
  if (!value?.[1]) return null;

  let token = value[1];
  const unit = value[2];
  if (!unit && /9$/.test(token) && token.replace(/[.,]/g, '').length > 1) {
    token = token.slice(0, -1).replace(/[.,]$/, '');
  }
  const n = Number(token.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return unit === 'mg' ? n / 1000 : n;
}

/** The number that follows the keyword match, not one that precedes it. */
function numberAfter(line: string, keyword: RegExp): number | null {
  const m = line.match(keyword);
  if (!m || m.index == null) return null;
  return firstNumber(line.slice(m.index + m[0].length));
}

/**
 * Values OCR can't have got right. A null asks the user for one number; a
 * plausible-looking wrong number quietly corrupts their log.
 */
function plausibleGrams(v: number | null, basis: Basis | null): number | null {
  if (v == null) return null;
  const max = basis === 'serving' ? 200 : 100; // grams of a macro
  return v >= 0 && v <= max ? v : null;
}

function plausibleCalories(v: number | null, basis: Basis | null): number | null {
  if (v == null) return null;
  const max = basis === 'serving' ? 2000 : 900; // 900 kcal/100g ≈ pure fat
  return v > 0 && v <= max ? v : null;
}

function parseEnergy(line: string): number | null {
  // A kcal figure wins outright; many EU labels print "1450 kJ / 345 kcal".
  const kcal = line.match(/(\d+(?:[.,]\d+)?)\s*(?:kcal|cal\b)/);
  if (kcal) return Math.round(Number(kcal[1].replace(',', '.')));

  const kj = line.match(/(\d+(?:[.,]\d+)?)\s*kj/);
  if (kj) return Math.round(Number(kj[1].replace(',', '.')) / KJ_PER_KCAL);

  // US panels: "Calories 150" with the unit left implicit.
  if (/\b(calories|energie|energy)\b/.test(line)) {
    const n = numberAfter(line, /\b(calories|energie|energy)\b/);
    // A stray "% daily value" or serving count would be nonsense as calories.
    if (n != null && n >= 5 && n <= 2000) return Math.round(n);
  }
  return null;
}

function parseBasis(lines: string[]): Basis | null {
  for (const line of lines) {
    if (/per\s*100\s*ml/.test(line)) return '100ml';
    if (/per\s*100\s*(g|gram)/.test(line)) return '100g';
  }
  for (const line of lines) {
    if (/(serving size|portiegrootte|per portie|per serving|portie)/.test(line)) return 'serving';
  }
  return null;
}

function parseServing(lines: string[]): { label: string | null; grams: number | null } {
  for (const line of lines) {
    const m = line.match(/(serving size|portiegrootte|per portie|serveergrootte)\s*[:\-]?\s*(.+)/);
    if (!m || !m[2].trim()) continue;

    // The same eaten "g" shows up here: "1/2 cup dry (40g)" arrives as "(409)".
    const label = m[2].trim().replace(/\((\d+(?:[.,]\d+)?)9\)/, '($1g)');
    const inner = label.match(/\(([^)]*\d[^)]*)\)/)?.[1];
    const source = inner ?? label;
    const withUnit = source.match(/(\d+(?:[.,]\d+)?)\s*(?:g\b|gram)/);
    const grams = withUnit ? Number(withUnit[1].replace(',', '.')) : null;
    return { label, grams };
  }
  return { label: null, grams: null };
}

export function parseLabel(text: string): ParsedLabel {
  const lines = normalize(text);
  const basis = parseBasis(lines);
  const serving = parseServing(lines);

  let calories: number | null = null;
  let protein: number | null = null;
  let carbs: number | null = null;
  let fat: number | null = null;

  for (const line of lines) {
    if (calories == null && KEYWORDS.energy.test(line)) {
      calories = plausibleCalories(parseEnergy(line), basis);
    }
    if (EXCLUDE.test(line)) continue; // "of which sugars", "saturated fat", …
    if (protein == null && KEYWORDS.protein.test(line)) {
      protein = plausibleGrams(gramsAfter(line, KEYWORDS.protein), basis);
    }
    if (carbs == null && KEYWORDS.carbs.test(line)) {
      carbs = plausibleGrams(gramsAfter(line, KEYWORDS.carbs), basis);
    }
    if (fat == null && KEYWORDS.fat.test(line)) {
      fat = plausibleGrams(gramsAfter(line, KEYWORDS.fat), basis);
    }
  }

  const found: string[] = [];
  if (calories != null) found.push('calories');
  if (protein != null) found.push('protein');
  if (carbs != null) found.push('carbs');
  if (fat != null) found.push('fat');
  if (serving.grams != null) found.push('serving size');

  return {
    basis,
    calories,
    protein,
    carbs,
    fat,
    servingLabel: serving.label,
    servingGrams: basis === '100g' ? (serving.grams ?? 100) : serving.grams,
    found,
  };
}

/** Scale per-100g (or per-100ml) values to the grams the user actually eats. */
export function rescale(value: number | null, fromGrams: number, toGrams: number): number | null {
  if (value == null || !fromGrams || !toGrams) return null;
  const scaled = (value * toGrams) / fromGrams;
  return Math.round(scaled * 10) / 10;
}
