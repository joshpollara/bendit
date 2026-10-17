// Finding new recipes on the web, reading one, and saving it to Recipes —
// for the assistant and for AI orders.
//
// Searching covers the household's own sites first, then well-known recipe
// sites (see MORE_SITES in recipeSites.mjs). Reading and saving use what the
// page publishes about its recipe; nothing is guessed, and a page that
// publishes no recipe can't be saved this way.

import { fetchPage, recipeFromJsonLd } from './recipeImport.mjs';
import { saveRecipe } from './recipeStore.mjs';

/** A refusal the person (or the assistant) should hear, not a bug. */
export class FinderError extends Error {
  status = 400;
}

export function createRecipeFinder({ db, sites, fetch = fetchPage, saveFood }) {
  /** A page's recipe, or null. */
  async function load(url) {
    try {
      const recipe = recipeFromJsonLd(await fetch(String(url)));
      return recipe && recipe.ingredients.length > 0 ? recipe : null;
    } catch {
      return null;
    }
  }

  const existing = (url) =>
    db.prepare('SELECT id, name FROM recipes WHERE sourceUrl = ? OR sourceUrl = ?').get(url, url.replace(/\/$/, ''));

  return {
    load,

    /** Matches from the household's sites, then from well-known ones. */
    async find(query, { limit = 12 } = {}) {
      const q = String(query ?? '').trim();
      if (!q) throw new FinderError('Say what to search for.');
      const [own, more] = await Promise.all([sites.posts(q), sites.searchMore(q)]);
      const shape = (yourSite) => (p) => ({ title: p.title, url: p.url, site: p.site, yourSite, alreadySaved: p.imported });
      return [...own.slice(0, Math.ceil(limit / 2)).map(shape(true)), ...more.map(shape(false))].slice(0, limit);
    },

    /** What a recipe page says: enough to judge it by. */
    async read(url) {
      const recipe = await load(url);
      if (!recipe) throw new FinderError("That page doesn't publish a recipe that can be read.");
      return {
        name: recipe.name,
        serves: recipe.servings,
        minutes: recipe.minutes,
        tags: recipe.tags,
        ingredients: recipe.ingredients,
        method: recipe.instructions ? recipe.instructions.slice(0, 600) : null,
        perServing: recipe.sourceNutrition
          ? {
              calories: recipe.sourceNutrition.calories,
              protein: recipe.sourceNutrition.protein,
              carbs: recipe.sourceNutrition.carbs,
              fat: recipe.sourceNutrition.fat,
            }
          : null,
        alreadySaved: Boolean(existing(String(url))),
      };
    },

    /**
     * Saves a page's recipe to Recipes, using the page's own nutrition, or
     * returns the one already saved from it.
     */
    async save(url, { userId, recipe = null }) {
      const found = existing(String(url));
      if (found) return { recipeId: found.id, name: found.name, existed: true };
      const read = recipe ?? (await load(url));
      if (!read) throw new FinderError("That page doesn't publish a recipe that can be saved.");
      const { id } = saveRecipe(
        db,
        {
          name: read.name,
          servings: read.servings ?? 4,
          servingsStated: read.servingsStated,
          ingredients: read.ingredients,
          instructions: read.instructions,
          sourceType: 'url',
          sourceUrl: String(url),
          sourceNutrition: read.sourceNutrition,
          nutritionFrom: read.sourceNutrition ? 'page' : 'ingredients',
        },
        { saveFood, ownerId: userId },
      );
      return { recipeId: id, name: read.name, existed: false };
    },
  };
}
