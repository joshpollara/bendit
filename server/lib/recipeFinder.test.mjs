import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRecipeFinder } from './recipeFinder.mjs';
import { siteIn } from './recipeSites.mjs';
import { createAssistantTools } from './assistantTools.mjs';
import { createRecipeTables } from './recipeStore.mjs';
import { createUser, createUsersTable } from './users.mjs';

const PAGE = `<script type="application/ld+json">${JSON.stringify({
  '@type': 'Recipe',
  name: 'Instant Pot Lentil Curry',
  recipeYield: '6 servings',
  totalTime: 'PT35M',
  keywords: 'instant pot, vegetarian',
  recipeIngredient: ['1 cup red lentils', '1 onion', '400 ml coconut milk'],
  recipeInstructions: [{ text: 'Sauté the onion in the Instant Pot.' }],
  nutrition: { calories: '320 kcal', proteinContent: '14 g', carbohydrateContent: '40 g', fatContent: '12 g' },
})}</script>`;

const fetch = async (url) => {
  if (url === 'https://cook.test/lentil-curry/') return PAGE;
  return '<html>no recipe here</html>';
};
const MINE = { id: 'mine', name: 'Mine', origin: 'https://mine.test', kind: 'wordpress' };
const SKINNY = { id: 'more:skinny', name: 'Skinnytaste', origin: 'https://www.skinnytaste.com', kind: 'wordpress' };
const searched = [];
const sites = {
  list: () => [MINE],
  posts: async () => [{ title: 'Lentil Curry', url: 'https://mine.test/curry/', site: 'Mine', imported: true }],
  searchMore: async () => [
    { title: 'Instant Pot Lentil Curry', url: 'https://cook.test/lentil-curry/', site: 'Cook', imported: false },
  ],
  named: (name) => siteIn(name, [MINE, SKINNY])?.site ?? null,
  siteIn: (query) => siteIn(query, [MINE, SKINNY]),
  searchSite: async (site, query) => {
    searched.push([site.name, query]);
    return [{ title: `${site.name}: ${query}`, url: `${site.origin}/x/`, site: site.name, imported: false }];
  },
};

let db;
let ann;
let saved;
const saveFood = (food) => {
  saved.push(food);
  db.prepare('INSERT OR REPLACE INTO foods (id, name, source) VALUES (?, ?, ?)').run(food.id, food.name, food.source);
};

beforeEach(() => {
  db = new Database(':memory:');
  saved = [];
  createUsersTable(db);
  createRecipeTables(db);
  db.exec(`
    CREATE TABLE foods (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, source TEXT NOT NULL,
      servingLabel TEXT, servingGrams REAL, caloriesPerServing REAL, protein REAL, carbs REAL, fat REAL,
      kcal100 REAL, protein100 REAL, carbs100 REAL, fat100 REAL, ownerId TEXT);
    CREATE TABLE food_servings (id TEXT PRIMARY KEY, foodId TEXT, label TEXT, grams REAL, isDefault INTEGER);
    CREATE VIRTUAL TABLE foods_fts USING fts5(name, brand, content='foods', content_rowid='rowid');
  `);
  ann = createUser(db, 'ann', 'password-ann').id;
});

describe('finding recipes', () => {
  it("lists the household's sites first, then well-known ones", async () => {
    const finder = createRecipeFinder({ db, sites, fetch, saveFood });
    expect(await finder.find('lentil curry')).toEqual([
      { title: 'Lentil Curry', url: 'https://mine.test/curry/', site: 'Mine', yourSite: true, alreadySaved: true },
      {
        title: 'Instant Pot Lentil Curry',
        url: 'https://cook.test/lentil-curry/',
        site: 'Cook',
        yourSite: false,
        alreadySaved: false,
      },
    ]);
  });

  it('searches only a site named in the search, without its name', async () => {
    const finder = createRecipeFinder({ db, sites, fetch, saveFood });
    searched.length = 0;
    const found = await finder.find('skinnytaste vegetarian dinner');
    expect(searched).toEqual([['Skinnytaste', 'vegetarian dinner']]);
    expect(found).toEqual([expect.objectContaining({ site: 'Skinnytaste', yourSite: false })]);
    await finder.find('soup', { site: 'Skinny Taste' });
    await finder.find('Mine curry');
    expect(searched.slice(1)).toEqual([
      ['Skinnytaste', 'soup'],
      ['Mine', 'curry'],
    ]);
  });

  it("says so when the site asked for can't be searched", async () => {
    const finder = createRecipeFinder({ db, sites, fetch, saveFood });
    await expect(finder.find('soup', { site: 'nowhere.example' })).rejects.toThrow(/isn't a recipe site/);
  });

  it('reads what a page says about its recipe', async () => {
    const finder = createRecipeFinder({ db, sites, fetch, saveFood });
    expect(await finder.read('https://cook.test/lentil-curry/')).toMatchObject({
      name: 'Instant Pot Lentil Curry',
      serves: 6,
      minutes: 35,
      tags: ['instant pot', 'vegetarian'],
      perServing: { calories: 320, protein: 14 },
      alreadySaved: false,
    });
    await expect(finder.read('https://cook.test/story/')).rejects.toThrow(/doesn't publish a recipe/);
  });

  it('saves a recipe once, with the page nutrition', async () => {
    const finder = createRecipeFinder({ db, sites, fetch, saveFood });
    const first = await finder.save('https://cook.test/lentil-curry/', { userId: ann });
    expect(first).toMatchObject({ name: 'Instant Pot Lentil Curry', existed: false });
    expect(saved.at(-1).caloriesPerServing).toBe(320);
    expect(await finder.save('https://cook.test/lentil-curry/', { userId: ann })).toEqual({ ...first, existed: true });
  });
});

describe("the assistant's recipe tools", () => {
  const picnic = { status: () => ({ connected: false }) };

  it('searches and reads straight away, and proposes saving in plain words', async () => {
    const finder = createRecipeFinder({ db, sites, fetch, saveFood });
    const { tools, declarations } = createAssistantTools({ db, picnic, userId: ann, finder });
    expect(declarations.map((d) => d.name)).toEqual(
      expect.arrayContaining(['find_recipes', 'read_recipe', 'save_recipe']),
    );
    expect(tools.find_recipes.write).toBeUndefined();
    expect(await tools.save_recipe.describe({ url: 'https://cook.test/lentil-curry/' })).toBe(
      'Save "Instant Pot Lentil Curry" (serves 6) from cook.test to Recipes',
    );
    await expect(tools.save_recipe.describe({ url: 'https://cook.test/story/' })).rejects.toThrow(/can be saved/);
    expect(await tools.save_recipe.run({ url: 'https://cook.test/lentil-curry/' })).toMatchObject({
      name: 'Instant Pot Lentil Curry',
      alreadySaved: false,
    });
  });
});
