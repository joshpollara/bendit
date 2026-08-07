import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, createUsersTable } from './lib/users.mjs';

// The whole server, started the way it starts in production, with a stand-in
// for the model.
//
// Every other server test exercises a handler on its own, and one of them —
// the photo upload — passed for weeks while the real endpoint was broken: an
// app-wide JSON parser ran first and rejected anything over 100kb, which no
// stubbed 8kb image ever tripped. Middleware order, auth, and route mounting
// only exist in the assembled app, so this test assembles it.
//
// No network and no key: VISION_ENDPOINT points at a stub in this process.

const here = path.dirname(fileURLToPath(import.meta.url));

/** A photo-sized payload — the thing that used to be rejected. */
const A_REAL_PHOTO = Buffer.alloc(300 * 1024, 7).toString('base64');

const LABEL_ANSWER = {
  name: 'Havermout',
  brand: 'Albert Heijn',
  basis: 'g',
  servingLabel: '1 portie (40 g)',
  servingGrams: 40,
  servingsPerContainer: 12,
  per100: { calories: 375, protein: 12.5, carbs: 67.5, fat: 7.5, fiber: 10 },
  perServing: null,
  confidence: 'high',
};

const MEAL_ANSWER = {
  items: [
    { name: 'white rice', grams: 200, confidence: 'medium' },
    { name: 'grilled chicken breast', grams: 150, confidence: 'high' },
  ],
};

let server;
let stub;
let base;
let dbPath;
let modelCalls = 0;

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Answers like the model does, choosing its reply from the schema it was sent. */
function startStub(port) {
  return new Promise((resolve) => {
    stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        modelCalls++;
        const sent = JSON.parse(body);
        const isMeal = 'items' in sent.generationConfig.responseSchema.properties;
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: JSON.stringify(isMeal ? MEAL_ANSWER : LABEL_ANSWER) }] } },
            ],
            usageMetadata: { promptTokenCount: 1300, candidatesTokenCount: 180, totalTokenCount: 1480 },
          }),
        );
      });
    });
    stub.listen(port, resolve);
  });
}

beforeAll(async () => {
  const [appPort, stubPort] = [await freePort(), await freePort()];
  await startStub(stubPort);

  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bendit-test-')), 'test.db');
  base = `http://127.0.0.1:${appPort}`;

  // An account to call as: photo endpoints are behind the same guard as
  // everything else.
  const seed = new Database(dbPath);
  createUsersTable(seed);
  createUser(seed, 'tester', 'test-password');
  seed.close();

  server = spawn('node', [path.join(here, 'index.mjs')], {
    env: {
      ...process.env,
      PORT: String(appPort),
      SQLITE_PATH: dbPath,
      GEMINI_API_KEY: 'test-key',
      VISION_ENDPOINT: `http://127.0.0.1:${stubPort}/models`,
      VISION_DAILY_LIMIT: '4',
    },
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

afterAll(async () => {
  server?.kill();
  await new Promise((resolve) => stub.close(resolve));
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const post = async (path, body, { auth = true } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: 'Bearer tester:test-password' } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Left null: an HTML body is itself the thing worth asserting about.
  }
  return { status: response.status, body: parsed, text };
};

const get = async (path, { auth = true } = {}) => {
  const response = await fetch(`${base}${path}`, {
    headers: auth ? { authorization: 'Bearer tester:test-password' } : {},
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

describe('the assembled server', () => {
  it('reads a photographed label sent at the size a phone sends', async () => {
    const { status, body, text } = await post('/api/labels/extract', { image: A_REAL_PHOTO });
    expect(text.startsWith('<!DOCTYPE'), 'got an HTML error page, not JSON').toBe(false);
    expect(status).toBe(200);
    expect(body.food.name).toBe('Havermout');
    expect(body.food.kcal100).toBe(375);
    expect(body.confidence).toBe('high');
    expect(body.issues).toEqual([]);
  });

  it('prices a photographed meal from the seeded food database', async () => {
    const { status, body } = await post('/api/meals/estimate', { image: A_REAL_PHOTO });
    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    // Real seed rows: white rice 130 kcal/100g, grilled chicken breast ~167.
    expect(body.items[0].food.name).toMatch(/rice/i);
    expect(body.total.calories).toBeGreaterThan(300);
    expect(body.total.low).toBeLessThan(body.total.calories);
    // Nothing nutritional came from the model; every figure is a lookup.
    expect(body.items.every((i) => i.food === null || i.food.kcal100 > 0)).toBe(true);
  });

  it('refuses an unauthenticated photo without calling the model', async () => {
    const before = modelCalls;
    const { status } = await post('/api/labels/extract', { image: A_REAL_PHOTO }, { auth: false });
    expect(status).toBe(401);
    expect(modelCalls).toBe(before);
  });

  it('stops at the daily ceiling', async () => {
    // Two calls are already spent; the limit is four.
    await post('/api/meals/estimate', { image: A_REAL_PHOTO });
    await post('/api/meals/estimate', { image: A_REAL_PHOTO });
    const { status, body } = await post('/api/meals/estimate', { image: A_REAL_PHOTO });
    expect(status).toBe(429);
    expect(body.error.code).toBe('quota_exceeded');
  });

  it('reports what the model has been used for, and what it came to', async () => {
    const { status, body } = await get('/api/vision/usage');
    expect(status).toBe(200);
    // Four calls were made above, which is also the limit this server runs on.
    expect(body.usedToday).toBe(4);
    expect(body.dailyLimit).toBe(4);
    expect(body.remainingToday).toBe(0);
    expect(body.windows.today.calls).toBe(4);
    expect(body.windows.all.inputTokens).toBe(4 * 1300);
    expect(body.windows.all.costUsd).toBeGreaterThan(0);
    expect(body.byTask.map((t) => t.task).sort()).toEqual(['label', 'meal']);
    expect(body.recent).toHaveLength(4);
    // The quota rejection never reached the model, so it was never logged.
    expect(body.byError).toEqual([]);
  });

  it('keeps the usage figures behind the same guard as everything else', async () => {
    const { status } = await get('/api/vision/usage', { auth: false });
    expect(status).toBe(401);
  });

  it('recorded every call, with what it cost', async () => {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT task, status, model, totalTokens FROM vision_requests').all();
    db.close();
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((r) => r.totalTokens === 1480 || r.status === 'error')).toBe(true);
    expect(new Set(rows.map((r) => r.task))).toEqual(new Set(['label', 'meal']));
  });
});
