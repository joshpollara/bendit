// Picnic marks a product it can't deliver with an UNAVAILABLE decorator: a
// reason, a short explanation, and sometimes its own suggested replacements.
// (The shape is the one picnic-api documents; none was in a live cart when
// this was written.)

export interface PicnicReplacement {
  id: string;
  name: string;
  unit_quantity: string;
  display_price: number;
  image_id: string;
  max_count: number;
}

export interface Unavailable {
  reason: string;
  explanation: string | null;
  replacements: PicnicReplacement[];
}

type Decorated = { decorators?: { type: string; [key: string]: unknown }[] } | undefined;

/** The UNAVAILABLE decorator on an article or the line it's in, if either has one. */
export function unavailableOf(...sources: Decorated[]): Unavailable | null {
  for (const source of sources) {
    const d = source?.decorators?.find((x) => x.type === 'UNAVAILABLE');
    if (!d) continue;
    const explanation = (d.explanation as { short_explanation?: string } | undefined)?.short_explanation ?? null;
    const replacements = Array.isArray(d.replacements)
      ? (d.replacements as PicnicReplacement[]).filter((r) => r && typeof r.id === 'string')
      : [];
    return { reason: String(d.reason ?? ''), explanation, replacements };
  }
  return null;
}
