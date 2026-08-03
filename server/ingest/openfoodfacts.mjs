#!/usr/bin/env node
// Imports Open Food Facts products, filtered by country.
//
//   node server/ingest/openfoodfacts.mjs [--db path] [--countries netherlands,belgium,germany]
//
// The export is 1.2GB gzipped and about 9GB of text, against a 1GB volume, so
// it is never written to disk: the gzip is inflated and parsed as it arrives
// and only matching rows are kept. Peak memory is one line plus a write batch.
//
// Data © Open Food Facts contributors, made available under the Open Database
// License (ODbL). The app credits this on the Foods screen.

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RowStream } from './lib/csv.mjs';
import { DEFAULT_COUNTRIES, matchesCountries, toFood } from './lib/off.mjs';
import { createWriter, openDatabase, progress } from './lib/store.mjs';

const EXPORT_URL = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const dbPath = arg('db', process.env.SQLITE_PATH ?? './dev.db');
const countries = arg('countries', DEFAULT_COUNTRIES.join(','))
  .split(',')
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);

const db = openDatabase(dbPath);
const writer = createWriter(db);
const tick = progress('scanned');

let scanned = 0;
let kept = 0;
let rejected = 0;

const rows = new RowStream((row) => {
  scanned++;
  tick(scanned);
  if (!matchesCountries(row, countries)) return;
  const food = toFood(row);
  if (!food) {
    rejected++;
    return;
  }
  writer.add(food);
  kept++;
});

process.stdout.write(`Streaming Open Food Facts (countries: ${countries.join(', ') || 'all'})…\n`);
const response = await fetch(EXPORT_URL);
if (!response.ok) throw new Error(`download failed (${response.status})`);

await pipeline(
  Readable.fromWeb(response.body),
  createGunzip(),
  async function* (source) {
    source.setEncoding('utf8');
    for await (const chunk of source) rows.push(chunk);
    rows.end();
    yield ''; // pipeline needs the stage to produce something
  },
  async function* (source) {
    // eslint-disable-next-line no-unused-vars
    for await (const _ of source) {
      // drain
    }
  },
);

writer.flush();
process.stdout.write(
  `\nDone: ${kept.toLocaleString()} products kept, ${rejected.toLocaleString()} rejected as implausible, ` +
    `${scanned.toLocaleString()} scanned → ${dbPath}\n`,
);
db.close();
