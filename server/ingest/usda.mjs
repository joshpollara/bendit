#!/usr/bin/env node
// Imports USDA FoodData Central whole foods.
//
//   node server/ingest/usda.mjs [--db path] [--dataset foundation|sr_legacy|all]
//
// Foundation Foods and SR Legacy together are about 9,000 generic foods —
// "chicken breast, roasted", "rice, white, cooked" — which is exactly what a
// meal photo needs to match against. Branded Foods is deliberately skipped:
// it's 3.1GB, it's packaged products, and Open Food Facts already covers those
// with barcodes attached.
//
// FoodData Central is in the public domain (17 USC 105); no attribution
// required, though the app credits it anyway.

import { unzipSync, strFromU8 } from 'fflate';
import { forEachRow } from './lib/csv.mjs';
import { buildFoods, buildNutrientMap, collectNutrition, collectPortions } from './lib/usda.mjs';
import { createWriter, openDatabase } from './lib/store.mjs';
import { number } from './lib/csv.mjs';

const DATASETS = {
  foundation: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2025-04-24.zip',
  sr_legacy: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip',
};

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

/**
 * Pulls one CSV out of the archive without decompressing the rest. Matches the
 * exact file name: 'nutrient.csv' must not also select 'food_nutrient.csv' or
 * 'lab_method_nutrient.csv', which sit beside it in the archive.
 */
function extract(zip, filename) {
  const files = unzipSync(zip, {
    filter: (file) => file.name.split('/').pop() === filename,
  });
  const entry = Object.values(files)[0];
  return entry ? strFromU8(entry) : null;
}

async function importDataset(db, name, url) {
  process.stdout.write(`\n${name}: downloading…\n`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: download failed (${response.status})`);
  // These archives are single-digit megabytes; the decompressed CSVs are what
  // costs memory, and they're pulled out one at a time below.
  const zip = new Uint8Array(await response.arrayBuffer());
  process.stdout.write(`  archive ${(zip.length / 1e6).toFixed(1)}MB\n`);

  const nutrientRows = [];
  forEachRow(extract(zip, 'nutrient.csv') ?? '', (row) => nutrientRows.push(row));
  const nutrientMap = buildNutrientMap(nutrientRows);

  const measureUnits = new Map();
  forEachRow(extract(zip, 'measure_unit.csv') ?? '', (row) => {
    const id = number(row.id);
    if (id != null && row.name) measureUnits.set(id, row.name);
  });

  const nutritionRows = [];
  forEachRow(extract(zip, 'food_nutrient.csv') ?? '', (row) => nutritionRows.push(row));
  const nutrition = collectNutrition(nutritionRows, nutrientMap);
  nutritionRows.length = 0; // release before building the next table

  const portionRows = [];
  forEachRow(extract(zip, 'food_portion.csv') ?? '', (row) => portionRows.push(row));
  const portions = collectPortions(portionRows, measureUnits);
  portionRows.length = 0;

  const foodRows = [];
  forEachRow(extract(zip, 'food.csv') ?? '', (row) => foodRows.push(row));

  const foods = buildFoods({ foods: foodRows, nutrition, portions });
  const writer = createWriter(db);
  for (const food of foods) writer.add(food);
  writer.flush();
  process.stdout.write(`  imported ${writer.written.toLocaleString()} foods\n`);
  return writer.written;
}

const dbPath = arg('db', process.env.SQLITE_PATH ?? './dev.db');
const which = arg('dataset', 'all');
const db = openDatabase(dbPath);

let total = 0;
for (const [name, url] of Object.entries(DATASETS)) {
  if (which !== 'all' && which !== name) continue;
  total += await importDataset(db, name, url);
}
process.stdout.write(`\nDone: ${total.toLocaleString()} USDA foods in ${dbPath}\n`);
db.close();
