#!/usr/bin/env node
// Runs sample photos through the real endpoints and prints what came back and
// what it cost.
//
//   node server/tools/photocheck.mjs photos/*.jpg
//   node server/tools/photocheck.mjs --base https://bendit.fly.dev --task meal plate.jpg
//
// The password comes from BENDIT_PASSWORD (or BASIC_AUTH_PASSWORD when run on
// the server itself). Nothing here talks to a model directly — it goes through
// the app, so what you are eyeballing is the whole path: read, validate, match,
// price.
//
// Which task a photo gets is inferred from its name — anything containing
// "label" or "panel" is read as a label, everything else as a meal — and
// --task overrides that.

import fs from 'node:fs';
import path from 'node:path';
import { jpegSize } from '../lib/jpeg.mjs';

// Per million tokens, for the default model. Update alongside DEFAULT_MODEL.
const PRICE = { input: 0.25, output: 1.5 };

/** The size the client sends. A bigger photo costs more for no more accuracy. */
const CLIENT_MAX_EDGE = 768;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const base = arg('base', 'http://localhost:8080').replace(/\/$/, '');
const forcedTask = arg('task');
const password = process.env.BENDIT_PASSWORD ?? process.env.BASIC_AUTH_PASSWORD;

const files = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));

if (files.length === 0) {
  process.stderr.write('usage: photocheck.mjs [--base URL] [--task label|meal] <photo>...\n');
  process.exit(1);
}

const taskFor = (file) =>
  forcedTask ?? (/label|panel|packet/i.test(path.basename(file)) ? 'label' : 'meal');

const money = (n) => `$${n.toFixed(5)}`;

const costOf = (usage) =>
  ((usage?.inputTokens ?? 0) * PRICE.input) / 1e6 + ((usage?.outputTokens ?? 0) * PRICE.output) / 1e6;

function showLabel(body) {
  const column = body.label?.per100 ?? body.label?.perServing ?? {};
  const which = body.label?.per100 ? 'per 100' : 'per serving';
  process.stdout.write(
    `  ${body.label?.brand ? `${body.label.brand} · ` : ''}${body.label?.name ?? '(no name read)'}\n`,
  );
  process.stdout.write(
    `  ${which}: ${['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar']
      .filter((k) => column[k] != null)
      .map((k) => `${k} ${column[k]}`)
      .join(', ')}\n`,
  );
  if (body.food) {
    process.stdout.write(
      `  -> ${Math.round(body.food.kcal100)} kcal/100${body.food.basis}, servings: ${body.food.servings
        .map((s) => s.label)
        .join(', ')}\n`,
    );
  }
  process.stdout.write(`  confidence: ${body.confidence}\n`);
  for (const issue of body.issues ?? []) {
    process.stdout.write(`  ${issue.severity === 'error' ? '!!' : '! '} ${issue.field}: ${issue.message}\n`);
  }
}

function showMeal(body) {
  for (const item of body.items) {
    const matched = item.food
      ? `${item.food.name.slice(0, 40)} (${Math.round(item.food.kcal100)}/100g, ${item.food.source})`
      : 'NO MATCH';
    process.stdout.write(
      `  ${String(item.grams).padStart(4)}g  ${item.name.slice(0, 26).padEnd(28)} [${item.confidence.padEnd(6)}] -> ${matched.padEnd(52)} ${item.nutrition ? `${item.nutrition.calories} cal` : ''}\n`,
    );
  }
  const t = body.total;
  process.stdout.write(
    `  total: ${t.calories} cal (${t.low}–${t.high})  P${t.protein} C${t.carbs} F${t.fat}` +
      `${body.unmatched ? `  — ${body.unmatched} unmatched` : ''}\n`,
  );
}

let spend = 0;
let calls = 0;
let failures = 0;

for (const file of files) {
  const task = taskFor(file);
  const buffer = fs.readFileSync(file);
  const size = jpegSize(buffer);
  const oversized = size && Math.max(size.width, size.height) > CLIENT_MAX_EDGE;

  process.stdout.write(
    `\n${path.basename(file)}  [${task}]  ${(buffer.length / 1024).toFixed(0)}KB` +
      `${size ? ` ${size.width}×${size.height}` : ''}` +
      `${oversized ? `  (larger than the ${CLIENT_MAX_EDGE}px the app sends — this will cost more than a real scan)` : ''}\n`,
  );

  const started = Date.now();
  const response = await fetch(`${base}/api/${task === 'label' ? 'labels/extract' : 'meals/estimate'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(password ? { authorization: `Bearer ${password}` } : {}),
    },
    body: JSON.stringify({ image: buffer.toString('base64'), mimeType: 'image/jpeg' }),
  });
  const elapsed = Date.now() - started;

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    failures++;
    process.stdout.write(`  FAILED: ${response.status}, and the reply wasn't JSON\n`);
    continue;
  }

  if (!response.ok) {
    failures++;
    process.stdout.write(`  FAILED: ${response.status} ${body.error?.code} — ${body.error?.message}\n`);
    continue;
  }

  calls++;
  if (task === 'label') showLabel(body);
  else showMeal(body);

  const usage = body.meta?.usage;
  const cost = costOf(usage);
  spend += cost;
  process.stdout.write(
    `  ${elapsed}ms · ${usage?.inputTokens ?? '?'} in + ${usage?.outputTokens ?? '?'} out · ${money(cost)}` +
      ` · ${body.meta?.model ?? '?'} (prompt v${body.meta?.promptVersion ?? '?'})\n`,
  );
}

process.stdout.write(
  `\n${calls} call${calls === 1 ? '' : 's'}, ${failures} failed. Spent ${money(spend)}` +
    `${calls ? `, ${money(spend / calls)} each` : ''}.\n` +
    `At that rate: ${calls ? `${Math.round(1 / (spend / calls))} scans per dollar` : '—'}.\n`,
);
