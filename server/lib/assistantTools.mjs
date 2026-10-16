// What the assistant can look at and do, as functions the model may call.
//
// Reads run as soon as the model asks. Writes never do: each becomes a
// proposal the person approves or skips, described in plain words from the
// database rather than in the model's own — so what is approved is what
// happens. There is deliberately no checkout here; paying stays a thing a
// person does on the Picnic page.

import crypto from 'node:crypto';
import { searchFoodsTiered } from './foodSearch.mjs';
import { addItem, listPlan, MEALS, plannedFor, removeItem, shoppingList } from './mealPlan.mjs';
import { cartAdditions, withProducts } from './picnicShopping.mjs';
import { listRecipes } from './recipeStore.mjs';
import { listUsers } from './users.mjs';

const date = { type: 'string', description: 'A date as YYYY-MM-DD.' };
const meal = { type: 'string', enum: MEALS };
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const euros = (cents) => `€${(cents / 100).toFixed(2)}`;

export class ToolError extends Error {}

/** The tools for one person's conversation. */
export function createAssistantTools({ db, picnic, userId }) {
  const members = () => listUsers(db).map(({ id, username }) => ({ id, username }));
  const memberId = (username) => {
    const found = members().find((m) => m.username === String(username).trim().toLowerCase());
    if (!found) throw new ToolError(`No one called "${username}" lives here.`);
    return found.id;
  };
  const food = (id) => db.prepare('SELECT * FROM foods WHERE id = ?').get(id);
  const needPicnic = () => {
    if (!picnic.status().connected) throw new ToolError('Picnic is not connected.');
  };
  const dayLabel = (d) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  const tools = {
    // ——— reads ———
    get_day: {
      description: "The current user's food log for a day, with totals, and their planned meals not yet logged.",
      parameters: obj({ date }, ['date']),
      run: ({ date: d }) => {
        const entries = db
          .prepare(
            `SELECT l.meal, l.servings, l.caloriesCached AS calories, COALESCE(f.name, l.label) AS name,
                    COALESCE(l.proteinCached, f.protein * l.servings) AS protein
             FROM food_log l LEFT JOIN foods f ON f.id = l.foodId WHERE l.date = ? AND l.userId = ?`,
          )
          .all(d, userId);
        return {
          date: d,
          logged: entries.map((e) => ({ ...e, calories: Math.round(e.calories), protein: round1(e.protein) })),
          totals: {
            calories: Math.round(entries.reduce((s, e) => s + e.calories, 0)),
            protein: round1(entries.reduce((s, e) => s + (e.protein ?? 0), 0)),
          },
          plannedNotLogged: plannedFor(db, userId, d),
        };
      },
    },
    get_plan: {
      description: "The household's meal plan between two dates, with each person's servings and per-serving nutrition.",
      parameters: obj({ from: date, to: date }, ['from', 'to']),
      run: ({ from, to }) =>
        listPlan(db, from, to).map((i) => ({
          itemId: i.id,
          date: i.date,
          meal: i.meal,
          name: i.name,
          perServing: i.perServing,
          servingLabel: i.servingLabel,
          portions: i.portions.map((p) => ({ username: p.username, servings: p.servings, logged: p.logged })),
        })),
    },
    search_foods: {
      description: 'Search the food database. Returns ids to use with plan_meal and log_food.',
      parameters: obj({ query: { type: 'string' } }, ['query']),
      run: ({ query }) =>
        searchFoodsTiered(db, String(query), { limit: 10, ownerId: userId }).map((f) => ({
          foodId: f.id,
          name: f.name,
          brand: f.brand ?? undefined,
          servingLabel: f.servingLabel,
          calories: f.caloriesPerServing,
          protein: f.protein,
          carbs: f.carbs,
          fat: f.fat,
        })),
    },
    list_recipes: {
      description: "The household's recipes, optionally filtered by name, with per-serving nutrition.",
      parameters: obj({ query: { type: 'string' } }),
      run: ({ query }) =>
        listRecipes(db)
          .filter((r) => !query || r.name.toLowerCase().includes(String(query).toLowerCase()))
          .map((r) => ({
            recipeId: r.id,
            name: r.name,
            makes: r.servings,
            perServing: r.food
              ? { calories: r.food.caloriesPerServing, protein: r.food.protein, carbs: r.food.carbs, fat: r.food.fat }
              : null,
          })),
    },
    get_shopping_list: {
      description: 'What the meal plan needs bought between two dates.',
      parameters: obj({ from: date, to: date }, ['from', 'to']),
      run: ({ from, to }) =>
        shoppingList(db, from, to).items.map(({ key, name, grams, written, checked }) => ({
          key,
          name,
          grams,
          written,
          alreadyHave: checked,
        })),
    },
    picnic_search: {
      description: 'Search Picnic, the grocery delivery service. Prices are in euro cents.',
      parameters: obj({ query: { type: 'string' } }, ['query']),
      run: async ({ query }) => {
        needPicnic();
        return (await picnic.search(String(query))).slice(0, 8).map((p) => ({
          productId: p.id,
          name: p.name,
          size: p.unit_quantity,
          priceCents: p.display_price,
        }));
      },
    },
    picnic_get_cart: {
      description: "What is in the household's Picnic cart.",
      parameters: obj({}),
      run: async () => {
        needPicnic();
        const cart = await picnic.cart();
        return {
          totalCents: cart.checkout_total_price,
          items: cart.items.flatMap((line) =>
            line.items.map((a) => ({
              productId: a.id,
              name: a.name,
              size: a.unit_quantity,
              count: a.decorators?.find((d) => d.type === 'QUANTITY')?.quantity ?? 1,
            })),
          ),
        };
      },
    },
    picnic_delivery_slots: {
      description: 'Available Picnic delivery slots, and the one currently selected.',
      parameters: obj({}),
      run: async () => {
        needPicnic();
        const { slots, selectedSlot } = await picnic.slots();
        return {
          selected: selectedSlot,
          available: slots
            .filter((s) => s.isAvailable)
            .slice(0, 30)
            .map((s) => ({ slotId: s.slotId, start: s.windowStart, end: s.windowEnd })),
        };
      },
    },

    // ——— writes: proposed, then approved by the person ———
    plan_meal: {
      write: true,
      description:
        "Add a recipe or food to the household meal plan. Give recipeId or foodId (from list_recipes or search_foods), and each person's servings by username.",
      parameters: obj(
        {
          date,
          meal,
          recipeId: { type: 'string' },
          foodId: { type: 'string' },
          portions: {
            type: 'array',
            items: obj({ username: { type: 'string' }, servings: { type: 'number' } }, ['username', 'servings']),
          },
        },
        ['date', 'meal', 'portions'],
      ),
      describe: ({ date: d, meal: m, recipeId, foodId, portions = [] }) => {
        const name = recipeId
          ? db.prepare('SELECT name FROM recipes WHERE id = ?').get(recipeId)?.name
          : food(foodId)?.name;
        if (!name) throw new ToolError('No such recipe or food.');
        portions.forEach((p) => memberId(p.username));
        return `Plan ${name} for ${m} on ${dayLabel(d)}: ${portions.map((p) => `${p.username} ${p.servings}`).join(', ')}`;
      },
      run: ({ date: d, meal: m, recipeId, foodId, portions = [] }) => {
        const item = addItem(
          db,
          { date: d, meal: m, recipeId, foodId, portions: portions.map((p) => ({ userId: memberId(p.username), servings: p.servings })) },
          { userId },
        );
        return { itemId: item.id };
      },
    },
    remove_planned_meal: {
      write: true,
      description: 'Remove a meal from the household plan, by its itemId from get_plan.',
      parameters: obj({ itemId: { type: 'string' } }, ['itemId']),
      describe: ({ itemId }) => {
        const [item] = listPlan(db, '0000-01-01', '9999-12-31').filter((i) => i.id === itemId);
        if (!item) throw new ToolError('No such planned meal.');
        return `Remove ${item.name} (${item.meal}, ${dayLabel(item.date)}) from the plan`;
      },
      run: ({ itemId }) => {
        removeItem(db, itemId);
        return { removed: true };
      },
    },
    log_food: {
      write: true,
      description: "Log a food to the current user's food log, by foodId from search_foods.",
      parameters: obj({ date, meal, foodId: { type: 'string' }, servings: { type: 'number' } }, [
        'date',
        'meal',
        'foodId',
        'servings',
      ]),
      describe: ({ date: d, meal: m, foodId, servings }) => {
        const f = food(foodId);
        if (!f) throw new ToolError('No such food.');
        if (!(servings > 0)) throw new ToolError('servings must be more than zero.');
        return `Log ${servings} × ${f.servingLabel} ${f.name} to your ${m} on ${dayLabel(d)} (${Math.round(f.caloriesPerServing * servings)} cal)`;
      },
      run: ({ date: d, meal: m, foodId, servings }) => {
        const f = food(foodId);
        const entry = {
          id: crypto.randomUUID(),
          date: d,
          meal: m,
          foodId,
          servings,
          caloriesCached: Math.round(f.caloriesPerServing * servings),
          userId,
        };
        db.prepare(
          `INSERT INTO food_log (id, date, meal, foodId, servings, caloriesCached, estimated, userId)
           VALUES (@id, @date, @meal, @foodId, @servings, @caloriesCached, 0, @userId)`,
        ).run(entry);
        return { logged: true };
      },
    },
    picnic_add_to_cart: {
      write: true,
      description: "Add a Picnic product to the household's cart, by productId from picnic_search.",
      parameters: obj({ productId: { type: 'string' }, name: { type: 'string' }, count: { type: 'integer' } }, [
        'productId',
        'name',
        'count',
      ]),
      describe: ({ name, count }) => `Add ${count} × ${name} to the Picnic cart`,
      run: async ({ productId, count }) => {
        needPicnic();
        const cart = await picnic.addToCart(productId, Math.max(1, Math.min(50, count)));
        return { cartTotalCents: cart.checkout_total_price };
      },
    },
    picnic_remove_from_cart: {
      write: true,
      description: "Remove a Picnic product from the household's cart.",
      parameters: obj({ productId: { type: 'string' }, name: { type: 'string' }, count: { type: 'integer' } }, [
        'productId',
        'name',
        'count',
      ]),
      describe: ({ name, count }) => `Remove ${count} × ${name} from the Picnic cart`,
      run: async ({ productId, count }) => {
        needPicnic();
        const cart = await picnic.removeFromCart(productId, Math.max(1, Math.min(50, count)));
        return { cartTotalCents: cart.checkout_total_price };
      },
    },
    add_shopping_list_to_cart: {
      write: true,
      description:
        'Add everything on the shopping list between two dates that has a chosen Picnic product to the cart. Lines without a chosen product are left out.',
      parameters: obj({ from: date, to: date }, ['from', 'to']),
      describe: async ({ from, to }) => {
        const list = await withProducts(db, shoppingList(db, from, to), async () => null);
        const additions = cartAdditions(list.items);
        if (additions.length === 0) throw new ToolError('Nothing on that list has a Picnic product chosen yet.');
        const total = list.items
          .filter((i) => !i.checked && i.choice)
          .reduce((sum, i) => sum + (i.choice.price ?? 0) * (i.packs ?? 1), 0);
        return `Add the shopping list for ${dayLabel(from)}–${dayLabel(to)} to the Picnic cart: ${additions.length} products, about ${euros(total)}`;
      },
      run: async ({ from, to }) => {
        needPicnic();
        const list = await withProducts(db, shoppingList(db, from, to), async () => null);
        const cart = await picnic.addProducts(cartAdditions(list.items));
        return { cartTotalCents: cart.checkout_total_price };
      },
    },
    picnic_set_delivery_slot: {
      write: true,
      description: 'Choose the Picnic delivery slot, by slotId from picnic_delivery_slots.',
      parameters: obj({ slotId: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } }, [
        'slotId',
        'start',
        'end',
      ]),
      describe: ({ start, end }) =>
        `Book the Picnic delivery for ${new Date(start).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })}–${new Date(end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })}`,
      run: async ({ slotId }) => {
        needPicnic();
        await picnic.setSlot(slotId);
        return { booked: true };
      },
    },
  };

  return {
    tools,
    declarations: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.write ? `${t.description} The person approves this before it happens.` : t.description,
      parameters: t.parameters,
    })),
    members,
  };
}
