// A Picnic product as a food.
//
// Picnic's product page carries nutrition as a text section — "Voedingswaarde"
// — rather than as fields: a "Per 100 g" header, then each nutrient's name on
// one line and its value on the next, in the shop's own language and number
// format ("4,6g", "1.145 kJ"). Fresh produce usually has no such section at
// all, and then there is nothing to read.

/** The nutrition section's title, in each language Picnic delivers in. */
const SECTION = /^(voedingswaarde|nährwert|valeurs? nutritionnelles?)/i;

// Matched against a lower-cased line. Sub-rows ("waarvan suikers") are checked
// before the rows they belong to, so "of which saturated" never lands on fat.
const FIELDS = [
  ['sugar100', /^(waarvan suikers|davon zucker|dont sucres)/],
  ['satFat100', /^(waarvan verzadigd|davon gesättigte|dont acides gras saturés)/],
  ['carbs100', /^(koolhydraten|kohlenhydrate|glucides)/],
  ['fat100', /^(vet|fett|matières grasses|lipides)\b/],
  ['fiber100', /^(vezels|voedingsvezel|ballaststoffe|fibres)/],
  ['protein100', /^(eiwit|eiweiß|eiweiss|protéines)/],
  ['salt100', /^(zout|salz|sel)\b/],
];

/** "1.145" → 1145, "4,6" → 4.6, "16" → 16. Dots group thousands; commas are decimals. */
function number(text) {
  const match = String(text).match(/<?\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?/);
  if (!match) return null;
  const whole = match[1].replace(/\./g, '');
  return Number(match[2] ? `${whole}.${match[2]}` : whole);
}

/**
 * Per-100 nutrition from a "Voedingswaarde" section, or null when it has no
 * energy figure — a food without calories is no use for logging.
 */
export function parsePicnicNutrition(content) {
  const lines = String(content ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const header = lines.find((line) => /^(per|pro|pour)\s+100/i.test(line)) ?? '';
  const out = { basis: /100\s*ml/i.test(header) ? 'ml' : 'g' };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    // Energy is written over several lines: "197 kJ /", "kcal", "47 kcal".
    // Only the kcal figure is taken; kJ is the fallback.
    if (/kcal/.test(line) && number(line) != null && out.kcal100 == null) {
      out.kcal100 = number(line);
      continue;
    }
    if (/\bkj\b/.test(line) && number(line) != null && out.kj100 == null) {
      out.kj100 = number(line);
      continue;
    }
    const field = FIELDS.find(([, pattern]) => pattern.test(line));
    if (!field) continue;
    // The value is on the same line when the label carries it, else the next.
    const value = number(line) ?? number(lines[i + 1] ?? '');
    if (value != null && out[field[0]] == null) out[field[0]] = value;
  }

  if (out.kcal100 == null && out.kj100 != null) out.kcal100 = Math.round(out.kj100 / 4.184);
  delete out.kj100;
  if (out.kcal100 == null) return null;

  // Labels state salt; everything here counts sodium. Salt is 40% sodium.
  if (out.salt100 != null) out.sodiumMg100 = Math.round(out.salt100 * 400);
  delete out.salt100;
  return out;
}

/** "400 gram" → 400, "1.5 liter" → 1500, "6 x 330 ml" → 1980; null for "4 stuks". */
export function packGrams(unitQuantity) {
  const match = String(unitQuantity ?? '')
    .toLowerCase()
    .match(/(?:(\d+)\s*x\s*)?(\d+(?:[.,]\d+)?)\s*(kg|kilo|gram|g|liter|l|ml|cl)\b/);
  if (!match) return null;
  const count = Number(match[1] ?? 1);
  const amount = Number(match[2].replace(',', '.'));
  const scale = { kg: 1000, kilo: 1000, gram: 1, g: 1, liter: 1000, l: 1000, ml: 1, cl: 10 }[match[3]];
  return Math.round(count * amount * scale);
}

const round1 = (value) => (value == null ? null : Math.round(value * 10) / 10);

/**
 * The food record for a Picnic product, or null when its page has no
 * nutrition to read. `name` stands in for the product name, which Picnic's
 * details page currently comes back without.
 */
export function picnicFood(details, { name } = {}) {
  const section = details?.infoSections?.find((s) => SECTION.test(s.title));
  const per100 = section && parsePicnicNutrition(section.content);
  if (!per100) return null;

  const unit = per100.basis;
  const pack = packGrams(details.unitQuantity);
  const per = (value) => round1(value);
  return {
    id: `picnic-${details.id}`,
    name: details.name || name || details.id,
    brand: details.brand ?? null,
    source: 'picnic',
    sourceId: details.id,
    basis: unit,
    servingLabel: `100 ${unit}`,
    servingGrams: 100,
    caloriesPerServing: Math.round(per100.kcal100),
    protein: per(per100.protein100),
    carbs: per(per100.carbs100),
    fat: per(per100.fat100),
    kcal100: per100.kcal100,
    protein100: per100.protein100 ?? null,
    carbs100: per100.carbs100 ?? null,
    fat100: per100.fat100 ?? null,
    fiber100: per100.fiber100 ?? null,
    sugar100: per100.sugar100 ?? null,
    satFat100: per100.satFat100 ?? null,
    sodiumMg100: per100.sodiumMg100 ?? null,
    servings: [
      { label: `100 ${unit}`, grams: 100 },
      ...(pack && pack !== 100 ? [{ label: `Pack (${details.unitQuantity})`, grams: pack }] : []),
    ],
  };
}
