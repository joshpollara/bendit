import type { Food, FoodLogEntry, Profile } from '../types';

// Macro arithmetic over a day: what each entry brings, where the day stands
// against its targets, and what one more entry would do to that. No I/O.

export const MACROS = ['protein', 'carbs', 'fat'] as const;
export type Macro = (typeof MACROS)[number];
export type MacroGrams = Record<Macro, number>;

export const MACRO_LABELS: Record<Macro, string> = {
  protein: 'Protein',
  carbs: 'Carbs',
  fat: 'Fat',
};

/**
 * Protein is a floor: eat at least this much, and reaching it is the point.
 * Carbohydrate and fat are ceilings, like the calorie budget they were carved
 * from: going past one is what the bar turns red for.
 */
export const MACRO_SENSE: Record<Macro, 'floor' | 'ceiling'> = {
  protein: 'floor',
  carbs: 'ceiling',
  fat: 'ceiling',
};

/** What an entry has to know to say what it contributed. */
export type MacroEntry = Pick<FoodLogEntry, 'servings' | 'proteinCached' | 'carbsCached' | 'fatCached'> & {
  food?: Pick<Food, 'protein' | 'carbs' | 'fat'> | null;
};

/**
 * Grams of one macro in an entry. Grams typed onto the entry win over the
 * food's, because they were put there deliberately; a food's grams scale with
 * the servings; an entry with neither counts as nothing, so a day's total is a
 * floor rather than a claim of completeness.
 */
export function entryMacro(entry: MacroEntry, macro: Macro): number {
  const cached = entry[`${macro}Cached`];
  if (cached != null) return cached;
  if (!entry.food) return 0;
  return (entry.food[macro] ?? 0) * entry.servings;
}

export function entryMacros(entry: MacroEntry): MacroGrams {
  return {
    protein: entryMacro(entry, 'protein'),
    carbs: entryMacro(entry, 'carbs'),
    fat: entryMacro(entry, 'fat'),
  };
}

/** Grams of each macro across some entries, unrounded. */
export function sumMacros(entries: MacroEntry[]): MacroGrams {
  const total: MacroGrams = { protein: 0, carbs: 0, fat: 0 };
  for (const entry of entries) {
    for (const macro of MACROS) total[macro] += entryMacro(entry, macro);
  }
  return total;
}

export type MacroTargetSet = Record<Macro, number | null>;

/** The targets a profile carries; null where that macro isn't being tracked. */
export function macroTargets(
  profile: Pick<Profile, 'proteinTargetG' | 'carbsTargetG' | 'fatTargetG'>,
): MacroTargetSet {
  const target = (g: number | null | undefined) => (g != null && g > 0 ? g : null);
  return {
    protein: target(profile.proteinTargetG),
    carbs: target(profile.carbsTargetG),
    fat: target(profile.fatTargetG),
  };
}

export function tracksAnyMacro(targets: MacroTargetSet): boolean {
  return MACROS.some((macro) => targets[macro] != null);
}

export type TargetStatus = 'ok' | 'good' | 'over';

/**
 * How an amount sits against its target. A floor is 'good' once reached and
 * 'ok' on the way; a ceiling is 'good' while under it and 'over' past it. The
 * calorie budget is a ceiling.
 */
export function targetStatus(key: 'calories' | Macro, amount: number, target: number): TargetStatus {
  const sense = key === 'calories' ? 'ceiling' : MACRO_SENSE[key];
  if (sense === 'floor') return amount >= target ? 'good' : 'ok';
  return amount > target ? 'over' : 'good';
}

/** Where a day stands: what has been eaten, against what was aimed for. */
export interface DayStanding {
  calories: { eaten: number; budget: number };
  macros: { eaten: MacroGrams; targets: MacroTargetSet };
}

export function standingFor(
  entries: (MacroEntry & { caloriesCached: number })[],
  budget: number,
  targets: MacroTargetSet,
): DayStanding {
  return {
    calories: {
      eaten: entries.reduce((sum, entry) => sum + entry.caloriesCached, 0),
      budget,
    },
    macros: { eaten: sumMacros(entries), targets },
  };
}

/**
 * The same day with one entry taken back out — for editing an entry, where
 * what it is about to become should be measured against the day without what
 * it was.
 */
export function standingWithout(
  day: DayStanding,
  entry: MacroEntry & { caloriesCached: number },
): DayStanding {
  const was = entryMacros(entry);
  return {
    calories: { eaten: day.calories.eaten - entry.caloriesCached, budget: day.calories.budget },
    macros: {
      eaten: {
        protein: day.macros.eaten.protein - was.protein,
        carbs: day.macros.eaten.carbs - was.carbs,
        fat: day.macros.eaten.fat - was.fat,
      },
      targets: day.macros.targets,
    },
  };
}

/** What an entry about to be logged brings. Null is a macro nobody knows. */
export interface Addition {
  calories: number;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

export interface ImpactRow {
  key: 'calories' | Macro;
  label: string;
  unit: string;
  before: number;
  adding: number | null;
  after: number;
  target: number | null;
  /** Share of the target filled before and after this, each capped at 1. */
  beforeShare: number;
  afterShare: number;
  status: TargetStatus | null;
}

/**
 * One row per thing the day is measured in: calories always, and each macro
 * that has a target or that this entry knows its share of. A macro with
 * neither has nothing to be relative to, so it stays out of the way.
 */
export function dayImpact(day: DayStanding, adding: Addition): ImpactRow[] {
  const row = (
    key: 'calories' | Macro,
    label: string,
    unit: string,
    before: number,
    add: number | null,
    target: number | null,
  ): ImpactRow => {
    const after = before + (add ?? 0);
    const share = (amount: number) => (target ? Math.min(1, Math.max(0, amount) / target) : 0);
    return {
      key,
      label,
      unit,
      before,
      adding: add,
      after,
      target,
      beforeShare: share(before),
      afterShare: share(after),
      status: target != null ? targetStatus(key, after, target) : null,
    };
  };

  const rows = [
    row('calories', 'Calories', '', day.calories.eaten, adding.calories, day.calories.budget),
  ];
  for (const macro of MACROS) {
    const target = day.macros.targets[macro];
    if (target == null && adding[macro] == null) continue;
    rows.push(row(macro, MACRO_LABELS[macro], 'g', day.macros.eaten[macro], adding[macro], target));
  }
  return rows;
}
