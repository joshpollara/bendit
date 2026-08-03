import type { ActivityLevel, Profile, Sex } from '../types';

// Pure calorie math — SPEC.md §4. No I/O, no dates from the environment.

export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export const KCAL_PER_KG_FAT = 7700;

// Safe daily minimums; the budget never drops below these.
export const MIN_BUDGET: Record<Sex, number> = {
  male: 1500,
  female: 1200,
};

export function ageInYears(birthDate: string, onDate: string): number {
  const birth = new Date(`${birthDate}T00:00:00`);
  const on = new Date(`${onDate}T00:00:00`);
  let age = on.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    on.getMonth() < birth.getMonth() ||
    (on.getMonth() === birth.getMonth() && on.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

// Mifflin-St Jeor
export function bmr(sex: Sex, weightKg: number, heightCm: number, ageYears: number): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return sex === 'male' ? base + 5 : base - 161;
}

export function tdee(bmrValue: number, activityLevel: ActivityLevel): number {
  return bmrValue * ACTIVITY_FACTORS[activityLevel];
}

export function dailyDeficit(weeklyRateKg: number): number {
  return (weeklyRateKg * KCAL_PER_KG_FAT) / 7;
}

export interface BudgetResult {
  budget: number; // the daily calorie budget shown to the user
  raw: number; // budget before the safety floor
  floored: boolean; // true when the rate pushed below the safe minimum
  bmr: number;
  tdee: number;
  deficit: number;
}

// currentWeightKg lets the budget follow the user's latest logged weight,
// falling back to the profile's start weight.
export function computeBudget(
  profile: Pick<Profile, 'sex' | 'birthDate' | 'heightCm' | 'startWeightKg' | 'activityLevel' | 'weeklyRateKg'>,
  onDate: string,
  currentWeightKg?: number,
): BudgetResult {
  const weightKg = currentWeightKg ?? profile.startWeightKg;
  const age = ageInYears(profile.birthDate, onDate);
  const bmrValue = bmr(profile.sex, weightKg, profile.heightCm, age);
  const tdeeValue = tdee(bmrValue, profile.activityLevel);
  const deficit = dailyDeficit(profile.weeklyRateKg);
  const raw = Math.round(tdeeValue - deficit);
  const floor = MIN_BUDGET[profile.sex];
  const floored = raw < floor;
  return {
    budget: floored ? floor : raw,
    raw,
    floored,
    bmr: bmrValue,
    tdee: tdeeValue,
    deficit,
  };
}

/**
 * A protein target to suggest, in grams: 1.6 g per kg of goal body weight —
 * the middle of the range the muscle-retention literature settles on for
 * someone in a deficit. Rounded to something a person would actually type.
 */
export function suggestedProteinG(goalWeightKg: number): number {
  return Math.round((goalWeightKg * 1.6) / 5) * 5;
}

// The Budget screen equation: remaining = budget − food + exercise.
export function remaining(budget: number, foodCalories: number, exerciseCalories: number): number {
  return budget - foodCalories + exerciseCalories;
}
