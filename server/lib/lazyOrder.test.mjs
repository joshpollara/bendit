import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLazyOrder } from './lazyOrder.mjs';
import { createHistoryTables } from './picnicHistory.mjs';
import { createMealPlanTables } from './mealPlan.mjs';
import { createPicnicShoppingTables } from './picnicShopping.mjs';
import { createRecipeTables } from './recipeStore.mjs';
import { createUser, createUsersTable } from './users.mjs';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

const recipePage = (name, ingredients) =>
  `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Recipe',
    name,
    recipeYield: '4',
    recipeIngredient: ingredients,
    nutrition: { calories: '400 kcal', proteinContent: '30 g' },
  })}</script>`;

const PAGES = {
  'https://site.test/cod/': recipePage('Baked Cod', ['400 g cod fillet', '1 lemon']),
  'https://site.test/salmon/': recipePage('Salmon Bowl', ['300 g salmon', '200 g rice']),
  'https://site.test/tacos/': recipePage('Chicken Tacos', ['500 g chicken breast', '8 tortillas', '1 tsp salt']),
  'https://site.test/soup/': recipePage('Lentil Soup', ['300 g red lentils', '1 onion']),
  'https://site.test/no-recipe/': '<html>just a story</html>',
};

const POSTS = [
  { title: '7 Day Meal Plan', url: 'https://site.test/plan/', site: 'Site', imported: false },
  { title: 'Chicken Tacos', url: 'https://site.test/tacos/', site: 'Site', imported: false },
  { title: 'A Story', url: 'https://site.test/no-recipe/', site: 'Site', imported: false },
  { title: 'Lentil Soup', url: 'https://site.test/soup/', site: 'Site', imported: false },
  { title: 'Old Favourite', url: 'https://site.test/old/', site: 'Site', imported: true },
];

/** A model that answers each kind of question the way a sensible one would. */
function fakeModel() {
  const asked = [];
  return {
    model: 'fake',
    configured: true,
    asked,
    async extract({ prompt, schema, text }) {
      asked.push({ prompt, text });
      const keys = Object.keys(schema.properties);
      if (keys[0] === 'searches') return { data: { searches: [prompt.includes('fish') ? 'salmon' : 'chicken tacos'] } };
      if (keys[0] === 'picks') {
        // The list as numbered for it: pick tacos, the story, then soup.
        const numbered = text.split('\n').filter((l) => /^\d+\. /.test(l));
        const indexOf = (title) => numbered.findIndex((l) => l.includes(title));
        return {
          data: {
            picks: (prompt.includes('asked for: fish')
              ? ['Baked Cod', 'Chicken Tacos', 'Salmon Bowl']
              : ['Chicken Tacos', 'A Story', 'Lentil Soup']
            )
              .filter((t) => indexOf(t) >= 0)
              .map((t) => ({ index: indexOf(t), reason: `likes ${t}`, fitsRequest: !t.includes('Chicken') })),
          },
        };
      }
      const lines = text.split('\n').filter((l) => /^\d+\. /.test(l));
      if (prompt.includes('Dutch supermarket search')) {
        return {
          data: {
            lines: lines.map((l) => {
              const index = Number(l.split('.')[0]);
              return { index, search: l.replace(/^\d+\.\s*/, '').replace(/\s*\(×.*$/, ''), pantry: /salt/.test(l) };
            }),
          },
        };
      }
      return { data: { lines: lines.map((l) => ({ index: Number(l.split('.')[0]), option: 0, packs: 1 })) } };
    },
  };
}

const FISH = [
  { title: 'Baked Cod', url: 'https://site.test/cod/', site: 'Site', imported: false },
  { title: 'Chicken Tacos', url: 'https://site.test/tacos/', site: 'Site', imported: false },
  { title: 'Salmon Bowl', url: 'https://site.test/salmon/', site: 'Site', imported: false },
];
const sites = { list: () => [{ id: 'site' }], posts: async (q) => (/fish|salmon|cod/.test(q) ? FISH : POSTS) };
// One product per search: the search term, as a product.
const search = async (term) => [
  { id: `s${term.length}${term.charCodeAt(0)}`, name: `Picnic ${term}`, unit_quantity: '500 gram', display_price: 250, image_id: null },
];
const fetch = async (url) => PAGES[url] ?? '';

let db;
let ann;
beforeEach(() => {
  db = new Database(':memory:');
  createUsersTable(db);
  createRecipeTables(db);
  createMealPlanTables(db);
  createPicnicShoppingTables(db);
  createHistoryTables(db);
  db.exec(`
    CREATE TABLE vision_requests (id TEXT PRIMARY KEY, createdAt TEXT, task TEXT, promptVersion TEXT,
      model TEXT, imageHash TEXT, imageBytes INTEGER, status TEXT, errorCode TEXT, latencyMs INTEGER,
      inputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER, responseJson TEXT, userId TEXT);
    CREATE TABLE foods (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, source TEXT NOT NULL,
      servingLabel TEXT, servingGrams REAL, caloriesPerServing REAL, protein REAL, carbs REAL, fat REAL,
      kcal100 REAL, protein100 REAL, carbs100 REAL, fat100 REAL, ownerId TEXT);
    CREATE TABLE food_servings (id TEXT PRIMARY KEY, foodId TEXT NOT NULL, label TEXT NOT NULL, grams REAL NOT NULL,
      isDefault INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE food_log (id TEXT PRIMARY KEY, planItemId TEXT, userId TEXT);
    CREATE VIRTUAL TABLE foods_fts USING fts5(name, brand, content='foods', content_rowid='rowid');
  `);
  ann = createUser(db, 'ann', 'password-ann').id;
  createUser(db, 'ben', 'password-ben');
  // Milk every fortnight, last 16 days ago: due.
  const delivery = db.prepare(
    "INSERT INTO picnic_deliveries VALUES (?, 'COMPLETED', ?, ?, 1000, ?)",
  );
  const item = db.prepare('INSERT INTO picnic_delivery_items VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, ago] of [['d1', 30], ['d2', 16]]) {
    delivery.run(id, daysAgo(ago), daysAgo(ago + 1), daysAgo(0));
    item.run(id, 'milk', 'Melk', '1 liter', null, 2);
  }
});

const saveFood = (food) =>
  db
    .prepare(
      `INSERT OR REPLACE INTO foods (id, name, source, servingLabel, servingGrams, caloriesPerServing, protein, carbs, fat,
        kcal100, protein100, carbs100, fat100, ownerId)
       VALUES (@id, @name, @source, @servingLabel, @servingGrams, @caloriesPerServing, @protein, @carbs, @fat,
        @kcal100, @protein100, @carbs100, @fat100, @ownerId)`,
    )
    .run({ protein: null, carbs: null, fat: null, ...food });

describe('making an order', () => {
  it('puts due usuals and new recipes from the sites together, as Picnic products', async () => {
    const model = fakeModel();
    const order = createLazyOrder({ db, model, sites, search, fetch, now: () => NOW });
    const result = await order.build({ dinners: 2, servings: 2, userId: ann });

    // Meal plans and imported recipes aren't offered; a page without a recipe is passed over.
    const pickList = model.asked[1].text;
    expect(pickList).not.toContain('Meal Plan');
    expect(pickList).not.toContain('Old Favourite');
    expect(result.recipes.map((r) => [r.title, r.reason, r.servings])).toEqual([
      ['Chicken Tacos', 'likes Chicken Tacos', 2],
      ['Lentil Soup', 'likes Lentil Soup', 2],
    ]);

    // Milk because it's due; each recipe line as a product; salt left in the cupboard.
    expect(result.items.map((i) => [i.name, i.quantity, i.for])).toEqual([
      ['Melk', 2, ['Usual']],
      ['Picnic 500 g chicken breast', 1, ['Chicken Tacos']],
      ['Picnic 8 tortillas', 1, ['Chicken Tacos']],
      ['Picnic 300 g red lentils', 1, ['Lentil Soup']],
      ['Picnic 1 onion', 1, ['Lentil Soup']],
    ]);
    // Half the recipe's 4 servings: the model is told so.
    expect(model.asked[3].text).toContain('500 g chicken breast (×0.5');
    // Four calls, logged as one build.
    const logged = db.prepare('SELECT task, imageHash, status FROM vision_requests').all();
    expect(logged).toHaveLength(4);
    expect(new Set(logged.map((r) => r.imageHash)).size).toBe(1);
  });

  it('sticks to what was asked for', async () => {
    const model = fakeModel();
    const order = createLazyOrder({ db, model, sites, search, fetch, now: () => NOW });
    const result = await order.build({ dinners: 3, wish: '  fish ', userId: ann });
    // Only what searching for fish found is offered, and a pick that isn't fish is dropped.
    expect(model.asked[1].text).not.toContain('Lentil Soup');
    expect(result.recipes.map((r) => r.title)).toEqual(['Baked Cod', 'Salmon Bowl']);
  });

  it('just reorders the usuals when asked for no dinners', async () => {
    const model = fakeModel();
    const result = await createLazyOrder({ db, model, sites, search, fetch, now: () => NOW }).build({
      dinners: 0,
      userId: ann,
    });
    expect(result.items.map((i) => i.name)).toEqual(['Melk']);
    expect(model.asked).toHaveLength(0);
  });

  it('stops at the daily limit', async () => {
    const order = createLazyOrder({ db, model: fakeModel(), sites, search, fetch, now: () => NOW, dailyLimit: 1 });
    await order.build({ dinners: 1, userId: ann });
    await expect(order.build({ dinners: 1, userId: ann })).rejects.toThrow(/today's limit/);
  });
});

describe('keeping the recipes', () => {
  it('saves them, remembers their products, and plans them on the next free dinners', async () => {
    const order = createLazyOrder({ db, model: fakeModel(), sites, search, fetch, now: () => NOW });
    const { recipes } = await order.build({ dinners: 2, servings: 2, userId: ann });
    const kept = await order.keep(recipes, { userId: ann, saveFood });

    expect(kept.map((k) => [k.name, k.date])).toEqual([
      ['Chicken Tacos', '2026-10-18'],
      ['Lentil Soup', '2026-10-19'],
    ]);
    // The page's own nutrition is used.
    expect(db.prepare('SELECT nutritionFrom FROM recipes').all().map((r) => r.nutritionFrom)).toEqual(['page', 'page']);
    // The lentils line is now bought as the product the model picked.
    expect(db.prepare("SELECT name FROM picnic_choices WHERE itemKey = 'name:red lentils'").get()).toEqual({
      name: 'Picnic 300 g red lentils',
    });
    // Everyone eats, a serving each.
    const portions = db.prepare('SELECT servings FROM meal_plan_portions').all();
    expect(portions.map((p) => p.servings)).toEqual([1, 1, 1, 1]);

    // Keeping again doesn't save a second copy, and takes the next free days.
    const again = await order.keep(recipes.slice(0, 1), { userId: ann, saveFood });
    expect(again[0].date).toBe('2026-10-20');
    expect(db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n).toBe(2);
  });
});
