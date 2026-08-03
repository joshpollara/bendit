export type Sex = 'male' | 'female';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
export type Units = 'imperial' | 'metric';
export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snacks';

export interface Profile {
  id: string;
  sex: Sex;
  birthDate: string; // ISO; used for age
  heightCm: number;
  startWeightKg: number;
  goalWeightKg: number;
  activityLevel: ActivityLevel;
  weeklyRateKg: number; // 0.25, 0.5, 0.75, 1.0 kg/week (loss = positive)
  units: Units;
  createdAt: string;
}

export interface Food {
  id: string;
  name: string;
  brand?: string;
  barcode?: string; // UPC/EAN if from a scan
  servingLabel: string; // "1 cup", "1 bar (40g)"
  servingGrams?: number;
  caloriesPerServing: number;
  protein?: number;
  carbs?: number;
  fat?: number; // grams, optional
  source: 'seed' | 'openfoodfacts' | 'custom';
}

export interface FoodLogEntry {
  id: string;
  date: string; // 'YYYY-MM-DD'
  meal: Meal;
  foodId?: string | null; // null for quick adds and for deleted foods
  servings: number; // multiplier on the food's serving
  caloriesCached: number; // denormalized for fast day totals
  label?: string; // name for entries with no food behind them
}

export interface ExerciseEntry {
  id: string;
  date: string;
  name: string; // "Running", "Cycling"
  minutes: number;
  caloriesBurned: number;
}

export interface WeightEntry {
  id: string;
  date: string;
  weightKg: number;
}

export const MEALS: Meal[] = ['breakfast', 'lunch', 'dinner', 'snacks'];

export const MEAL_LABELS: Record<Meal, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snacks: 'Snacks',
};
