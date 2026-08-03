import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, createUsersTable } from './lib/users.mjs';

// Two people, one server. The point of this file is a single claim: nothing
// either of them writes is ever visible to the other.
//
// It is written against the running app rather than the handlers, because the
// filtering it checks lives in about eighty separate queries and the way that
// goes wrong is one of them being forgotten. A test that called the handlers
// directly would be asserting the same mistake it was meant to catch.

const here = path.dirname(fileURLToPath(import.meta.url));

let server;
let base;
let dbPath;

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bendit-iso-')), 'test.db');

  // Two accounts, made the way the CLI makes them.
  const db = new Database(dbPath);
  createUsersTable(db);
  createUser(db, 'ada', 'ada-password-1');
  createUser(db, 'bob', 'bob-password-1');
  db.close();

  server = spawn('node', [path.join(here, 'index.mjs')], {
    env: { ...process.env, PORT: String(port), SQLITE_PATH: dbPath, PHOTOS_DIR: path.join(path.dirname(dbPath), 'photos') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 25_000);
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('bendit server on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });
}, 30_000);

afterAll(() => {
  server?.kill();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

/** Calls as a given person. Credentials go in the header, never in the body. */
async function as(who, method, path, body) {
  const password = `${who}-password-1`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${who}:${password}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

const TODAY = '2026-03-01';

describe('two accounts on one server', () => {
  it('lets each of them in, and nobody else', async () => {
    expect((await as('ada', 'GET', '/api/session')).body.username).toBe('ada');
    const wrong = await fetch(`${base}/api/session`, {
      headers: { authorization: 'Bearer ada:not-the-password' },
    });
    expect((await wrong.json()).authed).toBe(false);
  });

  it('keeps their profiles apart', async () => {
    const profile = (name) => ({
      sex: 'female',
      birthDate: '1990-01-01',
      heightCm: name === 'ada' ? 170 : 185,
      startWeightKg: 70,
      goalWeightKg: 65,
      activityLevel: 'light',
      weeklyRateKg: 0.5,
      units: 'metric',
      createdAt: new Date().toISOString(),
    });
    await as('ada', 'PUT', '/api/profile', profile('ada'));
    await as('bob', 'PUT', '/api/profile', profile('bob'));

    expect((await as('ada', 'GET', '/api/profile')).body.heightCm).toBe(170);
    expect((await as('bob', 'GET', '/api/profile')).body.heightCm).toBe(185);
  });

  it('keeps the day, the week and the report apart', async () => {
    await as('ada', 'POST', '/api/food-log', {
      id: 'ada-entry',
      date: TODAY,
      meal: 'lunch',
      label: "Ada's lunch",
      servings: 1,
      caloriesCached: 600,
    });
    await as('bob', 'POST', '/api/food-log', {
      id: 'bob-entry',
      date: TODAY,
      meal: 'lunch',
      label: "Bob's lunch",
      servings: 1,
      caloriesCached: 900,
    });

    const adaDay = await as('ada', 'GET', `/api/day?date=${TODAY}&yesterday=${TODAY}`);
    expect(adaDay.body.entries.map((e) => e.label)).toEqual(["Ada's lunch"]);

    const bobDay = await as('bob', 'GET', `/api/day?date=${TODAY}&yesterday=${TODAY}`);
    expect(bobDay.body.entries.map((e) => e.label)).toEqual(["Bob's lunch"]);

    const adaReport = await as('ada', 'GET', `/api/report?from=${TODAY}&to=${TODAY}`);
    expect(adaReport.body.days[0].food).toBe(600);
    const bobReport = await as('bob', 'GET', `/api/report?from=${TODAY}&to=${TODAY}`);
    expect(bobReport.body.days[0].food).toBe(900);
  });

  it("won't let one of them edit or delete the other's entry", async () => {
    const edit = await as('bob', 'PATCH', '/api/food-log/ada-entry', { caloriesCached: 1 });
    expect(edit.status).toBe(404);

    const remove = await as('bob', 'DELETE', '/api/food-log/ada-entry');
    expect(remove.status).toBe(200); // deleting nothing is not an error…
    const stillThere = await as('ada', 'GET', `/api/day?date=${TODAY}&yesterday=${TODAY}`);
    expect(stillThere.body.entries).toHaveLength(1); // …but it deleted nothing
    expect(stillThere.body.entries[0].caloriesCached).toBe(600);
  });

  it('keeps weights, exercise and measurements apart, on the same dates', async () => {
    await as('ada', 'PUT', '/api/weights', { date: TODAY, weightKg: 61 });
    await as('bob', 'PUT', '/api/weights', { date: TODAY, weightKg: 82 });
    expect((await as('ada', 'GET', '/api/weights')).body.map((w) => w.weightKg)).toEqual([61]);
    expect((await as('bob', 'GET', '/api/weights')).body.map((w) => w.weightKg)).toEqual([82]);

    await as('ada', 'POST', '/api/exercise', { date: TODAY, name: 'Rowing', minutes: 30, caloriesBurned: 300 });
    await as('bob', 'POST', '/api/exercise', { date: TODAY, name: 'Cycling', minutes: 60, caloriesBurned: 500 });
    const adaDay = await as('ada', 'GET', `/api/day?date=${TODAY}&yesterday=${TODAY}`);
    expect(adaDay.body.exercises.map((e) => e.name)).toEqual(['Rowing']);

    await as('ada', 'PUT', '/api/measurements', { date: TODAY, site: 'waist', valueCm: 74 });
    await as('bob', 'PUT', '/api/measurements', { date: TODAY, site: 'waist', valueCm: 92 });
    expect((await as('ada', 'GET', '/api/measurements')).body.map((m) => m.valueCm)).toEqual([74]);
    expect((await as('bob', 'GET', '/api/measurements')).body.map((m) => m.valueCm)).toEqual([92]);
  });

  it('keeps the "done for today" marker apart', async () => {
    await as('ada', 'PUT', '/api/day-done', { date: TODAY, done: true });
    expect((await as('ada', 'GET', `/api/day?date=${TODAY}&yesterday=${TODAY}`)).body.done).toBe(true);
    expect((await as('bob', 'GET', `/api/day?date=${TODAY}&yesterday=${TODAY}`)).body.done).toBe(false);
  });

  it('keeps saved meals apart, and refuses to log or delete another’s', async () => {
    const made = await as('ada', 'POST', '/api/meal-templates', {
      name: "Ada's breakfast",
      items: [{ foodId: null, servings: 1, caloriesCached: 350, label: 'porridge' }],
    });
    const templateId = made.body.id;

    expect((await as('ada', 'GET', '/api/meal-templates')).body).toHaveLength(1);
    expect((await as('bob', 'GET', '/api/meal-templates')).body).toEqual([]);

    expect((await as('bob', 'POST', `/api/meal-templates/${templateId}/log`, { date: TODAY, meal: 'lunch' })).status).toBe(404);
    expect((await as('bob', 'DELETE', `/api/meal-templates/${templateId}`)).status).toBe(404);
    expect((await as('ada', 'GET', '/api/meal-templates')).body).toHaveLength(1);
  });

  it('keeps a food one of them made private, and shares one with a barcode', async () => {
    await as('ada', 'POST', '/api/foods', {
      id: 'ada-food',
      name: 'Ada secret recipe',
      servingLabel: '1 portion',
      caloriesPerServing: 400,
      source: 'custom',
    });
    await as('ada', 'POST', '/api/foods', {
      id: 'ada-scanned',
      name: 'Scanned packet',
      barcode: '8712345678906',
      servingLabel: '100 g',
      servingGrams: 100,
      caloriesPerServing: 250,
      source: 'custom',
    });

    // Private: not in Bob's search, not in his browse.
    expect((await as('bob', 'GET', '/api/foods?q=Ada%20secret')).body).toEqual([]);
    const bobBrowse = await as('bob', 'GET', '/api/foods/browse?q=Ada');
    expect(bobBrowse.body.map((f) => f.id)).not.toContain('ada-food');
    // Ada still finds her own.
    expect((await as('ada', 'GET', '/api/foods?q=Ada%20secret')).body.map((f) => f.id)).toContain('ada-food');

    // Shared: the barcode belongs to the packet, so Bob's scan finds it.
    const scan = await as('bob', 'GET', '/api/foods/barcode/8712345678906');
    expect(scan.body?.id).toBe('ada-scanned');
  });

  it("won't let one of them delete the other's food", async () => {
    const attempt = await as('bob', 'DELETE', '/api/foods/ada-food');
    expect(attempt.status).toBe(403);
    expect((await as('ada', 'GET', '/api/foods?q=Ada%20secret')).body).toHaveLength(1);
  });

  it('keeps exports apart', async () => {
    const adaCsv = (await as('ada', 'GET', '/api/export/food-log.csv')).body;
    expect(adaCsv).toContain("Ada's lunch");
    expect(adaCsv).not.toContain("Bob's lunch");
  });

  it('deletes only the requester’s data when asked to delete everything', async () => {
    await as('ada', 'DELETE', '/api/all');

    expect((await as('ada', 'GET', `/api/day?date=${TODAY}&yesterday=${TODAY}`)).body.entries).toEqual([]);
    expect((await as('ada', 'GET', '/api/weights')).body).toEqual([]);
    expect((await as('ada', 'GET', '/api/profile')).body).toBeNull();

    // Bob is untouched.
    const bobDay = await as('bob', 'GET', `/api/day?date=${TODAY}&yesterday=${TODAY}`);
    expect(bobDay.body.entries.map((e) => e.label)).toEqual(["Bob's lunch"]);
    expect((await as('bob', 'GET', '/api/weights')).body.map((w) => w.weightKg)).toEqual([82]);
    expect((await as('bob', 'GET', '/api/profile')).body.heightCm).toBe(185);

    // The shared food database survives, and so does the scanned packet.
    expect((await as('bob', 'GET', '/api/foods/barcode/8712345678906')).body?.id).toBe('ada-scanned');
    expect((await as('bob', 'GET', '/api/foods?q=chicken')).body.length).toBeGreaterThan(0);
  });
});
