import type { Units } from '../types';

export const KG_PER_LB = 0.45359237;

export const kgToLb = (kg: number): number => kg / KG_PER_LB;
export const lbToKg = (lb: number): number => lb * KG_PER_LB;
export const cmToIn = (cm: number): number => cm / 2.54;
export const inToCm = (inches: number): number => inches * 2.54;

export function cmToFtIn(cm: number): { ft: number; inch: number } {
  const totalIn = Math.round(cmToIn(cm));
  return { ft: Math.floor(totalIn / 12), inch: totalIn % 12 };
}

export function ftInToCm(ft: number, inch: number): number {
  return inToCm(ft * 12 + inch);
}

export function formatWeight(kg: number, units: Units, decimals = 1): string {
  return units === 'imperial'
    ? `${kgToLb(kg).toFixed(decimals)} lb`
    : `${kg.toFixed(decimals)} kg`;
}

export function formatHeight(cm: number, units: Units): string {
  if (units === 'metric') return `${Math.round(cm)} cm`;
  const { ft, inch } = cmToFtIn(cm);
  return `${ft}′ ${inch}″`;
}

export function formatCalories(kcal: number): string {
  return Math.round(kcal).toLocaleString('en-US');
}
