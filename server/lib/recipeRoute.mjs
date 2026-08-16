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
import { parseIngredients } from './recipeParse.mjs';
import { deleteRecipe, listRecipes, readRecipe, saveRecipe } from './recipeStore.mjs';
import { getTask } from './visionTasks.mjs';

/** A read recipe, priced against the food database, ready to correct and save. */
const asDraft = (db, read, ownerId) => {
  const parsed = parseIngredients(read.ingredients);
  // The model returns a food-search phrase for each line. The original line
  // stays intact for the editor; only the lookup name is made less brittle
  // ("a bunch of spring onions" → "spring onion", for example).
  const matchNames =
    Array.isArray(read.ingredientMatchNames) && read.ingredientMatchNames.length === parsed.length
      ? read.ingredientMatchNames
      : [];
  const ingredients = parsed.map((ingredient, index) => ({
    ...ingredient,
    name: String(matchNames[index] ?? '').trim() || ingredient.name,
  }));
  return {
    ...read,
    ...buildRecipe(db, { ingredients, servings: read.servings ?? 1, ownerId }),
    // buildRecipe defaults an unknown yield to one serving; say which it was.
    servingsStated: Boolean(read.servingsStated),
  };
};

/**
 * POST /api/recipes/from-url — give AI both the recipe data a page publishes
 * and its readable text, so it can recover omitted ingredients and produce
 * reliable food-search names. Published data remains a safe fallback.
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
    // Give the model the JSON-LD too. It is often more complete than visible
    // page text, while the latter catches sites that hide recipe lines in bad
    // or incomplete structured data.
    const structuredText = [
      `Source URL: ${url}`,
      declared
        ? [
            'Recipe data published by the page:',
            `Name: ${declared.name}`,
            `Servings: ${declared.servings ?? 'not stated'}`,
            'Ingredients:',
            ...declared.ingredients,
            declared.instructions ? `Method:\n${declared.instructions}` : '',
          ].filter(Boolean).join('\n')
        : '',
      'Visible page text:',
    ].filter(Boolean).join('\n\n');
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
    await visionHandler({ ...req, body: { task: 'recipe', text: `${structuredText}\n${pageText(html)}`.trim() } }, proxyRes);

    if (captured.statusCode !== 200 || !captured.body?.data) {
      // A URL import should still work on a server without AI configured when
      // the recipe author supplied complete data of their own.
      if (declared) {
        return res.json({
          ...asDraft(db, declared, req.userId),
          sourceType: 'url',
          sourceUrl: url,
          readBy: 'page',
        });
      }
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
      sourceNutrition: declared?.sourceNutrition ?? null,
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
    await visionHandler({ ...req, body: { ...req.body, task: 'recipePhoto' } }, proxyRes);

    if (captured.statusCode !== 200 || !captured.body?.data) {
      return res.status(captured.statusCode).json(captured.body ?? { error: { code: 'unknown' } });
    }
    const read = captured.body.data;
    if (!read.ingredients?.length) {
      return res.status(422).json({
        error: { code: 'no_recipe_found', message: 'No recipe was readable in that photo.' },
      });
    }
    const sourceWarnings = Array.isArray(read.sourceWarnings)
      ? read.sourceWarnings.map((warning) => String(warning).trim()).filter(Boolean)
      : [];
    const sourceComplete = read.sourceComplete === true;
    return res.json({
      ...asDraft(db, read, req.userId),
      // Keep a readable fragment editable, but never let it masquerade as a
      // verified whole recipe. This is especially important for cookbook
      // recipes that continue on a second page the one-photo UI cannot accept.
      sourceComplete,
      sourceWarnings:
        sourceComplete || sourceWarnings.length
          ? sourceWarnings
          : ['AI could not verify that the entire recipe is visible.'],
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
