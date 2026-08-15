#!/usr/bin/env node
// Runs sample photos through the real endpoints and prints what came back,
// what it cost, and — where a photo has a known answer — how wrong it was.
//
//   node server/tools/photocheck.mjs photos/*.jpg
//   node server/tools/photocheck.mjs --base https://bendit.fly.dev --task meal plate.jpg
//   node server/tools/photocheck.mjs --repeat 3 --out before.json photos/*.jpg
//
// The password comes from BENDIT_PASSWORD (or BASIC_AUTH_PASSWORD when run on
// the server itself). Nothing here talks to a model directly — it goes through
// the app, so what you are eyeballing is the whole path: read, validate, match,
// price.
//
// Which task a photo gets is inferred from its name — anything containing
// "label" or "panel" is read as a label, everything else as a meal — and
// --task overrides that.
//
// Scoring
// -------
// Eyeballing a few plates tells you nothing about whether a change to the
// prompt or the model helped: portion estimation is noisy enough that any two
// runs differ, and a change that helps one photo commonly hurts another. So a
// meal photo can carry a known answer, and the scores at the end are the only
// way to answer "did that help?".
//
// Answers live in a manifest beside the photos — server/photos/expected.json by
// default, --expected elsewhere — keyed by filename:
//
//   {
//     "chicken-rice.jpg": {
//       "kcal": 640,
//       "items": ["chicken", "rice", "broccoli"],
//       "portions": { "chicken": 160, "rice": 220, "broccoli": 90 }
//     },
//     "porridge.jpg": { "kcal": 310, "items": ["oat", "milk"] }
//   }
//
// kcal is what the meal actually was — weighed, or added up from the packets.
// items are substrings that should appear in what came back, which catches the
// case where the calories are right by luck and the foods are wrong. A photo
// with no entry is still run and shown; it just isn't scored.
//
// --repeat N runs each photo N times. Since the same photo asked twice can give
// different weights, the spread is itself a stability measurement. Repetition
// is an evaluation option, not a production averaging strategy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jpegSize } from '../lib/jpeg.mjs';
import { MODEL_PRICES } from '../lib/visionUsage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Prices come from the same table the app bills itself with, so a comparison
// between two models is costed the same way the running app would cost them.

/** The size the client sends. The evaluator warns when it is not testing that path. */
const CLIENT_MAX_EDGE = 1536;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const base = arg('base', 'http://localhost:8080').replace(/\/$/, '');
const forcedTask = arg('task');
const repeat = Math.max(1, Number(arg('repeat', '1')) || 1);
const outPath = arg('out');
const expectedPath = arg('expected', path.join(here, '..', 'photos', 'expected.json'));
const password = process.env.BENDIT_PASSWORD ?? process.env.BASIC_AUTH_PASSWORD;

const files = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));

/** The known answers, if anyone has written any down. Absent is not an error. */
const expected = fs.existsSync(expectedPath)
  ? JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
  : {};

if (files.length === 0) {
  process.stderr.write('usage: photocheck.mjs [--base URL] [--task label|meal] <photo>...\n');
  process.exit(1);
}

const taskFor = (file) =>
  forcedTask ?? (/label|panel|packet/i.test(path.basename(file)) ? 'label' : 'meal');

const money = (n) => `$${n.toFixed(5)}`;

/** What a call cost, or null when this server has no rate for that model —
 *  which is worth saying out loud rather than reporting as free. */
function costOf(model, usage) {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  return ((usage?.inputTokens ?? 0) * price.input + (usage?.outputTokens ?? 0) * price.output) / 1e6;
}

/** Cost every role at its own model rate. Older servers expose one top-level call. */
function costForMeta(meta = {}) {
  const calls = Array.isArray(meta.calls) && meta.calls.length
    ? meta.calls
    : [{ role: null, model: meta.model, promptVersion: meta.promptVersion, usage: meta.usage }];
  let cost = 0;
  let priced = 0;
  const missing = [];
  for (const call of calls) {
    const value = costOf(call.model, call.usage);
    if (value == null) missing.push(call.model ?? '?');
    else {
      cost += value;
      priced++;
    }
  }
  return { calls, cost: priced ? cost : null, missing };
}

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

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** The middle of several noisy reads — the figure to judge a run by, not the mean,
 *  which one wild portion drags around. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/**
 * How many of the foods that should have been found, were. Matched on the
 * database name and on the model's own words, because either one appearing is
 * evidence the food was seen — a right food matched to a wrong row is a
 * different failure, and the calories catch that one.
 */
function foodsFound(body, wanted = []) {
  if (!wanted.length) return null;
  const seen = (body.items ?? [])
    .flatMap((item) => [item.name, item.food?.name])
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
  return wanted.filter((term) => seen.includes(String(term).toLowerCase())).length;
}

function portionErrors(body, expectedPortions = {}) {
  const errors = [];
  for (const [term, expectedGrams] of Object.entries(expectedPortions)) {
    if (!(Number(expectedGrams) > 0)) continue;
    const match = (body.items ?? []).find((item) =>
      [item.name, item.food?.name]
        .filter(Boolean)
        .some((name) => String(name).toLowerCase().includes(term.toLowerCase())),
    );
    if (Number.isFinite(match?.grams)) errors.push(Math.abs(match.grams - Number(expectedGrams)));
  }
  return errors;
}

/** One call to one endpoint. Throws on anything that isn't a usable answer. */
async function readPhoto(task, buffer) {
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
    throw new Error(`${response.status}, and the reply wasn't JSON`);
  }
  if (!response.ok) throw new Error(`${response.status} ${body.error?.code} — ${body.error?.message}`);
  return { body, elapsed };
}

let spend = 0;
let calls = 0;
let failures = 0;
const scored = [];
const models = new Set();
/** Models this server has no rate for. Named at the end rather than counted as free. */
const unpriced = new Set();

for (const file of files) {
  const task = taskFor(file);
  const buffer = fs.readFileSync(file);
  const size = jpegSize(buffer);
  const oversized = size && Math.max(size.width, size.height) > CLIENT_MAX_EDGE;
  const answer = expected[path.basename(file)];

  process.stdout.write(
    `\n${path.basename(file)}  [${task}]  ${(buffer.length / 1024).toFixed(0)}KB` +
      `${size ? ` ${size.width}×${size.height}` : ''}` +
      `${answer?.kcal ? `  expected ${answer.kcal} cal` : ''}` +
      `${oversized ? `  (larger than the ${CLIENT_MAX_EDGE}px the app sends — this will cost more than a real scan)` : ''}\n`,
  );

  const runs = [];
  for (let attempt = 1; attempt <= repeat; attempt++) {
    let result;
    try {
      result = await readPhoto(task, buffer);
    } catch (error) {
      failures++;
      process.stdout.write(`  FAILED: ${error.message}\n`);
      continue;
    }

    const { body, elapsed } = result;
    calls++;
    const pricedMeta = costForMeta(body.meta);
    for (const call of pricedMeta.calls) {
      models.add(
        `${call.role ? `${call.role}:` : ''}${call.model ?? '?'} (prompt v${call.promptVersion ?? '?'})`,
      );
    }

    // The first read is shown in full; the rest only need their bottom line,
    // which is the number the spread is measured on.
    if (attempt === 1) {
      if (task === 'label') showLabel(body);
      else showMeal(body);
    } else if (task === 'meal') {
      process.stdout.write(`  run ${attempt}: ${body.total?.calories} cal\n`);
    }

    const { cost } = pricedMeta;
    for (const model of pricedMeta.missing) unpriced.add(model);
    if (cost != null) spend += cost;
    if (attempt === 1 || task === 'label') {
      const usage = body.meta?.usage;
      process.stdout.write(
        `  ${elapsed}ms · ${usage?.inputTokens ?? '?'} in + ${usage?.outputTokens ?? '?'} out` +
          ` · ${cost == null ? 'no priced model call' : money(cost)}` +
          `${pricedMeta.missing.length ? ' plus unpriced call' : ''}` +
          ` · ${pricedMeta.calls.map((call) => `${call.role ? `${call.role}:` : ''}${call.model ?? '?'}`).join(', ')}\n`,
      );
    }

    runs.push({
      calories: body.total?.calories ?? null,
      low: body.total?.low ?? null,
      high: body.total?.high ?? null,
      found: foodsFound(body, answer?.items),
      portionErrors: portionErrors(body, answer?.portions),
      unmatched: body.unmatched ?? 0,
      cost,
      elapsed,
    });
  }

  // Only meals are scored: a label is a transcription, right or wrong, and its
  // own validator already says which.
  if (task !== 'meal' || !answer?.kcal || runs.length === 0) continue;

  const totals = runs.map((r) => r.calories).filter((c) => typeof c === 'number');
  if (totals.length === 0) continue;

  const got = median(totals);
  const errorKcal = got - answer.kcal;
  const errorPct = ((got - answer.kcal) / answer.kcal) * 100;
  const spreadPct = totals.length > 1 ? ((Math.max(...totals) - Math.min(...totals)) / got) * 100 : null;
  const recall = answer.items?.length ? mean(runs.map((r) => r.found ?? 0)) / answer.items.length : null;
  const lows = runs.map((run) => run.low).filter(Number.isFinite);
  const highs = runs.map((run) => run.high).filter(Number.isFinite);
  const intervalLow = median(lows);
  const intervalHigh = median(highs);
  const intervalCovered = intervalLow == null || intervalHigh == null
    ? null
    : intervalLow <= answer.kcal && answer.kcal <= intervalHigh;
  const portionErrorValues = runs.flatMap((run) => run.portionErrors);

  scored.push({
    file: path.basename(file),
    expected: answer.kcal,
    got,
    errorKcal,
    errorPct,
    spreadPct,
    recall,
    intervalLow,
    intervalHigh,
    intervalCovered,
    portionErrors: portionErrorValues,
    unmatched: mean(runs.map((r) => r.unmatched)),
  });

  process.stdout.write(
    `  SCORE: ${got} vs ${answer.kcal} cal → ${errorPct >= 0 ? '+' : ''}${errorPct.toFixed(0)}%` +
      `${intervalCovered == null ? '' : `, interval ${intervalLow}–${intervalHigh} ${intervalCovered ? 'covers' : 'misses'}`}` +
      `${spreadPct == null ? '' : `, spread ${spreadPct.toFixed(0)}% across ${totals.length} reads`}` +
      `${recall == null ? '' : `, foods ${(recall * 100).toFixed(0)}%`}` +
      `${portionErrorValues.length ? `, portion MAE ${mean(portionErrorValues).toFixed(0)}g` : ''}\n`,
  );
}

const priced = calls && spend > 0;
process.stdout.write(
  `\n${calls} call${calls === 1 ? '' : 's'}, ${failures} failed. Spent ${money(spend)}` +
    `${priced ? `, ${money(spend / calls)} each` : ''}.\n` +
    `At that rate: ${priced ? `${Math.round(1 / (spend / calls))} scans per dollar` : '—'}.\n` +
    `${unpriced.size ? `No rate in MODEL_PRICES for ${[...unpriced].join(', ')} — that spend isn't counted above.\n` : ''}`,
);

let summary = null;
if (scored.length) {
  const errors = scored.map((s) => s.errorPct);
  const absolute = errors.map(Math.abs);
  const errorsKcal = scored.map((s) => s.errorKcal);
  const absoluteKcal = errorsKcal.map(Math.abs);
  const withinBand = scored.filter((s) => Math.abs(s.errorPct) <= 20).length;
  const within50Kcal = scored.filter((s) => Math.abs(s.errorKcal) <= 50).length;
  const within100Kcal = scored.filter((s) => Math.abs(s.errorKcal) <= 100).length;
  const recalls = scored.map((s) => s.recall).filter((r) => r != null);
  const spreads = scored.map((s) => s.spreadPct).filter((s) => s != null);
  const intervals = scored.filter((s) => s.intervalCovered != null);
  const intervalWidths = intervals.map((s) => s.intervalHigh - s.intervalLow);
  const portions = scored.flatMap((s) => s.portionErrors);

  summary = {
    photos: scored.length,
    calorieMae: mean(absoluteKcal),
    medianAbsErrorKcal: median(absoluteKcal),
    p90AbsErrorKcal: quantile(absoluteKcal, 0.9),
    biasKcal: mean(errorsKcal),
    medianAbsErrorPct: median(absolute),
    meanAbsErrorPct: mean(absolute),
    // Signed, and kept separate on purpose: an estimator that is 20% out at
    // random needs a steadier read, one that is 20% low every time needs the
    // prompt or the portion figures changed.
    biasPct: mean(errors),
    withinBand,
    within50Kcal,
    within100Kcal,
    foodRecallPct: recalls.length ? mean(recalls) * 100 : null,
    portionMaeG: portions.length ? mean(portions) : null,
    intervalCoveragePct: intervals.length
      ? (intervals.filter((s) => s.intervalCovered).length / intervals.length) * 100
      : null,
    meanIntervalWidthKcal: intervalWidths.length ? mean(intervalWidths) : null,
    meanSpreadPct: spreads.length ? mean(spreads) : null,
  };

  process.stdout.write(
    `\nScored ${summary.photos} meal${summary.photos === 1 ? '' : 's'} against known answers:\n` +
      `  calorie MAE    ${summary.calorieMae.toFixed(0)} kcal  (median ${summary.medianAbsErrorKcal.toFixed(0)}, P90 ${summary.p90AbsErrorKcal.toFixed(0)})\n` +
      `  calorie bias   ${summary.biasKcal >= 0 ? '+' : ''}${summary.biasKcal.toFixed(0)} kcal\n` +
      `  median error   ${summary.medianAbsErrorPct.toFixed(0)}%  (mean ${summary.meanAbsErrorPct.toFixed(0)}%)\n` +
      `  bias           ${summary.biasPct >= 0 ? '+' : ''}${summary.biasPct.toFixed(0)}%  ` +
      `(${summary.biasPct < 0 ? 'reads low' : 'reads high'} on average)\n` +
      `  within ±20%    ${summary.withinBand}/${summary.photos}\n` +
      `  within 50/100  ${summary.within50Kcal}/${summary.photos}, ${summary.within100Kcal}/${summary.photos}\n` +
      `${summary.intervalCoveragePct == null ? '' : `  interval cover ${summary.intervalCoveragePct.toFixed(0)}%  (mean width ${summary.meanIntervalWidthKcal.toFixed(0)} kcal)\n`}` +
      `${summary.foodRecallPct == null ? '' : `  foods found    ${summary.foodRecallPct.toFixed(0)}%\n`}` +
      `${summary.portionMaeG == null ? '' : `  portion MAE    ${summary.portionMaeG.toFixed(0)}g\n`}` +
      `${summary.meanSpreadPct == null ? '' : `  read-to-read   ${summary.meanSpreadPct.toFixed(0)}% spread over ${repeat} reads\n`}` +
      `  read by        ${[...models].join(', ')}\n`,
  );
} else if (Object.keys(expected).length === 0) {
  process.stdout.write(
    `\nNothing was scored: no known answers at ${expectedPath}.\n` +
      `Write down what a few of these meals actually were and the numbers above become comparable between runs.\n`,
  );
}

if (outPath) {
  fs.writeFileSync(
    outPath,
    `${JSON.stringify({ at: new Date().toISOString(), base, repeat, models: [...models], summary, photos: scored }, null, 2)}\n`,
  );
  process.stdout.write(`\nWritten to ${outPath}. Run again after a change and compare.\n`);
}
