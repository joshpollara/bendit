import { describe, expect, it } from 'vitest';
import {
  dayImpact,
  entryMacro,
  macroTargets,
  standingFor,
  standingWithout,
  sumMacros,
  targetStatus,
  tracksAnyMacro,
} from './macros';

const oats = { protein: 5, carbs: 27, fat: 3 };

describe('entryMacro', () => {
  it("scales the food's grams by the servings", () => {
    expect(entryMacro({ servings: 2, food: oats }, 'carbs')).toBe(54);
  });

  it('prefers grams typed onto the entry over the food behind it', () => {
    expect(entryMacro({ servings: 2, food: oats, proteinCached: 12 }, 'protein')).toBe(12);
    // Only the typed one: the others still come from the food.
    expect(entryMacro({ servings: 2, food: oats, proteinCached: 12 }, 'fat')).toBe(6);
  });

  it('counts an entry that knows nothing as nothing, not as an error', () => {
    expect(entryMacro({ servings: 1 }, 'protein')).toBe(0);
    expect(entryMacro({ servings: 1, food: {} }, 'fat')).toBe(0);
  });
});

describe('sumMacros', () => {
  it('adds every entry, unrounded', () => {
    const total = sumMacros([
      { servings: 1.5, food: oats },
      { servings: 1, proteinCached: 18, carbsCached: 24.5, fatCached: 5 },
    ]);
    expect(total).toEqual({ protein: 25.5, carbs: 65, fat: 9.5 });
  });
});

describe('macroTargets', () => {
  it('reads the three targets off the profile', () => {
    expect(macroTargets({ proteinTargetG: 130, carbsTargetG: 200, fatTargetG: 55 })).toEqual({
      protein: 130,
      carbs: 200,
      fat: 55,
    });
  });

  it('treats an unset or zero target as not tracked', () => {
    const targets = macroTargets({ proteinTargetG: 130, carbsTargetG: 0, fatTargetG: null });
    expect(targets).toEqual({ protein: 130, carbs: null, fat: null });
    expect(tracksAnyMacro(targets)).toBe(true);
    expect(tracksAnyMacro(macroTargets({}))).toBe(false);
  });
});

describe('targetStatus', () => {
  it('protein is a floor: good once reached', () => {
    expect(targetStatus('protein', 90, 120)).toBe('ok');
    expect(targetStatus('protein', 120, 120)).toBe('good');
    expect(targetStatus('protein', 150, 120)).toBe('good');
  });

  it('carbs, fat, and calories are ceilings: over once passed', () => {
    expect(targetStatus('carbs', 150, 200)).toBe('good');
    expect(targetStatus('carbs', 200, 200)).toBe('good');
    expect(targetStatus('fat', 61, 60)).toBe('over');
    expect(targetStatus('calories', 1900, 1800)).toBe('over');
  });
});

describe('dayImpact', () => {
  const day = standingFor(
    [
      { caloriesCached: 300, servings: 2, food: oats },
      { caloriesCached: 220, servings: 1, proteinCached: 18, carbsCached: 24.5, fatCached: 5 },
    ],
    1800,
    { protein: 120, carbs: 200, fat: 60 },
  );

  it('measures the day so far', () => {
    expect(day.calories).toEqual({ eaten: 520, budget: 1800 });
    expect(day.macros.eaten).toEqual({ protein: 28, carbs: 78.5, fat: 11 });
  });

  it('shows every tracked figure before, with this, and after', () => {
    const rows = dayImpact(day, { calories: 400, protein: 30, carbs: 40, fat: 12 });
    expect(rows.map((r) => r.key)).toEqual(['calories', 'protein', 'carbs', 'fat']);

    const calories = rows[0];
    expect(calories.before).toBe(520);
    expect(calories.adding).toBe(400);
    expect(calories.after).toBe(920);
    expect(calories.target).toBe(1800);
    expect(calories.beforeShare).toBeCloseTo(520 / 1800);
    expect(calories.afterShare).toBeCloseTo(920 / 1800);
    expect(calories.status).toBe('good');

    const protein = rows[1];
    expect(protein.after).toBe(58);
    expect(protein.unit).toBe('g');
    expect(protein.status).toBe('ok');
  });

  it('turns a ceiling red when this entry would take the day past it', () => {
    const rows = dayImpact(day, { calories: 1300, protein: 10, carbs: 130, fat: 20 });
    expect(rows.find((r) => r.key === 'calories')?.status).toBe('over');
    expect(rows.find((r) => r.key === 'carbs')?.status).toBe('over');
    expect(rows.find((r) => r.key === 'fat')?.status).toBe('good');
    // The bar never runs past its end, however far over the day is.
    expect(rows.find((r) => r.key === 'carbs')?.afterShare).toBe(1);
  });

  it('keeps a macro whose grams nobody knows, but does not add to it', () => {
    const [, protein] = dayImpact(day, { calories: 400, protein: null, carbs: null, fat: null });
    expect(protein.adding).toBeNull();
    expect(protein.after).toBe(28);
  });

  it('leaves out a macro with no target that this entry knows nothing about', () => {
    const untracked = standingFor([], 1800, { protein: 120, carbs: null, fat: null });
    const rows = dayImpact(untracked, { calories: 200, protein: 10, carbs: null, fat: 8 });
    expect(rows.map((r) => r.key)).toEqual(['calories', 'protein', 'fat']);
    // A macro with no target has no share to fill and no status to be in.
    const fat = rows[2];
    expect(fat.target).toBeNull();
    expect(fat.status).toBeNull();
    expect(fat.afterShare).toBe(0);
  });
});

describe('standingWithout', () => {
  it("takes an entry back out, so editing it is measured against the rest of the day", () => {
    const entry = { caloriesCached: 300, servings: 2, food: oats };
    const day = standingFor(
      [entry, { caloriesCached: 220, servings: 1, proteinCached: 18, carbsCached: 24.5, fatCached: 5 }],
      1800,
      { protein: 120, carbs: 200, fat: 60 },
    );
    const rest = standingWithout(day, entry);
    expect(rest.calories).toEqual({ eaten: 220, budget: 1800 });
    expect(rest.macros.eaten).toEqual({ protein: 18, carbs: 24.5, fat: 5 });
    expect(rest.macros.targets).toBe(day.macros.targets);
  });
});
