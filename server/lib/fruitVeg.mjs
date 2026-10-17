// How much of a product is fruit, vegetables and legumes, from its
// ingredient list — the part of the Nutri-Score that nutrition tables don't
// state, so Picnic products were graded as if they had none.
//
// Only what the label says counts. A percentage stated for a fruit or
// vegetable ingredient is added up; one with no percentage adds nothing,
// however likely it is to be most of the product. The one exception is a list
// that is nothing but fruit and vegetables and additives ("Tomaten,
// zuurteregelaar: citroenzuur"), which is taken as 90%. Nuts and potatoes
// don't count, as in the algorithm, and nor does corn, which in a snack is a
// grain rather than a vegetable.

/** Word starts that name a fruit, vegetable or legume, in Dutch. */
const ROOTS = [
  'appel', 'peer', 'peren', 'sinaasappel', 'mandarijn', 'citroen', 'limoen', 'grapefruit', 'banaan', 'bananen',
  'aardbei', 'framboos', 'frambozen', 'bosbes', 'braam', 'bramen', 'kers', 'kersen', 'druif', 'druiven', 'mango',
  'ananas', 'perzik', 'abrikoos', 'abrikozen', 'pruim', 'kiwi', 'meloen', 'granaatappel', 'passievrucht',
  'drakenfruit', 'vijg', 'dadel', 'rozijn', 'cranberr', 'tomaat', 'tomaten',
  'sjalot', 'prei', 'knoflook', 'paprika', 'chilipeper', 'wortel', 'biet', 'bieten', 'spinazie', 'boerenkool',
  'kool', 'broccoli', 'bloemkool', 'spruit', 'courgette', 'aubergine', 'komkommer', 'andijvie', 'rucola',
  'selderij', 'venkel', 'asperge', 'champignon', 'paddenstoel', 'pompoen', 'groente', 'erwt', 'bonen', 'boon',
  'linzen', 'kikkererwt', 'peulvrucht', 'avocado', 'olijf', 'olijven', 'spinazie',
];
/** Short names that only count as whole words: "ui" isn't in "kruiden". */
const WORDS = new Set(['ui', 'uien', 'sla', 'peer', 'kool', 'fruit', 'vruchten', 'vruchtenpuree', 'fruitpuree']);
/** Parts of a word that make it something else: maïszetmeel, paprikapoeder, olijfolie. */
const NOT = /zetmeel|bloem|meel|olie|suiker|siroop|stroop|aroma|extract|poeder|bouillon|vezel|pinda|noot|noten|aardappel|smaak/;
/** Ingredients that are there for keeping, colour or taste, in small amounts. */
const ADDITIVE =
  /aroma|^(zuurteregelaar|voedingszuur|antioxidant|anti-oxidant|conserveermiddel|citroenzuur|ascorbinezuur|kleurstof|verdikkingsmiddel|emulgator|stabilisator|geleermiddel|zout|zeezout|peper|kruiden|specerijen|aroma|e\s?\d{3})/;

/** Splits a list at commas and semicolons that aren't inside brackets. */
function topLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** An ingredient's own name: before any bracket or colon, without its percentage. */
const nameOf = (item) =>
  item
    .toLowerCase()
    .split(/[(:[]/)[0]
    .replace(/\d+(?:[.,]\d+)?\s*%/g, ' ')
    .replace(/[*¹²³]/g, '')
    .trim();

const isFruitVeg = (name) => {
  const tokens = name.split(/[^a-zà-ÿ]+/).filter(Boolean);
  return tokens.some(
    (t) => !NOT.test(t) && (WORDS.has(t) || ROOTS.some((root) => root.length >= 4 && t.startsWith(root))),
  );
};

/** The percentage stated for an ingredient itself: "80%" or "(100%)", not its parts'. */
function percentOf(item) {
  const own = item.split('(')[0];
  const direct = /(\d+(?:[.,]\d+)?)\s*%/.exec(own);
  if (direct) return Number(direct[1].replace(',', '.'));
  const bracketed = /^[^(]*\(\s*(\d+(?:[.,]\d+)?)\s*%\s*\)/.exec(item);
  return bracketed ? Number(bracketed[1].replace(',', '.')) : null;
}

/**
 * The share, 0–100, of fruit, vegetables and legumes the ingredient list
 * states; null when it says nothing that can be counted.
 */
export function fruitVegShare(ingredients) {
  const text = String(ingredients ?? '')
    .replace(/^\s*ingredi[eë]nten\s*:?\s*/i, '')
    .split(/\n|kan sporen/i)[0];
  const items = topLevel(text.replace(/\.\s*$/, ''));
  if (items.length === 0) return null;
  let stated = 0;
  let any = false;
  for (const item of items) {
    const name = nameOf(item);
    if (!isFruitVeg(name)) continue;
    const pct = percentOf(item);
    if (pct != null) {
      stated += pct;
      any = true;
    }
  }
  if (any) return Math.min(100, Math.round(stated * 10) / 10);
  // Nothing but fruit and vegetables, and what keeps them.
  const main = items.filter((item) => !ADDITIVE.test(nameOf(item)));
  if (main.length > 0 && main.every((item) => isFruitVeg(nameOf(item)))) return 90;
  return null;
}
