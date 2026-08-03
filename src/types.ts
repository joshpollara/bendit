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
  /** Daily protein goal in grams; unset means protein isn't being tracked. */
  proteinTargetG?: number | null;
  /** 'formula' = Mifflin-St Jeor; 'measured' = expenditure from your own data. */
  budgetSource?: 'formula' | 'measured';
  measuredTdee?: number | null;
  /** Local hour (0-23) for the evening reminder; null = no reminder. */
  reminderHour?: number | null;
  timezone?: string | null;
}

export const MEASUREMENT_SITES = ['waist', 'hips', 'chest', 'thigh', 'arm', 'neck'] as const;
export type MeasurementSite = (typeof MEASUREMENT_SITES)[number];

export interface Measurement {
  id: string;
  date: string;
  site: MeasurementSite;
  valueCm: number;
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
  source: 'seed' | 'openfoodfacts' | 'usda' | 'custom';
  /** Where the row came from in its source database, so a number can be traced. */
  sourceId?: string | null;
  /** Per-100g/ml canonical nutrition; what gram-based estimates are computed from. */
  basis?: 'g' | 'ml';
  kcal100?: number | null;
  protein100?: number | null;
  carbs100?: number | null;
  fat100?: number | null;
  fiber100?: number | null;
  sugar100?: number | null;
  satFat100?: number | null;
  sodiumMg100?: number | null;
}

export interface FoodServing {
  id: string;
  foodId: string;
  label: string;
  grams: number;
  isDefault: number;
}

export interface FoodLogEntry {
  id: string;
  date: string; // 'YYYY-MM-DD'
  meal: Meal;
  foodId?: string | null; // null for quick adds and for deleted foods
  servings: number; // multiplier on the food's serving
  caloriesCached: number; // denormalized for fast day totals
  label?: string; // name for entries with no food behind them
  /**
   * True when the amount was estimated from a photograph rather than measured
   * or scanned. Shown in the day's list, because a guess presented like a
   * lookup is a guess wearing a lookup's authority.
   */
  estimated?: boolean | number;
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
