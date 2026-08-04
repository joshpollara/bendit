import Database from 'better-sqlite3';
import { PER_100_FIELDS } from '../../lib/foodSchema.mjs';

// Writing canonical records into the live database.
//
// Upsert semantics, keyed on (source, sourceId): re-running an import updates
// rows rather than duplicating them, which is what makes the refresh job safe
// to run on a schedule. Foods the user created or edited are never touched —
// their source is 'custom' and no importer claims that.

export function openDatabase(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');

  // The app adds columns as it starts; an importer run against a database that
  // hasn't been started since is otherwise a raw SQLite error about a column
  // nobody mentioned. The writer knows what it writes, so it ensures them.
  const present = new Set(db.prepare('PRAGMA table_info(foods)').all().map((c) => c.name));
  for (const [name, type] of Object.entries({ nutriGrade: 'TEXT', nova: 'INTEGER', ownerId: 'TEXT' })) {
    if (!present.has(name)) db.exec(`ALTER TABLE foods ADD COLUMN ${name} ${type}`);
  }
  return db;
}

const COLUMNS = [
  'id', 'name', 'brand', 'barcode', 'servingLabel', 'servingGrams',
  'caloriesPerServing', 'protein', 'carbs', 'fat', 'source', 'sourceId',
  'basis', 'nutriGrade', 'nova', 'updatedAt', ...PER_100_FIELDS,
];

export function createWriter(db) {
  const insert = db.prepare(
    `INSERT INTO foods (${COLUMNS.join(', ')})
     VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})
     ON CONFLICT(id) DO UPDATE SET
       ${COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`,
  );
  const clearServings = db.prepare('DELETE FROM food_servings WHERE foodId = ?');
  const addServing = db.prepare(
    `INSERT INTO food_servings (id, foodId, label, grams, isDefault)
     VALUES (@id, @foodId, @label, @grams, @isDefault)`,
  );

  /** Writes a batch in one transaction — the difference between minutes and hours. */
  const writeBatch = db.transaction((foods) => {
    for (const food of foods) {
      const row = {};
      for (const column of COLUMNS) row[column] = food[column] ?? null;
      insert.run(row);
      clearServings.run(food.id);
      (food.servings ?? []).forEach((serving, index) =>
        addServing.run({
          id: `${food.id}:${index}`,
          foodId: food.id,
          label: serving.label,
          grams: serving.grams,
          isDefault: index === 0 ? 1 : 0,
        }),
      );
    }
  });

  let pending = [];
  let written = 0;
  return {
    add(food) {
      pending.push(food);
      if (pending.length >= 500) this.flush();
    },
    flush() {
      if (pending.length === 0) return;
      writeBatch(pending);
      written += pending.length;
      pending = [];
    },
    get written() {
      return written;
    },
  };
}

/** Progress that's readable when a run takes twenty minutes. */
export function progress(label) {
  let last = 0;
  return (count) => {
    if (count - last < 25_000) return;
    last = count;
    process.stdout.write(`\r  ${label}: ${count.toLocaleString()} rows`);
  };
}
