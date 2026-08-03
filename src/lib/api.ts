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

export interface ProgressPhoto {
  id: string;
  date: string;
  createdAt: string;
}

/** Fires when the server says we're not signed in, so the app can react once. */
export const UNAUTHORIZED_EVENT = 'bendit:unauthorized';

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
  session: () => j<{ authed: boolean; configured: boolean }>('/api/session'),
  login: async (password: string) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? 'Could not sign in.');
    return body as { ok: true };
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

  addLogEntry: (e: Omit<FoodLogEntry, 'id'>) => post('/api/food-log', e),
  deleteLogEntry: (id: string) => j<unknown>(`/api/food-log/${id}`, { method: 'DELETE' }),

  updateLogEntry: (
    id: string,
    changes: Partial<Pick<FoodLogEntry, 'meal' | 'servings' | 'caloriesCached' | 'label'>>,
  ) => post(`/api/food-log/${id}`, changes, 'PATCH'),

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

  addExercise: (e: Omit<ExerciseEntry, 'id'>) => post('/api/exercise', e),
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
  deletePhoto: (id: string) => j<unknown>(`/api/photos/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  resetAll: () => j<unknown>('/api/all', { method: 'DELETE' }),
};
