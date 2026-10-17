// "Make me an order": a week's Picnic order put together by the model.
//
// It starts from what the household buys — the usuals that are due — and adds
// a few dinners, new recipes from the household's favourite sites picked to
// suit what they already buy and cook. Each recipe's ingredients are then
// matched to Picnic products: the model names a Dutch search for each, Picnic
// is searched, and the model picks from what came back, or leaves it out as
// something already in the cupboard.
//
// Nothing is bought here. The result goes into the new-order draft, where it's
// reviewed like anything else.

import crypto from 'node:crypto';
import { fetchPage, recipeFromJsonLd } from './recipeImport.mjs';
import { pastOrders, usuals } from './picnicHistory.mjs';
import { mapLimited, productFrom, setChoice } from './picnicShopping.mjs';
import { addItem, keyFor } from './mealPlan.mjs';
import { saveRecipe } from './recipeStore.mjs';

export const TASK = 'order';
const PROMPT_VERSION = 'order-3';

export class OrderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const IDEAS_SCHEMA = {
  type: 'object',
  properties: {
    searches: {
      type: 'array',
      description: 'Short English recipe searches, two or three words each, e.g. "chicken tacos".',
      items: { type: 'string' },
      maxItems: 5,
    },
  },
  required: ['searches'],
};

const PICK_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The number of the recipe in the list.' },
          reason: { type: 'string', description: 'Why this household would like it, in under 15 words.' },
          fitsRequest: { type: 'boolean', description: 'Whether it is what they asked for. True when they asked for nothing.' },
        },
        required: ['index', 'reason', 'fitsRequest'],
      },
    },
  },
  required: ['picks'],
};

const TERMS_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          search: { type: 'string', description: 'What to search for at a Dutch supermarket, in Dutch, 1–3 words.' },
          pantry: { type: 'boolean', description: 'True for salt, pepper, water, oil, dried spices and the like.' },
        },
        required: ['index', 'search', 'pantry'],
      },
    },
  },
  required: ['lines'],
};

const CHOOSE_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          option: { type: 'integer', nullable: true, description: 'The chosen product number, or null for none.' },
          packs: { type: 'integer', description: 'How many of it cover the amount.' },
        },
        required: ['index', 'option', 'packs'],
      },
    },
  },
  required: ['lines'],
};

/** Posts that aren't one recipe: meal plans, round-ups, guides. */
/** For a household member's A/B month: the kind of dinner that grades well. */
const AB_HINT =
  'They are aiming for food graded Nutri-Score A or B this month: prefer vegetable-rich, wholegrain, lean dinners, and avoid fried, creamy, very cheesy or sugary ones.';

const NOT_A_RECIPE = /\b(meal plan|recipes for|\d+\s+(easy|best|healthy|quick)\b|ideas|guide|round-?up|gift|review)\b/i;

export function createLazyOrder({ db, model, sites, search, fetch = fetchPage, dailyLimit = 20, now = () => Date.now() }) {
  const builtToday = db.prepare(
    `SELECT COUNT(DISTINCT imageHash) AS n FROM vision_requests
     WHERE task = ? AND promptVersion = ? AND createdAt >= datetime('now', 'start of day')`,
  );
  const logCall = db.prepare(
    `INSERT INTO vision_requests
       (id, createdAt, task, promptVersion, model, imageHash, imageBytes, status, errorCode,
        latencyMs, inputTokens, outputTokens, totalTokens, userId)
     VALUES (@id, @createdAt, @task, @promptVersion, @model, @imageHash, 0, @status, @errorCode,
        @latencyMs, @inputTokens, @outputTokens, @totalTokens, @userId)`,
  );

  /** One structured call, logged against this build whatever happens. */
  async function ask(build, prompt, schema, text) {
    const row = {
      id: crypto.randomUUID(),
      createdAt: new Date(now()).toISOString().replace('T', ' ').slice(0, 19),
      task: TASK,
      promptVersion: PROMPT_VERSION,
      model: model.model,
      // Calls of one build share this, so a build is counted once.
      imageHash: build.id,
      userId: build.userId,
    };
    const started = Date.now();
    try {
      const result = await model.extract({ prompt, schema, text });
      logCall.run({
        ...row,
        model: result.model ?? model.model,
        status: 'ok',
        errorCode: null,
        latencyMs: result.latencyMs ?? Date.now() - started,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        totalTokens: result.usage?.totalTokens ?? null,
      });
      return result.data;
    } catch (error) {
      logCall.run({
        ...row,
        status: 'error',
        errorCode: error.code ?? 'unknown',
        latencyMs: Date.now() - started,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      });
      throw error;
    }
  }

  /** What the household buys and cooks, in a few lines for the model. */
  function tastes() {
    const list = usuals(db, { now: now() });
    const bought = list.slice(0, 40).map((u) => u.name);
    const cooked = db.prepare('SELECT name FROM recipes ORDER BY createdAt DESC LIMIT 30').all().map((r) => r.name);
    const orders = pastOrders(db, { now: now() }).length;
    return { list, bought, cooked, orders };
  }

  /** New recipes to choose from: the sites' latest, and searches the model suggests. */
  async function candidates(build, taste, wish, abTarget) {
    const followed = sites.list();
    if (followed.length === 0) return [];
    const { searches } = await ask(
      build,
      [
        'You suggest recipe searches for a household, based on what they buy and cook.',
        'Return up to 5 short English searches for dinners they would enjoy, with some variety.',
        wish
          ? `They asked for: ${wish}. Every search must be for that; vary within it (for fish: salmon, cod, tuna…).`
          : '',
        abTarget ? AB_HINT : '',
      ]
        .filter(Boolean)
        .join('\n'),
      IDEAS_SCHEMA,
      `They often buy: ${taste.bought.join(', ') || 'unknown'}\nRecipes they have saved: ${taste.cooked.join(', ') || 'none'}`,
    );
    // With a request, only what searching for it finds; the sites' latest
    // posts would mostly be something else.
    const queries = [...(wish ? [wish] : ['']), ...searches.slice(0, 5)];
    const found = await Promise.all(queries.map((q) => sites.posts(q)));
    const seen = new Set();
    return found
      .flat()
      .filter((p) => !p.imported && !NOT_A_RECIPE.test(p.title) && !seen.has(p.url) && seen.add(p.url))
      .slice(0, 60);
  }

  /** A page's recipe, or null when it doesn't publish one. */
  async function readRecipe(post) {
    try {
      const recipe = recipeFromJsonLd(await fetch(post.url));
      return recipe && recipe.ingredients.length > 0 ? recipe : null;
    } catch {
      return null;
    }
  }

  /** Each ingredient line matched to a Picnic product, or left out. */
  async function shop(build, recipes) {
    const lines = recipes.flatMap((r) =>
      r.ingredients.map((raw) => ({ recipe: r.title, raw, factor: r.factor })),
    );
    if (lines.length === 0) return [];
    const numbered = lines.map((l, i) => `${i}. ${l.raw}${l.factor !== 1 ? ` (×${l.factor} for the servings needed)` : ''}`);
    const { lines: terms } = await ask(
      build,
      'For each ingredient line, give a Dutch supermarket search for it, and say whether it is a pantry staple most kitchens already have.',
      TERMS_SCHEMA,
      numbered.join('\n'),
    );
    const termOf = new Map(terms.map((t) => [t.index, t]));
    const wanted = lines
      .map((line, index) => ({ ...line, index, term: termOf.get(index) }))
      .filter((l) => l.term && !l.term.pantry && l.term.search?.trim());
    const options = await mapLimited(wanted, 4, async (l) =>
      ((await search(l.term.search).catch(() => [])) ?? []).slice(0, 6).map(productFrom),
    );
    const offered = wanted.map((l, i) => ({ ...l, options: options[i] }));
    const described = offered
      .filter((l) => l.options.length > 0)
      .map(
        (l) =>
          `${l.index}. ${l.raw}${l.factor !== 1 ? ` (×${l.factor})` : ''}\n` +
          l.options.map((o, j) => `   ${j}: ${o.name} — ${o.unitQuantity ?? ''}`).join('\n'),
      );
    if (described.length === 0) return [];
    const { lines: chosen } = await ask(
      build,
      [
        'Choose the Picnic product that is the ingredient for each line, and how many packs cover the amount.',
        'It must be the same kind of product: raw meat, not sliced meat for sandwiches; fresh, not tinned or jarred, unless the line says so.',
        'Pick null when none of the options is that ingredient. Prefer the plain, unflavoured product.',
        'Work out packs from the amount and the pack size: 1.3 pounds is about 590 g, so two 300 g packs.',
      ].join('\n'),
      CHOOSE_SCHEMA,
      described.join('\n'),
    );
    const byIndex = new Map(offered.map((l) => [l.index, l]));
    return chosen
      .map((c) => {
        const line = byIndex.get(c.index);
        const product = line && c.option != null ? line.options[c.option] : null;
        return product ? { ...product, quantity: Math.min(10, Math.max(1, c.packs || 1)), recipe: line.recipe, raw: line.raw } : null;
      })
      .filter(Boolean);
  }

  return {
    TASK,

    /**
     * A draft order: the due usuals, and `dinners` new recipes for `servings`
     * each, with their ingredients as Picnic products.
     */
    async build({ dinners = 3, servings = 2, wish = '', userId, abTarget = null }) {
      if (!model.configured) throw new OrderError('AI is not switched on for this server.', 503);
      if (builtToday.get(TASK, PROMPT_VERSION).n >= dailyLimit) {
        throw new OrderError("That's today's limit for AI orders. Try again tomorrow.", 429);
      }
      const build = { id: crypto.randomUUID(), userId };
      wish = String(wish ?? '').trim().slice(0, 200);
      const count = Math.min(7, Math.max(0, Number(dinners) || 0));
      const people = Math.min(12, Math.max(1, Number(servings) || 2));
      const taste = tastes();
      const due = taste.list.filter((u) => u.due);

      let recipes = [];
      if (count > 0) {
        const pool = await candidates(build, taste, wish, abTarget);
        if (pool.length > 0) {
          const { picks } = await ask(
            build,
            [
              `Pick ${count + 2} dinners this household would enjoy, best first, from the numbered list of recipes.`,
              wish
                ? `They asked for: ${wish}. Every dinner must be that; pick nothing that isn't, even if fewer. Vary within it.`
                : 'Vary the main ingredient.',
              'Use what they buy and the recipes they have saved to judge their tastes.',
              'Prefer healthy, everyday dinners. Skip anything that is not a single recipe.',
              abTarget ? AB_HINT : '',
            ]
              .filter(Boolean)
              .join('\n'),
            PICK_SCHEMA,
            [
              `They often buy: ${taste.bought.join(', ')}`,
              `Recipes they have saved: ${taste.cooked.join(', ') || 'none'}`,
              'Recipes:',
              ...pool.map((p, i) => `${i}. ${p.title} (${p.site})`),
            ].join('\n'),
          );
          // A couple spare, since some pages don't publish their recipe.
          const chosen = picks
            .filter((p) => pool[p.index] && (!wish || p.fitsRequest !== false))
            .map((p) => ({ ...pool[p.index], reason: p.reason }));
          for (const post of chosen) {
            if (recipes.length === count) break;
            const read = await readRecipe(post);
            if (!read) continue;
            const makes = read.servings > 0 ? read.servings : 4;
            recipes.push({
              title: read.name || post.title,
              url: post.url,
              site: post.site,
              image: post.image,
              reason: post.reason,
              servings: people,
              factor: Math.round((people / makes) * 100) / 100,
              ingredients: read.ingredients,
              nutrition: read.sourceNutrition,
            });
          }
        }
      }

      const bought = await shop(build, recipes);
      // Due usuals first; a recipe's product already in them adds to the count.
      const items = new Map();
      for (const u of due) {
        items.set(u.productId, {
          productId: u.productId,
          name: u.name,
          unitQuantity: u.unitQuantity,
          imageId: u.imageId,
          quantity: u.quantity,
          for: ['Usual'],
        });
      }
      for (const p of bought) {
        const item = items.get(p.productId) ?? {
          productId: p.productId,
          name: p.name,
          unitQuantity: p.unitQuantity,
          imageId: p.imageId,
          quantity: 0,
          for: [],
        };
        if (!item.for.includes('Usual')) item.quantity += p.quantity;
        if (!item.for.includes(p.recipe)) item.for.push(p.recipe);
        items.set(p.productId, item);
      }
      return {
        recipes: recipes.map(({ ingredients, factor, ...r }) => ({
          ...r,
          ingredients: ingredients.length,
          matched: bought
            .filter((b) => b.recipe === r.title)
            .map((b) => ({
              raw: b.raw,
              productId: b.productId,
              name: b.name,
              imageId: b.imageId,
              unitQuantity: b.unitQuantity,
              price: b.price,
            })),
        })),
        items: [...items.values()],
        usingSites: sites.list().length > 0,
      };
    },

    /**
     * Keeps the recipes of an accepted order: saved to Recipes (using the
     * page's own nutrition), each ingredient line remembered as the product
     * picked for it, so the plan's shopping list agrees, and — if asked — put
     * on the first free dinners from tomorrow, for everyone.
     */
    async keep(recipes, { plan = true, userId, saveFood }) {
      const members = db.prepare('SELECT id FROM users ORDER BY createdAt').all();
      const taken = new Set(
        db.prepare("SELECT date FROM meal_plan_items WHERE meal = 'dinner' AND date >= ?").all(day(now(), 1)).map((r) => r.date),
      );
      const kept = [];
      for (const input of (Array.isArray(recipes) ? recipes : []).slice(0, 7)) {
        const url = String(input?.url ?? '');
        let recipe = db.prepare('SELECT id, name FROM recipes WHERE sourceUrl = ?').get(url);
        if (!recipe) {
          const read = await readRecipe({ url });
          if (!read) continue;
          const { id } = saveRecipe(
            db,
            {
              name: read.name,
              servings: read.servings ?? 4,
              servingsStated: read.servingsStated,
              ingredients: read.ingredients,
              instructions: read.instructions,
              sourceType: 'url',
              sourceUrl: url,
              sourceNutrition: read.sourceNutrition,
              nutritionFrom: read.sourceNutrition ? 'page' : 'ingredients',
            },
            { saveFood, ownerId: userId },
          );
          recipe = { id, name: read.name };
        }
        // The product picked for each line, remembered under the line's key.
        const matched = new Map((input.matched ?? []).map((m) => [m.raw, m]));
        for (const ing of db.prepare('SELECT * FROM recipe_ingredients WHERE recipeId = ?').all(recipe.id)) {
          const product = matched.get(ing.raw);
          if (product?.productId && product.name) {
            setChoice(db, keyFor(ing.foodId, ing.name ?? ing.raw), product, { userId });
          }
        }
        let date = null;
        if (plan && members.length > 0) {
          for (let ahead = 1; ahead <= 14 && !date; ahead++) if (!taken.has(day(now(), ahead))) date = day(now(), ahead);
          if (date) {
            taken.add(date);
            const each = Math.max(0.5, Math.round(((Number(input.servings) || members.length) / members.length) * 2) / 2);
            addItem(
              db,
              { date, meal: 'dinner', recipeId: recipe.id, portions: members.map((m) => ({ userId: m.id, servings: each })) },
              { userId },
            );
          }
        }
        kept.push({ recipeId: recipe.id, name: recipe.name, date });
      }
      return kept;
    },
  };
}

/** The date `ahead` days from `at`, as YYYY-MM-DD in local time. */
function day(at, ahead) {
  const d = new Date(at);
  d.setDate(d.getDate() + ahead);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
