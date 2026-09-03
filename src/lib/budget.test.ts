import { describe, expect, it } from "vitest";
import {
  ACTIVITY_FACTORS,
  ageInYears,
  bmr,
  computeBudget,
  dailyDeficit,
  KCAL_PER_G,
  macroCalories,
  remaining,
  suggestedMacros,
  tdee,
} from "./budget";

describe("ageInYears", () => {
  it("counts full years only", () => {
    expect(ageInYears("1996-05-10", "2026-08-03")).toBe(30);
    expect(ageInYears("1996-09-10", "2026-08-03")).toBe(29);
  });

  it("handles the birthday itself", () => {
    expect(ageInYears("1990-08-03", "2026-08-03")).toBe(36);
    expect(ageInYears("1990-08-04", "2026-08-03")).toBe(35);
  });
});

describe("bmr (Mifflin-St Jeor)", () => {
  it("male: 10*80 + 6.25*180 - 5*30 + 5 = 1780", () => {
    expect(bmr("male", 80, 180, 30)).toBe(1780);
  });

  it("female: 10*65 + 6.25*165 - 5*28 - 161 = 1380.25", () => {
    expect(bmr("female", 65, 165, 28)).toBeCloseTo(1380.25, 5);
  });
});

describe("tdee", () => {
  it("applies each activity factor", () => {
    expect(tdee(1780, "sedentary")).toBeCloseTo(2136);
    expect(tdee(1780, "light")).toBeCloseTo(2447.5);
    expect(tdee(1780, "moderate")).toBeCloseTo(2759);
    expect(tdee(1780, "active")).toBeCloseTo(3070.5);
    expect(tdee(1780, "very_active")).toBeCloseTo(3382);
  });

  it("factors match the spec", () => {
    expect(ACTIVITY_FACTORS).toEqual({
      sedentary: 1.2,
      light: 1.375,
      moderate: 1.55,
      active: 1.725,
      very_active: 1.9,
    });
  });
});

describe("dailyDeficit", () => {
  it("0.5 kg/week = 550 kcal/day", () => {
    expect(dailyDeficit(0.5)).toBeCloseTo(550);
  });

  it("1 lb/week (0.4536 kg) ≈ 499 kcal/day", () => {
    expect(dailyDeficit(0.4536)).toBeCloseTo(498.96, 1);
  });

  it("maintain (0 kg/week) = 0", () => {
    expect(dailyDeficit(0)).toBe(0);
  });
});

describe("computeBudget", () => {
  const male = {
    sex: "male" as const,
    birthDate: "1996-05-10", // 30 on 2026-08-03
    heightCm: 180,
    startWeightKg: 80,
    activityLevel: "sedentary" as const,
    weeklyRateKg: 0.5,
  };

  it("male sedentary, 0.5 kg/week: 2136 - 550 = 1586", () => {
    const r = computeBudget(male, "2026-08-03");
    expect(r.bmr).toBe(1780);
    expect(r.tdee).toBeCloseTo(2136);
    expect(r.budget).toBe(1586);
    expect(r.floored).toBe(false);
  });

  it("uses the current weight when provided", () => {
    const r = computeBudget(male, "2026-08-03", 75);
    // BMR = 10*75 + 6.25*180 - 150 + 5 = 1730; TDEE = 2076; budget = 1526
    expect(r.budget).toBe(1526);
  });

  it("floors an aggressive female budget at 1200 and flags it", () => {
    const r = computeBudget(
      {
        sex: "female",
        birthDate: "1986-08-01", // 40 on 2026-08-03
        heightCm: 160,
        startWeightKg: 55,
        activityLevel: "sedentary",
        weeklyRateKg: 1.0,
      },
      "2026-08-03",
    );
    // BMR = 550 + 1000 - 200 - 161 = 1189; TDEE = 1426.8; raw = 1427 - 1100 = 327
    expect(r.raw).toBe(327);
    expect(r.budget).toBe(1200);
    expect(r.floored).toBe(true);
  });

  it("floors a male budget at 1500", () => {
    const r = computeBudget(
      {
        sex: "male",
        birthDate: "1966-08-01", // 60
        heightCm: 165,
        startWeightKg: 60,
        activityLevel: "sedentary",
        weeklyRateKg: 1.0,
      },
      "2026-08-03",
    );
    // BMR = 600 + 1031.25 - 300 + 5 = 1336.25; TDEE = 1603.5; raw = 1604 - 1100 = 504
    expect(r.budget).toBe(1500);
    expect(r.floored).toBe(true);
  });
});

describe("remaining", () => {
  it("budget - food", () => {
    expect(remaining(1650, 1200)).toBe(450);
  });

  it("goes negative when over budget", () => {
    expect(remaining(1650, 2000)).toBe(-350);
  });
});

describe("computeBudget with a measured expenditure", () => {
  const profile = {
    sex: "male" as const,
    birthDate: "1985-04-02",
    heightCm: 180,
    startWeightKg: 90,
    activityLevel: "light" as const,
    weeklyRateKg: 0.5,
  };

  it("uses the formula when no measurement has been adopted", () => {
    const r = computeBudget(profile, "2026-08-03");
    expect(r.measured).toBe(false);
    expect(r.tdee).toBe(r.formulaTdee);
  });

  it("replaces the formula TDEE with the measured one", () => {
    const r = computeBudget(
      { ...profile, budgetSource: "measured", measuredTdee: 2800 },
      "2026-08-03",
    );
    expect(r.measured).toBe(true);
    expect(r.tdee).toBe(2800);
    expect(r.budget).toBe(Math.round(2800 - r.deficit));
    expect(r.formulaTdee).not.toBe(2800); // still reports what the formula thought
  });

  it("keeps the safety floor above a low measurement", () => {
    const r = computeBudget(
      {
        ...profile,
        budgetSource: "measured",
        measuredTdee: 1600,
        weeklyRateKg: 1,
      },
      "2026-08-03",
    );
    expect(r.floored).toBe(true);
    expect(r.budget).toBe(1500);
  });

  it("ignores a stale measurement once the user switches back to the formula", () => {
    const r = computeBudget(
      { ...profile, budgetSource: "formula", measuredTdee: 2800 },
      "2026-08-03",
    );
    expect(r.measured).toBe(false);
    expect(r.tdee).toBe(r.formulaTdee);
  });
});

describe("suggestedMacros", () => {
  it("protein from goal weight, fat as a quarter of the budget, carbs the rest", () => {
    const t = suggestedMacros(2000, 70);
    // protein: 70 × 1.6 = 112 → 110 (nearest 5)
    expect(t.protein).toBe(110);
    // fat: 2000 × 0.25 / 9 = 55.6 → 55 (nearest 5)
    expect(t.fat).toBe(55);
    // carbs: (2000 − 440 − 495) / 4 = 266.25 → 266
    expect(t.carbs).toBe(266);
  });

  it("adds back up to the budget, within the rounding of a gram of carbs", () => {
    for (const [budget, goal] of [
      [1586, 75],
      [1200, 55],
      [2400, 90],
      [3100, 100],
    ]) {
      const t = suggestedMacros(budget, goal);
      expect(Math.abs(macroCalories(t) - budget)).toBeLessThanOrEqual(2);
    }
  });

  it("never suggests negative carbs when protein and fat already fill the budget", () => {
    // 150 kg goal → 240 g protein = 960 kcal; fat 35 g = 315 kcal; nothing left.
    const t = suggestedMacros(1200, 150);
    expect(t.protein).toBe(240);
    expect(t.fat).toBe(35);
    expect(t.carbs).toBe(0);
  });

  it("uses the Atwater factors", () => {
    expect(KCAL_PER_G).toEqual({ protein: 4, carbs: 4, fat: 9 });
    expect(macroCalories({ protein: 100, carbs: 200, fat: 50 })).toBe(400 + 800 + 450);
  });
});
