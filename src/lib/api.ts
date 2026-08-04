import type {
  ExerciseEntry,
  Food,
  FoodLogEntry,
  Meal,
  Measurement,
  MeasurementSite,
  Profile,
  WeightEntry,
} from '../types';
import type { DayTotals } from './report';

// Thin client for the server API. The server owns the SQLite database; the
// browser holds no data.

export interface JoinedEntry extends FoodLogEntry {
  food?: Food;
}

export interface BrowsedFood extends Food {
  usageCount: number;
}

export type FoodCounts = Record<Food['source'], number>;

export interface ReportData {
  from: string | null;
  to: string | null;
  days: DayTotals[];
  weights: { date: string; weightKg: number }[];
  /** Dates the user marked as finished logging. */
  done?: string[];
}

export interface WeekData {
  from: string;
  to: string;
  days: { date: string; food: number; exercise: number; entries: number }[];
}

export interface DayData {
  entries: JoinedEntry[];
  exercises: ExerciseEntry[];
  latestWeightKg?: number;
  yesterdayMealCounts: Partial<Record<Meal, number>>;
  /** The user has declared logging finished for this day. */
  done: boolean;
}

export interface MealTemplateItem {
  id: string;
  foodId: string | null;
  servings: number;
  caloriesCached: number;
  label?: string;
  food?: Food;
}

export interface MealTemplate {
  id: string;
  name: string;
  createdAt: string;
  items: MealTemplateItem[];
}

export interface RecipeIngredient {
  id?: string;
  raw: string;
  name?: string | null;
  quantity?: number | null;
  unit?: string | null;
  grams: number | null;
  weighedBy?: string | null;
  reason?: string | null;
  foodId?: string | null;
  food?: { id: string; name: string; brand: string | null; source: string; kcal100: number | null } | null;
  calories?: number | null;
  nutrition?: { calories: number; protein: number | null; carbs: number | null; fat: number | null } | null;
}

export interface RecipeInput {
  name: string;
  servings: number;
  servingsStated?: boolean;
  ingredients: string[];
  instructions?: string | null;
  notes?: string | null;
  sourceType?: 'url' | 'photo' | 'manual';
  sourceUrl?: string | null;
}

/** What a read recipe looks like before it is saved. */
export interface RecipeDraft {
  name?: string;
  servings: number;
  servingsStated?: boolean;
  servingsReasoning?: string | null;
  ingredients: RecipeIngredient[];
  instructions?: string | null;
  notes?: string | null;
  sourceType?: 'url' | 'photo' | 'manual';
  sourceUrl?: string | null;
  /** 'page' when the site published its own data and no model was needed. */
  readBy?: 'page' | 'model';
  total: { grams: number | null; calories: number | null };
  perServing: { grams: number | null; calories: number | null; protein: number | null; carbs: number | null; fat: number | null };
  unresolved: string[];
  approximate: string[];
}

export interface Recipe {
  id: string;
  name: string;
  servings: number;
  servingsStated: boolean;
  sourceType: string | null;
  sourceUrl: string | null;
  instructions: string | null;
  notes: string | null;
  author: string | null;
  createdBy: string;
  ingredients: RecipeIngredient[];
  food: Food | null;
  total: { grams: number; calories: number };
  perServing: { calories: number | null; grams: number | null };
}

export interface ProgressPhoto {
  id: string;
  date: string;
  createdAt: string;
}

/** Fires when the server says we're not signed in, so the app can react once. */
export const UNAUTHORIZED_EVENT = 'bendit:unauthorized';

/**
 * Appends that can be replayed safely: the client mints the id and the server
 * ignores a repeat, so a lost reply costs nothing.
 */
async function queueableWrite(path: string, body: { id: string; date?: string }): Promise<unknown> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      throw new Error('Not signed in.');
    }
    if (res.ok) return res.json();
    if (res.status < 500) {
      const problem = await res.json().catch(() => null);
      throw new Error(problem?.error ?? `${res.status} ${res.statusText}`);
    }
    throw new Error('server');
  } catch (err) {
    // No network (or the server is down): park it and let the app carry on.
    const { useQueue } = await import('./offlineQueue');
    useQueue.getState().enqueue({ id: body.id, path, body, date: body.date, queuedAt: Date.now() });
    if (err instanceof Error && err.message === 'Not signed in.') throw err;
    return body;
  }
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Error('Not signed in.');
  }
  if (!res.ok) {
    // Server errors carry a human-readable message; fall back to the status.
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const post = (path: string, body: unknown, method = 'POST') =>
  j<unknown>(path, { method, body: JSON.stringify(body) });

export const api = {
  session: () =>
    j<{ authed: boolean; configured: boolean; username: string | null }>('/api/session'),
  login: async (username: string, password: string) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? 'Could not sign in.');
    return body as { ok: true; username: string };
  },
  logout: () => post('/api/logout', {}),

  getProfile: () => j<Profile | null>('/api/profile'),
  putProfile: (p: Profile) => post('/api/profile', p, 'PUT'),

  getDay: (date: string, yesterday: string) =>
    j<DayData>(`/api/day?date=${date}&yesterday=${yesterday}`),

  searchFoods: (q: string) => j<Food[]>(`/api/foods?q=${encodeURIComponent(q)}`),
  customFoods: () => j<Food[]>('/api/foods?source=custom'),
  foodByBarcode: (code: string) => j<Food | null>(`/api/foods/barcode/${encodeURIComponent(code)}`),
  saveFoods: (foods: Food | Food[]) => post('/api/foods', foods),
  recentFoods: () => j<Food[]>('/api/recents'),
  browseFoods: (q: string, source?: Food['source']) =>
    j<BrowsedFood[]>(
      `/api/foods/browse?q=${encodeURIComponent(q)}${source ? `&source=${source}` : ''}`,
    ),
  foodCounts: () => j<FoodCounts>('/api/foods/counts'),
  deleteFood: (id: string) => j<unknown>(`/api/foods/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  addLogEntry: (e: Omit<FoodLogEntry, 'id'> & { id?: string }) =>
    queueableWrite('/api/food-log', { ...e, id: e.id ?? crypto.randomUUID() }),
  deleteLogEntry: (id: string) => j<unknown>(`/api/food-log/${id}`, { method: 'DELETE' }),

  updateLogEntry: (
    id: string,
    changes: Partial<Pick<FoodLogEntry, 'meal' | 'servings' | 'caloriesCached' | 'label'>>,
  ) => post(`/api/food-log/${id}`, changes, 'PATCH'),

  recipes: () => j<Recipe[]>('/api/recipes'),
  recipe: (id: string) => j<Recipe>(`/api/recipes/${id}`),
  recipeFromUrl: (url: string) => post('/api/recipes/from-url', { url }) as Promise<RecipeDraft>,
  recipeFromPhoto: (image: string) =>
    post('/api/recipes/from-photo', { image, mimeType: 'image/jpeg' }) as Promise<RecipeDraft>,
  priceRecipe: (ingredients: string[], servings: number) =>
    post('/api/recipes/price', { ingredients, servings }) as Promise<RecipeDraft>,
  saveRecipe: (recipe: RecipeInput, id?: string) =>
    (id ? post(`/api/recipes/${id}`, recipe, 'PUT') : post('/api/recipes', recipe)) as Promise<Recipe>,
  deleteRecipe: (id: string) => j<unknown>(`/api/recipes/${id}`, { method: 'DELETE' }),

  mealTemplates: () => j<MealTemplate[]>('/api/meal-templates'),
  createMealTemplate: (name: string, items: Omit<MealTemplateItem, 'id' | 'food'>[]) =>
    post('/api/meal-templates', { name, items }) as Promise<unknown>,
  saveMealAsTemplate: (name: string, date: string, meal: Meal) =>
    post('/api/meal-templates/from-day', { name, date, meal }),
  logMealTemplate: (id: string, date: string, meal: Meal) =>
    post(`/api/meal-templates/${id}/log`, { date, meal }),
  mealTemplateAsFood: (id: string, name: string, servings: number) =>
    post(`/api/meal-templates/${id}/as-food`, { name, servings }) as Promise<Food>,
  deleteMealTemplate: (id: string) => j<unknown>(`/api/meal-templates/${id}`, { method: 'DELETE' }),

  listMeasurements: () => j<Measurement[]>('/api/measurements'),
  putMeasurement: (m: { date: string; site: MeasurementSite; valueCm: number }) =>
    post('/api/measurements', m, 'PUT'),
  deleteMeasurement: (id: string) => j<unknown>(`/api/measurements/${id}`, { method: 'DELETE' }),

  recentQuickAdds: () => j<{ label: string; calories: number }[]>('/api/recent-quick-adds'),

  addExercise: (e: Omit<ExerciseEntry, 'id'> & { id?: string }) =>
    queueableWrite('/api/exercise', { ...e, id: e.id ?? crypto.randomUUID() }),
  updateExercise: (
    id: string,
    changes: Partial<Pick<ExerciseEntry, 'name' | 'minutes' | 'caloriesBurned'>>,
  ) => post(`/api/exercise/${id}`, changes, 'PATCH'),
  deleteExercise: (id: string) => j<unknown>(`/api/exercise/${id}`, { method: 'DELETE' }),

  getReport: (from?: string) =>
    j<ReportData>(`/api/report${from ? `?from=${from}` : ''}`),

  getWeek: (date: string) => j<WeekData>(`/api/week?date=${date}`),

  getWeights: () => j<WeightEntry[]>('/api/weights'),
  putWeight: (w: { date: string; weightKg: number }) => post('/api/weights', w, 'PUT'),
  deleteWeight: (id: string) => j<unknown>(`/api/weights/${id}`, { method: 'DELETE' }),

  setDayDone: (date: string, done: boolean) => post('/api/day-done', { date, done }, 'PUT'),

  pushConfig: () =>
    j<{ enabled: boolean; publicKey: string | null; subscriptions: number }>('/api/push/config'),
  pushSubscribe: (subscription: unknown) => post('/api/push/subscribe', subscription),
  pushUnsubscribe: (endpoint: string) => post('/api/push/unsubscribe', { endpoint }),
  pushTest: () => post('/api/push/test', {}),

  listPhotos: () => j<ProgressPhoto[]>('/api/photos'),
  uploadPhoto: async (date: string, image: Blob) => {
    const res = await fetch(`/api/photos?date=${date}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: image,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json() as Promise<ProgressPhoto>;
  },
  photoUrl: (id: string) => `/api/photos/${encodeURIComponent(id)}/image`,
  setPhotoDate: (id: string, date: string) =>
    post(`/api/photos/${encodeURIComponent(id)}`, { date }, 'PATCH'),
  deletePhoto: (id: string) => j<unknown>(`/api/photos/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  resetAll: () => j<unknown>('/api/all', { method: 'DELETE' }),
};
