import type { ExerciseEntry, Food, FoodLogEntry, Meal, Profile, WeightEntry } from '../types';

// Thin client for the server API. The server owns the SQLite database; the
// browser holds no data.

export interface JoinedEntry extends FoodLogEntry {
  food?: Food;
}

export interface DayData {
  entries: JoinedEntry[];
  exercises: ExerciseEntry[];
  latestWeightKg?: number;
  yesterdayMealCounts: Partial<Record<Meal, number>>;
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

const post = (path: string, body: unknown, method = 'POST') =>
  j<unknown>(path, { method, body: JSON.stringify(body) });

export const api = {
  getProfile: () => j<Profile | null>('/api/profile'),
  putProfile: (p: Profile) => post('/api/profile', p, 'PUT'),

  getDay: (date: string, yesterday: string) =>
    j<DayData>(`/api/day?date=${date}&yesterday=${yesterday}`),

  searchFoods: (q: string) => j<Food[]>(`/api/foods?q=${encodeURIComponent(q)}`),
  customFoods: () => j<Food[]>('/api/foods?source=custom'),
  foodByBarcode: (code: string) => j<Food | null>(`/api/foods/barcode/${encodeURIComponent(code)}`),
  saveFoods: (foods: Food | Food[]) => post('/api/foods', foods),
  recentFoods: () => j<Food[]>('/api/recents'),

  addLogEntry: (e: Omit<FoodLogEntry, 'id'>) => post('/api/food-log', e),
  deleteLogEntry: (id: string) => j<unknown>(`/api/food-log/${id}`, { method: 'DELETE' }),

  addExercise: (e: Omit<ExerciseEntry, 'id'>) => post('/api/exercise', e),
  deleteExercise: (id: string) => j<unknown>(`/api/exercise/${id}`, { method: 'DELETE' }),

  getWeights: () => j<WeightEntry[]>('/api/weights'),
  putWeight: (w: { date: string; weightKg: number }) => post('/api/weights', w, 'PUT'),
  deleteWeight: (id: string) => j<unknown>(`/api/weights/${id}`, { method: 'DELETE' }),

  resetAll: () => j<unknown>('/api/all', { method: 'DELETE' }),
};
