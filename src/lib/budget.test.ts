import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FACTORS,
  ageInYears,
  bmr,
  computeBudget,
  dailyDeficit,
  remaining,
  tdee,
} from './budget';

describe('ageInYears', () => {
  it('counts full years only', () => {
    expect(ageInYears('1996-05-10', '2026-08-03')).toBe(30);
    expect(ageInYears('1996-09-10', '2026-08-03')).toBe(29);
  });

  it('handles the birthday itself', () => {
    expect(ageInYears('1990-08-03', '2026-08-03')).toBe(36);
    expect(ageInYears('1990-08-04', '2026-08-03')).toBe(35);
  });
});

describe('bmr (Mifflin-St Jeor)', () => {
  it('male: 10*80 + 6.25*180 - 5*30 + 5 = 1780', () => {
    expect(bmr('male', 80, 180, 30)).toBe(1780);
  });

  it('female: 10*65 + 6.25*165 - 5*28 - 161 = 1380.25', () => {
    expect(bmr('female', 65, 165, 28)).toBeCloseTo(1380.25, 5);
  });
});

describe('tdee', () => {
  it('applies each activity factor', () => {
    expect(tdee(1780, 'sedentary')).toBeCloseTo(2136);
    expect(tdee(1780, 'light')).toBeCloseTo(2447.5);
    expect(tdee(1780, 'moderate')).toBeCloseTo(2759);
    expect(tdee(1780, 'active')).toBeCloseTo(3070.5);
    expect(tdee(1780, 'very_active')).toBeCloseTo(3382);
  });

  it('factors match the spec', () => {
    expect(ACTIVITY_FACTORS).toEqual({
      sedentary: 1.2,
      light: 1.375,
      moderate: 1.55,
      active: 1.725,
      very_active: 1.9,
    });
  });
});

describe('dailyDeficit', () => {
  it('0.5 kg/week = 550 kcal/day', () => {
    expect(dailyDeficit(0.5)).toBeCloseTo(550);
  });

  it('1 lb/week (0.4536 kg) ≈ 499 kcal/day', () => {
    expect(dailyDeficit(0.4536)).toBeCloseTo(498.96, 1);
  });

  it('maintain (0 kg/week) = 0', () => {
    expect(dailyDeficit(0)).toBe(0);
  });
});

describe('computeBudget', () => {
  const male = {
    sex: 'male' as const,
    birthDate: '1996-05-10', // 30 on 2026-08-03
    heightCm: 180,
    startWeightKg: 80,
    activityLevel: 'sedentary' as const,
    weeklyRateKg: 0.5,
  };

  it('male sedentary, 0.5 kg/week: 2136 - 550 = 1586', () => {
    const r = computeBudget(male, '2026-08-03');
    expect(r.bmr).toBe(1780);
    expect(r.tdee).toBeCloseTo(2136);
    expect(r.budget).toBe(1586);
    expect(r.floored).toBe(false);
  });

  it('uses the current weight when provided', () => {
    const r = computeBudget(male, '2026-08-03', 75);
    // BMR = 10*75 + 6.25*180 - 150 + 5 = 1730; TDEE = 2076; budget = 1526
    expect(r.budget).toBe(1526);
  });

  it('floors an aggressive female budget at 1200 and flags it', () => {
    const r = computeBudget(
      {
        sex: 'female',
        birthDate: '1986-08-01', // 40 on 2026-08-03
        heightCm: 160,
        startWeightKg: 55,
        activityLevel: 'sedentary',
        weeklyRateKg: 1.0,
      },
      '2026-08-03',
    );
    // BMR = 550 + 1000 - 200 - 161 = 1189; TDEE = 1426.8; raw = 1427 - 1100 = 327
    expect(r.raw).toBe(327);
    expect(r.budget).toBe(1200);
    expect(r.floored).toBe(true);
  });

  it('floors a male budget at 1500', () => {
    const r = computeBudget(
      {
        sex: 'male',
        birthDate: '1966-08-01', // 60
        heightCm: 165,
        startWeightKg: 60,
        activityLevel: 'sedentary',
        weeklyRateKg: 1.0,
      },
      '2026-08-03',
    );
    // BMR = 600 + 1031.25 - 300 + 5 = 1336.25; TDEE = 1603.5; raw = 1604 - 1100 = 504
    expect(r.budget).toBe(1500);
    expect(r.floored).toBe(true);
  });
});

describe('remaining', () => {
  it('budget - food + exercise', () => {
    expect(remaining(1650, 1200, 300)).toBe(750);
  });

  it('goes negative when over budget', () => {
    expect(remaining(1650, 2000, 100)).toBe(-250);
  });
});
