// The same product, numbered several ways.
//
// A twelve-digit UPC-A and a thirteen-digit EAN-13 with a leading zero are the
// same barcode; which one a database holds depends on who typed it in. Open
// Food Facts has both. Looking up only the form the scanner reported misses
// products that are sitting right there, so a lookup tries the equivalents.
//
// Deliberately narrow: only zero-padding at the front, which is the one
// difference that is genuinely the same number. Stripping arbitrary leading
// zeros would let "0000000000005" find a food numbered "5".

const digitsOnly = (raw) => String(raw ?? '').replace(/\D/g, '');

/** Every form of `code` worth looking up, most likely first. */
export function barcodeVariants(code) {
  const digits = digitsOnly(code);
  if (!digits) return [];

  const variants = [digits];
  // UPC-A ↔ EAN-13.
  if (digits.length === 12) variants.push(`0${digits}`);
  if (digits.length === 13 && digits.startsWith('0')) variants.push(digits.slice(1));
  // GTIN-14 is a case pack: the trailing 13 identify the product inside it.
  if (digits.length === 14 && digits.startsWith('0')) variants.push(digits.slice(1));
  return variants;
}
