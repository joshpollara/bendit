// The recipe endpoints.
//
// Reading one is three routes because there are three ways in: a web address,
// a photograph of a page, and typing it out. All three end at the same draft —
// a name, a list of written lines, and a number of servings — which the client
// shows for correction before anything is saved.
//
// Recipes are visible to everyone on this server. Editing and deleting stay
// with whoever added it.

import { buildRecipe } from './recipe.mjs';
import { fetchPage, pageText, recipeFromJsonLd } from './recipeImport.mjs';
import { deleteRecipe, listRecipes, readRecipe, saveRecipe } from './recipeStore.mjs';
import { getTask } from './visionTasks.mjs';

/** A read recipe, priced against the food database, ready to correct and save. */
const asDraft = (db, read, ownerId) => ({
  ...read,
  ...buildRecipe(db, { ingredients: read.ingredients, servings: read.servings ?? 1, ownerId }),
  // buildRecipe defaults an unknown yield to one serving; say which it was.
  servingsStated: Boolean(read.servingsStated),
});

/**
 * POST /api/recipes/from-url — schema.org first, the model only for pages that
 * publish none.
 *
 * `fetch` is injectable so the fallback can be tested: reaching the model needs
 * a page that publishes no JSON-LD, and no such page can be fetched from a test
 * — the address guard exists to stop the server connecting to localhost.
 */
export function createRecipeFromUrlHandler({ db, visionHandler, fetch = fetchPage }) {
  return async function fromUrl(req, res) {
    const url = String(req.body?.url ?? '').trim();
    let html;
    try {
      html = await fetch(url);
    } catch (error) {
      return res.status(400).json({ error: { code: 'bad_url', message: error.message } });
    }

    const declared = recipeFromJsonLd(html);
    if (declared) {
      return res.json({
        ...asDraft(db, declared, req.userId),
        sourceType: 'url',
        sourceUrl: url,
        readBy: 'page', // no model was needed, and no call was made
      });
    }

    // Nothing structured: hand the page's text to the model.
    const captured = { statusCode: 200, body: null };
    const proxyRes = {
      status(code) {
        captured.statusCode = code;
        return proxyRes;
      },
      json(payload) {
        captured.body = payload;
        return proxyRes;
      },
    };
    await visionHandler({ ...req, body: { task: 'recipe', text: pageText(html) } }, proxyRes);

    if (captured.statusCode !== 200 || !captured.body?.data) {
      return res.status(captured.statusCode).json(captured.body ?? { error: { code: 'unknown' } });
    }
    const read = captured.body.data;
    if (!read.ingredients?.length) {
      return res.status(422).json({
        error: { code: 'no_recipe_found', message: "That page doesn't look like a recipe." },
      });
    }
    return res.json({
      ...asDraft(db, read, req.userId),
      sourceType: 'url',
      sourceUrl: url,
      readBy: 'model',
      meta: captured.body.meta,
    });
  };
}

/** POST /api/recipes/from-photo — a photographed page. */
export function createRecipeFromPhotoHandler({ db, visionHandler }) {
  return async function fromPhoto(req, res) {
    const captured = { statusCode: 200, body: null };
    const proxyRes = {
      status(code) {
        captured.statusCode = code;
        return proxyRes;
      },
      json(payload) {
        captured.body = payload;
        return proxyRes;
      },
    };
    await visionHandler({ ...req, body: { ...req.body, task: 'recipe' } }, proxyRes);

    if (captured.statusCode !== 200 || !captured.body?.data) {
      return res.status(captured.statusCode).json(captured.body ?? { error: { code: 'unknown' } });
    }
    const read = captured.body.data;
    if (!read.ingredients?.length) {
      return res.status(422).json({
        error: { code: 'no_recipe_found', message: 'No recipe was readable in that photo.' },
      });
    }
    return res.json({
      ...asDraft(db, read, req.userId),
      sourceType: 'photo',
      readBy: 'model',
      meta: captured.body.meta,
    });
  };
}

/** POST /api/recipes/price — recost a draft as the user edits it. Costs nothing. */
export function createRecipePriceHandler({ db }) {
  return function price(req, res) {
    const { ingredients = [], servings = 1 } = req.body ?? {};
    res.json(buildRecipe(db, { ingredients, servings, ownerId: req.userId }));
  };
}

export function createRecipeRoutes({ db, saveFood }) {
  return {
    list: (req, res) => res.json(listRecipes(db)),

    read: (req, res) => {
      const recipe = readRecipe(db, req.params.id);
      if (!recipe) return res.status(404).json({ error: 'not found' });
      res.json(recipe);
    },

    save: (req, res) => {
      const { name, ingredients, servings } = req.body ?? {};
      if (!name?.trim()) return res.status(400).json({ error: 'name required' });
      if (!Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: 'at least one ingredient required' });
      }
      const id = req.params.id;
      if (id) {
        const existing = db.prepare('SELECT createdBy FROM recipes WHERE id = ?').get(id);
        if (!existing) return res.status(404).json({ error: 'not found' });
        // Everyone can read a recipe; only whoever added it can change it.
        if (existing.createdBy !== req.userId) {
          return res.status(403).json({ error: 'that recipe belongs to someone else' });
        }
      }
      const saved = saveRecipe(
        db,
        { ...req.body, name: name.trim() },
        { saveFood, ownerId: req.userId, ...(id ? { id } : {}) },
      );
      res.json(readRecipe(db, saved.id));
    },

    remove: (req, res) => {
      const existing = db.prepare('SELECT createdBy FROM recipes WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'not found' });
      if (existing.createdBy !== req.userId) {
        return res.status(403).json({ error: 'that recipe belongs to someone else' });
      }
      deleteRecipe(db, req.params.id);
      res.json({ ok: true });
    },
  };
}
