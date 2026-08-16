import type {
  ExerciseEntry,
  Fast,
  Food,
  FoodLogEntry,
  Meal,
  Measurement,
  MeasurementSite,
  Profile,
  WeightEntry,
} from '../types';
import type { DayTotals } from './report';
import type { MealFeedback } from './mealPhoto';

// Thin client for the server API. The server owns the SQLite database; the
// browser holds no data.

export interface JoinedEntry extends FoodLogEntry {
  food?: Food;
}

/** A quick add you've typed before, offered back with whatever it recorded. */
export interface QuickAddSuggestion {
  label: string;
  calories: number;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
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
  /** Nutri-Score and processing per meal, where enough was known to work it out. */
  meals?: Partial<
    Record<
      Meal,
      {
        grade?: string | null;
        covered?: number;
        processing?: { worst: number; ultraShare: number } | null;
      }
    >
  >;
}

export interface MealTemplateItem {
  id: string;
  foodId: string | null;
  servings: number;
  caloriesCached: number;
  label?: string;
  /** Grams for the whole item, as on a quick add with no food behind it. */
  proteinCached?: number | null;
  carbsCached?: number | null;
  fatCached?: number | null;
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

/** Counts over some set of model calls — a window, a task, or a model. */
export interface UsageTally {
  calls: number;
  ok: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated, from the token counts and this server's rate table. */
  costUsd: number;
  /** Calls on a model this server has no rate for, so excluded from the cost. */
  unpricedCalls: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface UsageWindow extends UsageTally {
  label: string;
  /** First day counted, or null for all time. */
  from: string | null;
}

export interface VisionCall {
  id: string;
  createdAt: string;
  task: string;
  model: string;
  status: string;
  errorCode: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface VisionUsage {
  provider: string;
  model: string;
  configured: boolean;
  dailyLimit: number;
  usedToday: number;
  remainingToday: number;
  /** US dollars per million tokens, by model. */
  prices: Record<string, { input: number; output: number }>;
  windows: Record<'today' | 'week' | 'month' | 'all', UsageWindow>;
  /** How many days the task and error breakdowns cover. */
  breakdownDays: number;
  byTask: (UsageTally & { task: string })[];
  byError: { code: string; calls: number }[];
  byModel: (UsageTally & { model: string; priced: boolean })[];
  recent: VisionCall[];
}

/** The one that's running, if any, and the ones that have finished. */
export interface FastsData {
  current: Fast | null;
  recent: Fast[];
}

export interface ProgressPhoto {
  id: string;
  date: string;
  createdAt: string;
}

/** Fires when the server says we're not signed in, so the app can react once. */
export const UNAUTHORIZED_EVENT = 'bendit:unauthorized';

/**
 * Writes that can be replayed safely: the client supplies an idempotency key
 * and the server treats a repeat as the same operation, so a lost reply costs
 * nothing.
 */
async function queueableWrite(
  path: string,
  body: unknown,
  {
    id,
    date,
    method = 'POST',
  }: { id: string; date?: string; method?: 'POST' | 'PUT' },
): Promise<unknown> {
  const park = async () => {
    const { useQueue } = await import('./offlineQueue');
    useQueue.getState().enqueue({
      id,
      path,
      ...(method === 'POST' ? {} : { method }),
      body,
      date,
      queuedAt: Date.now(),
    });
  };

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Nothing reached the server: park it and let the app carry on.
    await park();
    return body;
  }

  // Everything below here is the server answering, which is a different thing
  // from not reaching it. Catching both together is what made a refused write
  // look like a saved one: it was queued, the caller was told it succeeded, and
  // the next flush dropped it on the floor for being a refusal — so it appeared
  // in the log, survived until the next sync, and then quietly wasn't there.
  if (res.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    // Worth keeping: signing back in replays it, which is why the queue holds
    // on to a 401 rather than discarding it.
    await park();
    throw new Error('Not signed in.');
  }

  if (res.ok) {
    // A success with an unreadable body is still a success. The row is on the
    // server; re-sending it would be the only way to get it wrong.
    return res.json().catch(() => body);
  }

  if (res.status >= 500) {
    await park();
    return body;
  }

  const problem = await res.json().catch(() => null);
  throw new Error(problem?.error ?? `${res.status} ${res.statusText}`);
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
  changePassword: (currentPassword: string, newPassword: string) =>
    post('/api/password', { currentPassword, newPassword }),

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
    (() => {
      const body = { ...e, id: e.id ?? crypto.randomUUID() };
      return queueableWrite('/api/food-log', body, { id: body.id, date: body.date });
    })(),
  deleteLogEntry: (id: string) => j<unknown>(`/api/food-log/${id}`, { method: 'DELETE' }),

  updateLogEntry: (
    id: string,
    changes: Partial<
      Pick<
        FoodLogEntry,
        | 'meal'
        | 'servings'
        | 'caloriesCached'
        | 'label'
        | 'proteinCached'
        | 'carbsCached'
        | 'fatCached'
      >
    >,
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

  recentQuickAdds: () =>
    j<QuickAddSuggestion[]>('/api/recent-quick-adds'),

  addExercise: (e: Omit<ExerciseEntry, 'id'> & { id?: string }) =>
    (() => {
      const body = { ...e, id: e.id ?? crypto.randomUUID() };
      return queueableWrite('/api/exercise', body, { id: body.id, date: body.date });
    })(),
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

  fasts: () => j<FastsData>('/api/fasts'),
  startFast: (fast: { startedAt?: string; endedAt?: string | null; goalHours?: number | null }) =>
    post('/api/fasts', fast) as Promise<Fast>,
  updateFast: (id: string, changes: Partial<Pick<Fast, 'startedAt' | 'endedAt' | 'goalHours'>>) =>
    post(`/api/fasts/${id}`, changes, 'PATCH') as Promise<Fast>,
  deleteFast: (id: string) => j<unknown>(`/api/fasts/${id}`, { method: 'DELETE' }),

  pushConfig: () =>
    j<{ enabled: boolean; publicKey: string | null; subscriptions: number }>('/api/push/config'),
  pushSubscribe: (subscription: unknown) => post('/api/push/subscribe', subscription),
  pushUnsubscribe: (endpoint: string) => post('/api/push/unsubscribe', { endpoint }),
  pushTest: () => post('/api/push/test', {}),

  visionUsage: () => j<VisionUsage>('/api/vision/usage'),
  putMealEstimateFeedback: (estimateId: string, feedback: MealFeedback) =>
    queueableWrite(
      `/api/meals/estimate/${encodeURIComponent(estimateId)}/feedback`,
      feedback,
      { id: `meal-feedback:${estimateId}`, method: 'PUT' },
    ),

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
