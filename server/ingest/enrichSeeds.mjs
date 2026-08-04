#!/usr/bin/env node
// Fills in the nutrients the seed foods never carried.
//
//   node server/ingest/enrichSeeds.mjs --db reference.db [--write]
//
// The 190 hand-curated foods hold calories and the three macros, which is all
// the app needed until a Nutri-Score grade wanted sugar, saturated fat and
// sodium too. Those are exactly the nutrients USDA publishes, so each seed is
// matched against the reference data and the missing figures are copied across.
//
// Only gaps are filled: the curated calories and macros are what makes these
// rows worth having, and are never overwritten. Anything that doesn't match
// confidently is left alone and listed, because a wrong match here would put a
// grade on a food that never earned it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { matchCandidates } from '../lib/foodSearch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEEDS = path.join(here, '..', 'seedFoods.json');

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const dbPath = arg('db') ?? process.env.SQLITE_PATH;
if (!dbPath) {
  process.stderr.write('usage: enrichSeeds.mjs --db <reference.db> [--write]\n');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const seeds = JSON.parse(fs.readFileSync(SEEDS, 'utf8'));

/** Per-100g from a seed's own serving, which is what the copied figures scale to. */
const per100Factor = (seed) => (seed.servingGrams > 0 ? 100 / seed.servingGrams : null);

// Foods that are wholly fruit, vegetable, pulse or nut. The official algorithm
// credits that share, and without it whole fruit and veg grade a letter worse
// than they should. Matched on the name, checked by eye — there are 190 of
// these, and a wrong entry would flatter a food.
const WHOLE_PLANT =
  /^(apple|banana|orange|pear|peach|plum|grape|strawberr|blueberr|raspberr|blackberr|cherr|melon|watermelon|pineapple|mango|kiwi|avocado|clementine|mandarin|apricot|fig|date|prune|raisin|cranberr|pomegranate|papaya|nectarine|lemon|lime|grapefruit)|^(broccoli|carrot|spinach|kale|lettuce|cucumber|tomato|cherry tomato|pepper|bell pepper|onion|garlic|courgette|zucchini|aubergine|eggplant|cauliflower|cabbage|celery|asparagus|green bean|pea|sweetcorn|corn|mushroom|beetroot|leek|squash|pumpkin|sweet potato|potato|radish|rocket|salad|brussels)|(beans|lentils|chickpeas|edamame)\b|^(almond|walnut|cashew|pistachio|peanut|hazelnut|pecan)/i;

let filled = 0;
const missed = [];

for (const seed of seeds) {
  const factor = per100Factor(seed);
  if (!factor) {
    missed.push(`${seed.name} (no serving weight)`);
    continue;
  }

  // Reference sources only: a crowd-sourced product's figures are not what a
  // curated generic food should inherit.
  //
  // The best-named match often has no sugar figure of its own — USDA's cooked
  // broccoli doesn't — so the candidates are walked until one can answer. A
  // row that agrees on calories and carries the nutrients is a better source
  // than a row that merely has a closer name.
  const seedKcal100 = seed.caloriesPerServing * factor;
  const agrees = (row) =>
    row.source === 'usda' &&
    row.kcal100 > 0 &&
    Math.abs(row.kcal100 - seedKcal100) / seedKcal100 <= 0.25;

  const candidates = matchCandidates(db, seed.name, { preferSources: ['usda'], limit: 8 }).filter(agrees);
  const complete = candidates.find(
    (row) => row.sugar100 != null && row.satFat100 != null && row.sodiumMg100 != null,
  );
  const match = complete ?? candidates[0];
  if (!match) {
    const nearest = matchCandidates(db, seed.name, { preferSources: ['usda'], limit: 1 })[0];
    missed.push(
      nearest
        ? `${seed.name} → ${nearest.name} (${Math.round(nearest.kcal100 ?? 0)} vs ${Math.round(seedKcal100)} kcal)`
        : seed.name,
    );
    continue;
  }

  const before = JSON.stringify(seed);
  if (seed.fruitVeg == null && WHOLE_PLANT.test(seed.name)) seed.fruitVeg = 100;
  // Stored per serving, like everything else on these rows.
  for (const [field, column] of [
    ['sugar', 'sugar100'],
    ['satFat', 'satFat100'],
    ['sodiumMg', 'sodiumMg100'],
    ['fiber', 'fiber100'],
  ]) {
    if (seed[field] == null && match[column] != null) {
      seed[field] = Math.round((match[column] / factor) * 10) / 10;
    }
  }
  seed.nutrientSource = seed.nutrientSource ?? `usda:${match.sourceId ?? match.id}`;
  if (JSON.stringify(seed) !== before) filled++;
}

process.stdout.write(`filled ${filled} of ${seeds.length} seed foods\n`);
if (missed.length) {
  process.stdout.write(`left alone (${missed.length}):\n`);
  for (const name of missed.slice(0, 12)) process.stdout.write(`  ${name}\n`);
  if (missed.length > 12) process.stdout.write(`  …and ${missed.length - 12} more\n`);
}

if (process.argv.includes('--write')) {
  fs.writeFileSync(SEEDS, `${JSON.stringify(seeds, null, 2)}\n`);
  process.stdout.write(`written to ${SEEDS}\n`);
} else {
  process.stdout.write('\ndry run — pass --write to save\n');
  const sample = seeds.find((s) => s.nutrientSource);
  if (sample) process.stdout.write(`example: ${JSON.stringify(sample)}\n`);
}
db.close();
