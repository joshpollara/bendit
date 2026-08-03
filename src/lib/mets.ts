// MET values from the Compendium of Physical Activities (approximate).
// kcal/min = MET × 3.5 × kg / 200

export interface ExerciseType {
  name: string;
  met: number;
}

export const EXERCISES: ExerciseType[] = [
  { name: 'Walking (3.5 mph)', met: 4.3 },
  { name: 'Running (5 mph)', met: 8.3 },
  { name: 'Running (6 mph)', met: 9.8 },
  { name: 'Running (7.5 mph)', met: 11.8 },
  { name: 'Cycling (moderate)', met: 8.0 },
  { name: 'Cycling (leisure)', met: 5.8 },
  { name: 'Swimming (laps, moderate)', met: 5.8 },
  { name: 'Elliptical trainer', met: 5.0 },
  { name: 'Weight lifting', met: 3.5 },
  { name: 'Yoga', met: 2.5 },
  { name: 'Hiking', met: 6.0 },
  { name: 'Basketball', met: 6.5 },
  { name: 'Tennis', met: 7.3 },
  { name: 'Soccer', met: 7.0 },
  { name: 'Dancing', met: 4.5 },
  { name: 'Jump rope', met: 11.0 },
  { name: 'Rowing machine (moderate)', met: 7.0 },
  { name: 'Stair climbing', met: 9.0 },
  { name: 'HIIT workout', met: 8.0 },
  { name: 'Pilates', met: 3.0 },
  { name: 'Golf (walking)', met: 4.8 },
  { name: 'Gardening', met: 3.8 },
];

export function caloriesBurned(met: number, weightKg: number, minutes: number): number {
  return Math.round(((met * 3.5 * weightKg) / 200) * minutes);
}
