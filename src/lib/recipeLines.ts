import type { RecipeIngredient, RecipeTip } from './api';

// Ingredient lines as written: scaled for more or fewer servings, and changed
// the way a grade tip says.

const FRACTIONS: [number, string][] = [
  [0.25, '¼'],
  [1 / 3, '⅓'],
  [0.5, '½'],
  [2 / 3, '⅔'],
  [0.75, '¾'],
];

/** 1.5 → "1½", 0.333 → "⅓", 2.4 → "2.4", 250 → "250". */
export function amount(n: number) {
  const whole = Math.floor(n);
  const part = n - whole;
  if (part < 0.05) return String(whole);
  if (part > 0.95) return String(whole + 1);
  const fraction = FRACTIONS.find(([value]) => Math.abs(part - value) < 0.05);
  if (fraction && n < 10) return `${whole || ''}${fraction[1]}`;
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

/** The amount a line starts with: "1 1/2 ", "1-1/2 ", "½ ", "1.3 ". */
const LEADING_AMOUNT = /^\s*(?:\d+\s*-\s*\d+\/\d+|\d+(?:[.,]\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+|[¼½¾⅓⅔])(?:\s*[¼½¾⅓⅔])?\s+/;
/** A range a line starts with: "2-3 ", "1 or 2 ", "2 to 3 ". */
const LEADING_RANGE = /^\s*(\d+(?:[.,]\d+)?)\s*(-|–|to|or)\s*(\d+(?:[.,]\d+)?)(?!\s*\/)\s+/;

/**
 * An ingredient line for `factor` times the recipe: the line as written with
 * its amount scaled, so "2 onions, sliced" stays itself. As written when it
 * has no amount.
 */
export function scaledLine(ing: RecipeIngredient, factor: number) {
  if (factor === 1 || ing.quantity == null) return ing.raw;
  const range = LEADING_RANGE.exec(ing.raw);
  if (range) {
    const [from, to] = [range[1], range[3]].map((n) => amount(Number(n.replace(',', '.')) * factor));
    return ing.raw.replace(LEADING_RANGE, `${from}–${to} `);
  }
  const scaled = amount(ing.quantity * factor);
  if (LEADING_AMOUNT.test(ing.raw)) return ing.raw.replace(LEADING_AMOUNT, `${scaled} `);
  return [scaled, ing.unit, ing.name ?? ing.raw].filter(Boolean).join(' ');
}

/** A tip, said plainly. */
export function tipText(tip: RecipeTip, ingredients: RecipeIngredient[]) {
  switch (tip.kind) {
    case 'leave_out':
      return `Leave out ${ingredients[tip.index]?.raw ?? 'one ingredient'}`;
    case 'halve':
      return ingredients[tip.index]
        ? `Use half: ${scaledLine(ingredients[tip.index], 0.5)}`
        : 'Use half of one ingredient';
    case 'together':
      return `Leave out ${tip.changes
        .map((c) => ingredients[c.index]?.raw)
        .filter(Boolean)
        .join(' and ')}`;
    case 'add_veg':
      return `Add ${tip.grams} g of vegetables`;
  }
}

/**
 * The ingredients with a tip's change made, or null for a tip that adds
 * something, which is for the person to choose. A halved line keeps its food.
 */
export function withTip(tip: RecipeTip, ingredients: RecipeIngredient[]): RecipeIngredient[] | null {
  if (tip.kind === 'add_veg') return null;
  const changes = tip.kind === 'together' ? tip.changes : [{ kind: tip.kind, index: tip.index }];
  return ingredients.flatMap((ing, index) => {
    const change = changes.find((c) => c.index === index);
    if (!change) return [ing];
    if (change.kind === 'leave_out') return [];
    return [
      {
        ...ing,
        raw: scaledLine(ing, 0.5),
        quantity: ing.quantity == null ? ing.quantity : ing.quantity / 2,
        grams: ing.grams == null ? null : ing.grams / 2,
      },
    ];
  });
}
