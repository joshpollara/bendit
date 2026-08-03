import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

// A photo is a few hundred kilobytes of base64. Express's JSON parser defaults
// to a 100kb limit, and an app-wide parser runs before any route's own — so a
// real photo was rejected with an HTML error page before the endpoint it was
// addressed to ever saw it. Every stubbed test used an 8kb image and passed.
//
// This exercises the middleware order against a body the size of a real photo.

const A_REAL_PHOTO = 'A'.repeat(300 * 1024);

let server;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** Starts an app shaped like the real one and posts a large body to `path`. */
async function postLarge(buildApp, path) {
  const app = buildApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: A_REAL_PHOTO }),
  });
  return { status: response.status, text: await response.text() };
}

const withGlobalParser = () => {
  const app = express();
  app.use(express.json()); // the shape that broke
  app.post('/api/labels/extract', express.json({ limit: '4mb' }), (req, res) =>
    res.json({ got: req.body.image.length }),
  );
  return app;
};

const withExemption = () => {
  const app = express();
  const IMAGE_ROUTES = new Set(['/api/labels/extract']);
  const parseJson = express.json();
  app.use((req, res, next) => (IMAGE_ROUTES.has(req.path) ? next() : parseJson(req, res, next)));
  app.post('/api/labels/extract', express.json({ limit: '4mb' }), (req, res) =>
    res.json({ got: req.body.image.length }),
  );
  app.post('/api/other', (req, res) => res.json({ ok: true }));
  return app;
};

describe('photo uploads', () => {
  it('is rejected when an app-wide parser sees the body first', async () => {
    // Documents the failure this exists to prevent: 413, and Express's own
    // HTML error page rather than the endpoint's typed JSON.
    const { status, text } = await postLarge(withGlobalParser, '/api/labels/extract');
    expect(status).toBe(413);
    expect(text).toContain('<!DOCTYPE html>');
  });

  it('reaches the endpoint when the image routes are exempt', async () => {
    const { status, text } = await postLarge(withExemption, '/api/labels/extract');
    expect(status).toBe(200);
    expect(JSON.parse(text).got).toBe(A_REAL_PHOTO.length);
  });

  it('still guards every other route', async () => {
    const { status } = await postLarge(withExemption, '/api/other');
    expect(status).toBe(413);
  });
});
