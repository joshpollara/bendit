#!/usr/bin/env node
// Merges a prepared reference database into the live one.
//
//   node server/ingest/merge.mjs --from reference-foods.db.gz [--db /data/bendit.db]
//
// Why this exists: the Open Food Facts export is 4.5 million rows, and parsing
// it inside a 256MB machine failed a third of the way through. Building the
// reference data somewhere with room and shipping the result is both faster and
// survivable — 24MB compressed against 1.2GB downloaded and 9GB parsed.
//
// Only reference rows are touched. Foods the user created or edited are
// 'custom' and no importer claims that source, so nothing of theirs is at risk.
// Re-running is safe: every row is keyed by id and replaced in place.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const source = arg('from');
const dbPath = arg('db', process.env.SQLITE_PATH ?? '/data/bendit.db');
if (!source) {
  process.stderr.write('usage: merge.mjs --from <reference.db[.gz]> [--db <live.db>]\n');
  process.exit(1);
}

// A .gz is expanded beside the target, on the volume: /tmp is small here.
let referencePath = source;
if (source.endsWith('.gz')) {
  referencePath = path.join(path.dirname(dbPath), 'reference-foods.db');
  process.stdout.write(`Expanding ${source}…\n`);
  await pipeline(fs.createReadStream(source), createGunzip(), fs.createWriteStream(referencePath));
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`ATTACH '${referencePath.replace(/'/g, "''")}' AS ref`);

const before = db.prepare('SELECT COUNT(*) AS n FROM foods').get().n;
const incoming = db.prepare('SELECT COUNT(*) AS n FROM ref.foods').get().n;
process.stdout.write(`Merging ${incoming.toLocaleString()} foods into ${before.toLocaleString()}…\n`);

// The FTS triggers fire per row, which turns a bulk insert into a crawl on a
// shared CPU. They come off for the copy and the index is rebuilt once at the
// end, which is the same result for a fraction of the work.
db.exec(`
  DROP TRIGGER IF EXISTS foods_fts_insert;
  DROP TRIGGER IF EXISTS foods_fts_delete;
  DROP TRIGGER IF EXISTS foods_fts_update;
`);

// Only the columns both sides have: the reference file may have been built by
// an older or newer version of the schema, and a missing column shouldn't stop
// the merge. (PRAGMA takes the schema as a prefix on the pragma, not the table.)
const namesOf = (schema) =>
  new Set(db.prepare(`PRAGMA ${schema}.table_info(foods)`).all().map((c) => c.name));
const incomingColumns = namesOf('ref');
const columns = [...namesOf('main')].filter((name) => incomingColumns.has(name));

db.transaction(() => {
  db.exec(
    `INSERT OR REPLACE INTO foods (${columns.join(', ')})
     SELECT ${columns.join(', ')} FROM ref.foods`,
  );
  db.exec(`DELETE FROM food_servings WHERE foodId IN (SELECT id FROM ref.foods)`);
  db.exec(`INSERT INTO food_servings (id, foodId, label, grams, isDefault)
           SELECT id, foodId, label, grams, isDefault FROM ref.food_servings`);
})();

process.stdout.write('Rebuilding the search index…\n');
db.exec(`
  CREATE TRIGGER IF NOT EXISTS foods_fts_insert AFTER INSERT ON foods BEGIN
    INSERT INTO foods_fts(rowid, name, brand) VALUES (new.rowid, new.name, new.brand);
  END;
  CREATE TRIGGER IF NOT EXISTS foods_fts_delete AFTER DELETE ON foods BEGIN
    INSERT INTO foods_fts(foods_fts, rowid, name, brand) VALUES ('delete', old.rowid, old.name, old.brand);
  END;
  CREATE TRIGGER IF NOT EXISTS foods_fts_update AFTER UPDATE ON foods BEGIN
    INSERT INTO foods_fts(foods_fts, rowid, name, brand) VALUES ('delete', old.rowid, old.name, old.brand);
    INSERT INTO foods_fts(rowid, name, brand) VALUES (new.rowid, new.name, new.brand);
  END;
`);
db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')");
db.exec("INSERT INTO foods_fts(foods_fts) VALUES('integrity-check')");

const after = db.prepare('SELECT COUNT(*) AS n FROM foods').get().n;
const bySource = db.prepare('SELECT source, COUNT(*) AS n FROM foods GROUP BY source ORDER BY n DESC').all();
db.exec('DETACH ref');
db.close();

process.stdout.write(
  `\nDone: ${before.toLocaleString()} → ${after.toLocaleString()} foods\n` +
    bySource.map((r) => `  ${r.source}: ${r.n.toLocaleString()}`).join('\n') +
    '\n',
);
if (referencePath !== source) fs.rmSync(referencePath, { force: true });
