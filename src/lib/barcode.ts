// The number on a package, and whether to believe it.
//
// A camera misreads. A person mistypes. Both produce a plausible-looking string
// of digits that will miss in every database and send the flow down the
// label-photo path for no reason. Every GTIN carries a check digit precisely so
// that a wrong read can be recognised as wrong, so it's checked before anything
// is looked up.
//
// This file is arithmetic only — no camera, no decoding. That lives in
// barcodeScan.ts, which uses these.

/** Digits only. Scanners return the odd space; people type them. */
export function normalizeBarcode(raw: string): string {
  return String(raw ?? '').replace(/\D/g, '');
}

/** The lengths a real product code comes in: EAN-8, UPC-A, EAN-13, GTIN-14. */
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/**
 * The GTIN check digit: weight the digits 3 and 1 alternately from the right,
 * and the total including the check digit must land on a multiple of ten.
 */
export function isValidBarcode(raw: string): boolean {
  const digits = normalizeBarcode(raw);
  if (!GTIN_LENGTHS.has(digits.length)) return false;

  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    // Rightmost digit (the check digit) has weight 1, and weights alternate
    // leftwards, so the weight depends on distance from the end.
    const weight = (digits.length - i) % 2 === 0 ? 3 : 1;
    sum += Number(digits[i]) * weight;
  }
  return sum % 10 === 0;
}

/**
 * UPC-E is a UPC-A with runs of zeros squeezed out, and scanners hand back the
 * squeezed form. No database stores it that way, so it has to be expanded or
 * the lookup misses every time. The last digit of the six-digit body says how
 * the zeros were removed.
 *
 * Only meaningful when the scanner reported the format as UPC-E: an eight-digit
 * code is otherwise an EAN-8, which means something else entirely.
 */
export function expandUpcE(raw: string): string {
  const digits = normalizeBarcode(raw);
  if (digits.length !== 8) return digits;

  const system = digits[0];
  const check = digits[7];
  const body = digits.slice(1, 7);
  const [a, b, c, d, e, mode] = body;

  let middle: string;
  switch (mode) {
    case '0':
    case '1':
    case '2':
      middle = `${a}${b}${mode}0000${c}${d}${e}`;
      break;
    case '3':
      middle = `${a}${b}${c}00000${d}${e}`;
      break;
    case '4':
      middle = `${a}${b}${c}${d}00000${e}`;
      break;
    default: // 5–9: the last digit is itself the final digit of the product code
      middle = `${a}${b}${c}${d}${e}0000${mode}`;
      break;
  }
  return `${system}${middle}${check}`;
}
