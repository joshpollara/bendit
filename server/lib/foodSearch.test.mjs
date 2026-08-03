import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildMatchPlan, matchFood, searchFoods, tokenize } from './foodSearch.mjs';

// Real names, copied in their published form — USDA writes the food first and
// the qualifiers last, which is exactly what breaks naive phrase matching.
const FOODS = [
  ['usda-1', 'usda', 'Chicken, broilers or fryers, breast, meat only, cooked, roasted', null, 165],
  ['usda-2', 'usda', 'Chicken, broilers or fryers, breast, meat and skin, cooked, fried, batter', null, 260],
  ['usda-3', 'usda', 'Chicken, broilers or fryers, thigh, meat only, cooked, roasted', null, 209],
  ['usda-4', 'usda', 'Rice, white, long-grain, regular, enriched, cooked', null, 130],
  ['usda-5', 'usda', 'Rice, brown, long-grain, cooked', null, 123],
  ['usda-6', 'usda', 'Egg, whole, cooked, scrambled', null, 149],
  ['usda-7', 'usda', 'Broccoli, cooked, boiled, drained, without salt', null, 35],
  ['usda-8', 'usda', 'Yogurt, Greek, plain, nonfat', null, 59],
  ['usda-9', 'usda', 'Sweet potato, cooked, baked in skin, flesh, without salt', null, 90],
  ['usda-10', 'usda', 'Avocados, raw, all commercial varieties', null, 160],
  ['usda-12', 'usda', 'Potatoes, boiled, cooked in skin, flesh, without salt', null, 87],
  ['off-1', 'openfoodfacts', 'Chicken Breast Fillets', 'Tesco', 106],
  ['off-2', 'openfoodfacts', 'Greek Style Yogurt', 'Fage', 97],
  ['off-3', 'openfoodfacts', 'Chocolate chip cookies', 'Albert Heijn', 480],
  ['seed-1', 'seed', 'Apple', null, 52],
  // A row with no nutrition: findable, but never the answer for an estimate.
  ['usda-11', 'usda', 'Chicken breast, unprepared', null, null],
];

let db;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE foods (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, source TEXT NOT NULL, kcal100 REAL
    );
    CREATE VIRTUAL TABLE foods_fts USING fts5(
      name, brand, content='foods', content_rowid='rowid', tokenize='porter unicode61'
    );
  `);
  const insert = db.prepare('INSERT INTO foods (id, source, name, brand, kcal100) VALUES (?, ?, ?, ?, ?)');
  for (const row of FOODS) insert.run(...row);
  db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')");
});

describe('tokenize', () => {
  it('drops filler that only prevents matches', () => {
    expect(tokenize('a serving of some fresh broccoli')).toEqual(['broccoli']);
  });

  it('normalizes plurals and accents so spelling variants still match', () => {
    expect(tokenize('sautéed potatoes')).toEqual(['sauteed', 'potato']);
    expect(tokenize('Avocados')).toEqual(['avocado']);
  });

  it('strips punctuation that would otherwise be parsed as FTS syntax', () => {
    expect(tokenize('chicken (breast) - grilled!')).toEqual(['chicken', 'breast', 'grilled']);
  });
});

describe('buildMatchPlan', () => {
  it('tries the full phrase before loosening it', () => {
    const plan = buildMatchPlan('grilled chicken breast');
    expect(plan[0]).toBe('"grilled" AND "chicken" AND "breast"');
    expect(plan[1]).toBe('"chicken" AND "breast"'); // cooking method dropped
  });

  it('neutralizes FTS syntax in user text instead of executing it', () => {
    // Two defences: tokenize strips the punctuation FTS treats as syntax, and
    // whatever survives is quoted as a literal term. An operator smuggled in a
    // food name must not run, error, or widen the result set.
    for (const attack of ['chicken" OR x', 'chicken NEAR/9 rice', 'chicken*"', '"" OR foods_fts']) {
      const [match] = buildMatchPlan(attack);
      expect(() =>
        db.prepare('SELECT 1 FROM foods_fts WHERE foods_fts MATCH ?').all(match),
      ).not.toThrow();
      // Never matches the whole table the way an injected OR would.
      expect(searchFoods(db, attack).length).toBeLessThan(FOODS.length);
    }
  });

  it('has nothing to search for in an empty query', () => {
    expect(buildMatchPlan('   ')).toEqual([]);
  });
});

describe('searchFoods — what a meal photo actually sends', () => {
  const top = (query) => searchFoods(db, query)[0]?.name;

  it('matches a phrase written the opposite way round to the data', () => {
    // "grilled chicken breast" → "Chicken, ..., breast, ..., roasted"
    expect(top('grilled chicken breast')).toMatch(/breast/);
    expect(top('grilled chicken breast')).toMatch(/^Chicken/);
  });

  it('prefers the plain preparation over the battered one', () => {
    expect(top('chicken breast')).toBe(
      'Chicken, broilers or fryers, breast, meat only, cooked, roasted',
    );
  });

  it('tells cuts apart', () => {
    expect(top('chicken thigh')).toMatch(/thigh/);
  });

  it('handles two-word foods where both words matter', () => {
    expect(top('brown rice')).toBe('Rice, brown, long-grain, cooked');
    expect(top('white rice')).toBe('Rice, white, long-grain, regular, enriched, cooked');
  });

  it('does not answer "potato" with a different vegetable that contains the word', () => {
    // "Sweet potato, cooked, baked in skin" covers every word of "boiled
    // potatoes" and out-ranked the real thing on relevance alone. A qualifier
    // in the leading segment changes what the food is.
    expect(top('boiled potatoes')).toMatch(/^Potatoes/);
    // And the sweet potato is still what you get when you ask for one.
    expect(top('sweet potato')).toMatch(/^Sweet potato/);
  });

  it('finds a food described loosely', () => {
    expect(top('scrambled eggs')).toMatch(/scrambled/);
    expect(top('a bowl of steamed broccoli')).toMatch(/Broccoli/);
    expect(top('baked sweet potato')).toMatch(/Sweet potato/);
  });

  it('prefers whole-food references over branded rows for a generic name', () => {
    // "greek yogurt" exists in both; the reference row is the better default.
    expect(searchFoods(db, 'greek yogurt')[0].source).toBe('usda');
  });

  it('still finds branded products by their brand', () => {
    expect(top('Fage')).toBe('Greek Style Yogurt');
  });

  it('returns nothing rather than a bad guess for an unknown food', () => {
    expect(searchFoods(db, 'zzzzz nonexistent foodstuff')).toEqual([]);
  });
});

describe('matchFood — the single answer the photo path commits to', () => {
  it('returns one match for a confident query', () => {
    expect(matchFood(db, 'grilled chicken breast')?.id).toMatch(/^usda-/);
  });

  it('never returns a food with no nutrition, however well the name matches', () => {
    // "Chicken breast, unprepared" is the closest name but has no kcal100.
    expect(matchFood(db, 'chicken breast unprepared')?.kcal100).not.toBeNull();
  });

  it('refuses when the match covers too little of the query', () => {
    expect(matchFood(db, 'chicken tikka masala with naan')).toBeNull();
  });

  it('refuses an empty query instead of returning an arbitrary row', () => {
    expect(matchFood(db, '')).toBeNull();
  });

  it('answers a generic name from the reference tables, not a packaged product', () => {
    // With 300,000 crowd-sourced products in the index, a short branded name
    // out-ranks the reference row on bm25 alone. A photo that says "greek
    // yogurt" means the food, not somebody's tub of it.
    expect(matchFood(db, 'greek yogurt')?.source).toBe('usda');
  });

  it('still falls back to a packaged product when nothing generic matches', () => {
    // "Chocolate chip cookies" exists only as an Open Food Facts row; refusing
    // it would lose the item from the meal entirely.
    expect(matchFood(db, 'chocolate chip cookies')?.source).toBe('openfoodfacts');
  });

  it('can be told to search everything, for callers that want a product', () => {
    const anywhere = matchFood(db, 'greek yogurt', { preferSources: [] });
    expect(anywhere).toBeTruthy();
  });
});
