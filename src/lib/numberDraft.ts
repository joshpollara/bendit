/**
 * What a number field's text is worth, or null if it isn't a usable number yet.
 * Blank, malformed and out-of-range drafts are all null, so a field can be
 * emptied and retyped without the half-typed text becoming a value.
 */
export function parseNumberDraft(
  draft: string,
  { allowZero = false }: { allowZero?: boolean } = {},
): number | null {
  const number = Number(draft);
  if (draft.trim() === '' || !Number.isFinite(number)) return null;
  return number > 0 || (allowZero && number === 0) ? number : null;
}
