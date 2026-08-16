import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecipeFromUrlHandler } from './recipeRoute.mjs';
import { createVisionExtractHandler } from './visionRoute.mjs';

// The real vision route is wired up here rather than a stand-in for it: a page
// with no structured data is read as *text*, and a route that only accepted an
// image turned every such page into "No image was sent" — a failure a stubbed
// vision handler would have happily reproduced as a success.
//
// The provider is still a stub. Nothing reaches a model.

const READ = {
  name: 'Pancakes',
  ingredients: ['200 g plain flour', '2 eggs'],
  servings: 4,
  servingsStated: true,
};

const withJsonLd = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@type': 'Recipe',
  name: 'Published pancakes',
  recipeIngredient: ['200 g plain flour', '2 eggs'],
  recipeYield: '4 servings',
})}</script></head><body>Pancakes</body></html>`;

const withoutJsonLd = '<html><body><h1>Pancakes</h1><p>200 g plain flour</p><p>2 eggs</p></body></html>';

let db;
let provider;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE foods (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, source TEXT NOT NULL,
      servingLabel TEXT, servingGrams REAL, ownerId TEXT,
      kcal100 REAL, protein100 REAL, carbs100 REAL, fat100 REAL
    );
    CREATE TABLE food_servings (
      id TEXT PRIMARY KEY, foodId TEXT NOT NULL, label TEXT NOT NULL,
      grams REAL NOT NULL, isDefault INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE foods_fts USING fts5(
      name, brand, content='foods', content_rowid='rowid', tokenize='porter unicode61'
    );
    CREATE TABLE vision_requests (
      id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, task TEXT NOT NULL,
      promptVersion TEXT NOT NULL, model TEXT NOT NULL, imageHash TEXT NOT NULL,
      imageBytes INTEGER NOT NULL, status TEXT NOT NULL, errorCode TEXT,
      latencyMs INTEGER, inputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER,
      responseJson TEXT, userId TEXT, mealPhotoRunId TEXT
    );
  `);
  db.exec(
    `INSERT INTO foods (id, name, source, servingLabel, servingGrams, kcal100)
     VALUES ('usda-flour', 'Wheat flour, white, all-purpose, enriched', 'usda', '100 g', 100, 364)`,
  );
  db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')");

  provider = {
    configured: true,
    model: 'gemini-3.1-flash-lite',
    extract: vi.fn(async () => ({
      data: READ,
      raw: JSON.stringify(READ),
      model: 'gemini-3.1-flash-lite',
      latencyMs: 640,
      usage: { inputTokens: 2100, outputTokens: 120, totalTokens: 2220 },
    })),
  };
});

const fromUrl = (html) =>
  createRecipeFromUrlHandler({
    db,
    visionHandler: createVisionExtractHandler({ db, provider }),
    fetch: async () => html,
  });

async function call(handler) {
  const res = { statusCode: 200, body: null };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (payload) => ((res.body = payload), res);
  await handler({ body: { url: 'https://example.com/pancakes' }, userId: 'u1' }, res);
  return res;
}

describe('POST /api/recipes/from-url', () => {
  it('reads a page that publishes its own recipe without calling the model', async () => {
    const res = await call(fromUrl(withJsonLd));
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe('Published pancakes');
    expect(res.body.readBy).toBe('page');
    expect(provider.extract).not.toHaveBeenCalled();
  });

  it('hands the text of a page that publishes none to the model', async () => {
    const res = await call(fromUrl(withoutJsonLd));

    expect(res.statusCode).toBe(200);
    expect(res.body.readBy).toBe('model');
    expect(res.body.name).toBe('Pancakes');
    expect(res.body.ingredients).toHaveLength(2);
    // Priced from the food database, as every other route prices things.
    expect(res.body.ingredients[0].food.id).toBe('usda-flour');

    const sent = provider.extract.mock.calls[0][0];
    expect(sent.text).toContain('200 g plain flour');
    expect(sent.imageBase64).toBeFalsy();
  });

  it('logs the call, so a text read counts like any other', async () => {
    await call(fromUrl(withoutJsonLd));
    const [row] = db.prepare('SELECT * FROM vision_requests').all();
    expect(row).toMatchObject({ task: 'recipe', status: 'ok', totalTokens: 2220 });
  });

  it('passes a failed read back with its status', async () => {
    provider.extract = vi.fn(async () => {
      throw Object.assign(new Error('took too long'), { code: 'timeout' });
    });
    const res = await call(fromUrl(withoutJsonLd));
    expect(res.statusCode).toBe(504);
    expect(res.body.error.code).toBe('timeout');
  });

  it('says so when the page turns out not to be a recipe', async () => {
    provider.extract = vi.fn(async () => ({
      data: { name: null, ingredients: [] },
      raw: '{}',
      model: 'gemini-3.1-flash-lite',
      latencyMs: 300,
      usage: {},
    }));
    const res = await call(fromUrl(withoutJsonLd));
    expect(res.statusCode).toBe(422);
    expect(res.body.error.code).toBe('no_recipe_found');
  });
});
