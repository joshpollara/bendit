import Dexie, { type EntityTable } from 'dexie';
import type { ExerciseEntry, Food, FoodLogEntry, Profile, WeightEntry } from '../types';
import { SEED_FOODS } from './seedFoods';

export const db = new Dexie('bendit') as Dexie & {
  profile: EntityTable<Profile, 'id'>;
  foods: EntityTable<Food, 'id'>;
  foodLog: EntityTable<FoodLogEntry, 'id'>;
  exerciseLog: EntityTable<ExerciseEntry, 'id'>;
  weights: EntityTable<WeightEntry, 'id'>;
};

db.version(1).stores({
  profile: 'id',
  foods: 'id, name, barcode, source',
  foodLog: 'id, date, foodId',
  exerciseLog: 'id, date',
  weights: 'id, date',
});

db.on('populate', () => {
  void db.foods.bulkAdd(SEED_FOODS);
});

export const newId = (): string => crypto.randomUUID();

// Single-user app: the profile row lives under a fixed key.
export const PROFILE_ID = 'me';

export async function getProfile(): Promise<Profile | undefined> {
  return db.profile.get(PROFILE_ID);
}

export async function latestWeight(): Promise<WeightEntry | undefined> {
  const all = await db.weights.orderBy('date').toArray();
  return all[all.length - 1];
}

export async function resetAllData(): Promise<void> {
  await db.transaction('rw', [db.profile, db.foods, db.foodLog, db.exerciseLog, db.weights], async () => {
    await Promise.all([
      db.profile.clear(),
      db.foodLog.clear(),
      db.exerciseLog.clear(),
      db.weights.clear(),
      db.foods.where('source').notEqual('seed').delete(),
    ]);
  });
}
