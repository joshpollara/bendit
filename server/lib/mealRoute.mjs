// POST /api/meals/estimate - two independent model paths reconciled in code.

import { estimateMeal, reconcileMealEstimates } from './mealEstimate.mjs';
import { createMealPhotoRunStore } from './mealFeedback.mjs';

function proxyResponse() {
  const captured = { statusCode: 200, body: null };
  const res = {
    status(code) {
      captured.statusCode = code;
      return res;
    },
    json(payload) {
      captured.body = payload;
      return res;
    },
  };
  return { captured, res };
}

async function runVisionTask(visionHandler, req, task, mealPhotoRunId) {
  const proxy = proxyResponse();
  let requestId = null;
  await visionHandler(
    {
      ...req,
      mealPhotoRunId,
      captureVisionRequestId: (id) => {
        requestId = id;
      },
      body: { ...req.body, task },
    },
    proxy.res,
  );
  return { ...proxy.captured, requestId };
}

const succeeded = (result) => result.statusCode === 200 && result.body?.data;

function aggregateMeta(parser, holistic) {
  const calls = [
    succeeded(parser) ? { role: 'parser', ...parser.body.meta } : null,
    succeeded(holistic) ? { role: 'holistic', ...holistic.body.meta } : null,
  ].filter(Boolean);
  const numeric = (pick, combine) => {
    const values = calls.map(pick).filter((value) => typeof value === 'number');
    return values.length ? combine(values) : null;
  };
  const sum = (values) => values.reduce((total, value) => total + value, 0);

  return {
    // Kept for clients built against the original one-model response.
    model: calls[0]?.model ?? calls[1]?.model ?? 'unavailable',
    promptVersion: calls.map((call) => `${call.role}:${call.promptVersion}`).join(','),
    latencyMs: numeric((call) => call.latencyMs, (values) => Math.max(...values)),
    usage: {
      inputTokens: numeric((call) => call.usage?.inputTokens, sum),
      outputTokens: numeric((call) => call.usage?.outputTokens, sum),
      totalTokens: numeric((call) => call.usage?.totalTokens, sum),
    },
    callsRemainingToday: numeric(
      (call) => call.callsRemainingToday,
      (values) => Math.min(...values),
    ),
    models: Object.fromEntries(calls.map((call) => [call.role, call.model])),
    calls: calls.map((call) => ({
      role: call.role,
      model: call.model,
      promptVersion: call.promptVersion,
      latencyMs: call.latencyMs,
      usage: call.usage,
    })),
    partialFailures: [
      !succeeded(parser) ? { role: 'parser', code: parser.body?.error?.code ?? 'unknown' } : null,
      !succeeded(holistic)
        ? { role: 'holistic', code: holistic.body?.error?.code ?? 'unknown' }
        : null,
    ].filter(Boolean),
  };
}

export function createMealEstimateHandler({ db, visionHandler }) {
  const runs = createMealPhotoRunStore(db);
  return async function mealEstimateHandler(req, res) {
    const estimateId = runs.start(req.userId);
    try {
      // The calls see the same image but no output from one another. The vision
      // handler reserves quota before awaiting either provider, so this remains
      // safe when the two requests start together.
      const [parser, holistic] = await Promise.all([
        runVisionTask(visionHandler, req, 'meal', estimateId),
        runVisionTask(visionHandler, req, 'mealHolistic', estimateId),
      ]);

      if (!succeeded(parser) && !succeeded(holistic)) {
        if (parser.requestId || holistic.requestId) {
          runs.failed(estimateId, {
            parserRequestId: parser.requestId,
            holisticRequestId: holistic.requestId,
          });
        } else {
          // A request rejected before either provider reservation (for example at
          // the daily limit) must not let repeated retries fill the run table.
          runs.discard(estimateId);
        }
        const failure = parser.body?.error ? parser : holistic;
        return res
          .status(failure.statusCode)
          .json(failure.body ?? { error: { code: 'unknown', message: 'The meal could not be read.' } });
      }

      const holisticData = succeeded(holistic) ? holistic.body.data : null;
      const evidence = succeeded(parser)
        ? parser.body.data
        : { items: [], mealType: holisticData?.mealType ?? 'other', uncertainties: [] };
      const databaseEstimate = estimateMeal(db, evidence, {
        ownerId: req.userId,
      });
      const estimate = reconcileMealEstimates(databaseEstimate, holisticData, { evidence });

      if (!succeeded(parser)) {
        estimate.uncertaintyReasons = [
          'The item-by-item visual analysis was unavailable; this result uses the whole-meal fallback.',
          ...(estimate.uncertaintyReasons ?? []),
        ];
      } else if (!succeeded(holistic)) {
        estimate.uncertaintyReasons = [
          ...(estimate.uncertaintyReasons ?? []),
          'The independent whole-meal check was unavailable; the food-record estimate is shown.',
        ];
      }

      runs.ready(estimateId, {
        parserRequestId: parser.requestId,
        holisticRequestId: holistic.requestId,
        estimate,
      });
      return res.json({ ...estimate, estimateId, meta: aggregateMeta(parser, holistic) });
    } catch (error) {
      runs.failed(estimateId);
      throw error;
    }
  };
}
