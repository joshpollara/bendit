import type { Food } from '../types';
import { db } from '../db/db';

// Open Food Facts integration (SPEC.md §6.2–6.3). Results are cached into
// IndexedDB so a second scan or search hit works offline. OFF serving data is
// crowd-sourced and spotty — the serving the calories are based on is always
// shown and editable downstream.

const OFF_FIELDS = 'code,product_name,brands,serving_size,serving_quantity,nutriments';

interface OffProduct {
  code?: string;
  product_name?: string;
  brands?: string;
  serving_size?: string;
  serving_quantity?: number | string;
  nutriments?: Record<string, number | string | undefined>;
}

function num(v: number | string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function mapProduct(p: OffProduct, barcode?: string): Food | null {
  const name = p.product_name?.trim();
  const code = p.code ?? barcode;
  if (!name || !code) return null;

  const n = p.nutriments ?? {};
  const kcalServing = num(n['energy-kcal_serving']);
  const kcal100g = num(n['energy-kcal_100g']);
  const servingGrams = num(p.serving_quantity);

  let caloriesPerServing: number;
  let servingLabel: string;
  let grams: number | undefined;

  if (kcalServing !== undefined) {
    caloriesPerServing = Math.round(kcalServing);
    servingLabel = p.serving_size?.trim() || (servingGrams ? `${servingGrams} g` : '1 serving');
    grams = servingGrams;
  } else if (kcal100g !== undefined && servingGrams) {
    caloriesPerServing = Math.round((kcal100g * servingGrams) / 100);
    servingLabel = p.serving_size?.trim() || `${servingGrams} g`;
    grams = servingGrams;
  } else if (kcal100g !== undefined) {
    caloriesPerServing = Math.round(kcal100g);
    servingLabel = '100 g';
    grams = 100;
  } else {
    return null;
  }

  const perServing = (key: string): number | undefined => {
    const serving = num(n[`${key}_serving`]);
    if (serving !== undefined) return serving;
    const per100 = num(n[`${key}_100g`]);
    if (per100 !== undefined && grams) return +((per100 * grams) / 100).toFixed(1);
    return undefined;
  };

  return {
    id: `off-${code}`,
    name,
    brand: p.brands?.split(',')[0]?.trim() || undefined,
    barcode: code,
    servingLabel,
    servingGrams: grams,
    caloriesPerServing,
    protein: perServing('proteins'),
    carbs: perServing('carbohydrates'),
    fat: perServing('fat'),
    source: 'openfoodfacts',
  };
}

async function cache(food: Food): Promise<Food> {
  await db.foods.put(food);
  return food;
}

export async function lookupBarcode(barcode: string): Promise<Food | null> {
  const cached = await db.foods.where('barcode').equals(barcode).first();
  if (cached) return cached;

  const res = await fetch(
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${OFF_FIELDS}`,
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { status?: number; product?: OffProduct };
  if (!data.product) return null;

  const food = mapProduct(data.product, barcode);
  return food ? cache(food) : null;
}

export async function searchOpenFoodFacts(query: string): Promise<Food[]> {
  const url =
    'https://world.openfoodfacts.org/cgi/search.pl?action=process&search_simple=1&json=1' +
    `&page_size=20&fields=${OFF_FIELDS}&search_terms=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as { products?: OffProduct[] };
  const foods = (data.products ?? [])
    .map((p) => mapProduct(p))
    .filter((food): food is Food => food !== null);
  await db.foods.bulkPut(foods);
  return foods;
}
