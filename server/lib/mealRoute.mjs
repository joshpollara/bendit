// POST /api/meals/estimate - one photograph, one model call, one estimate.
//
// This ran two calls until the food-database lookup was removed: a parser that
// named the foods for lookup, and an independent whole-meal estimate held
// against it by a reconciler. With the model giving its own numbers there is
// nothing left to reconcile, and the second call is gone. It was also the
// unreliable half — throttled or timed out on 53 of its last 62 attempts, which
// meant the "checked" estimate was usually just the lookup on its own.

import { estimateMeal } from './mealEstimate.mjs';
import { createMealPhotoRunStore } from './mealFeedback.mjs';
import { normalizeHint } from './visionTasks.mjs';

export function createMealEstimateHandler({ db, visionHandler }) {
  const runs = createMealPhotoRunStore(db);
  return async function mealEstimateHandler(req, res) {
    const hint = normalizeHint(req.body?.hint);
    const estimateId = runs.start(req.userId, {
      hint,
      // A second reading of the same photograph is a new run that knows which
      // one it followed. Nothing of the photo is reused here — the client still
      // sends the image, because the server never kept it.
      previousRunId: runs.priorRun(req.userId, req.body?.previousEstimateId),
    });
    try {
      const captured = { statusCode: 200, body: null };
      const proxyRes = {
        status(code) {
          captured.statusCode = code;
          return proxyRes;
        },
        json(payload) {
          captured.body = payload;
          return proxyRes;
        },
      };
      let requestId = null;

      await visionHandler(
        {
          ...req,
          mealPhotoRunId: estimateId,
          captureVisionRequestId: (id) => {
            requestId = id;
          },
          body: { ...req.body, task: 'meal' },
        },
        proxyRes,
      );

      if (captured.statusCode !== 200 || !captured.body?.data) {
        if (requestId) {
          runs.failed(estimateId, { parserRequestId: requestId });
        } else {
          // A request rejected before the provider reservation (for example at
          // the daily limit) must not let repeated retries fill the run table.
          runs.discard(estimateId);
        }
        return res
          .status(captured.statusCode)
          .json(captured.body ?? { error: { code: 'unknown', message: 'The meal could not be read.' } });
      }

      // An empty list is an answer, not a failure: the model looked and found
      // nothing it could name. It comes back as a meal with no items rather than
      // an error, because the alternative was a dead end — a banner, and a
      // photograph that had already been paid for thrown away.
      const estimate = estimateMeal(captured.body.data);
      runs.ready(estimateId, { parserRequestId: requestId, estimate });

      return res.json({
        ...estimate,
        estimateId,
        // Echoed so the review screen can show what the estimate was told, and
        // so a client that sent a description too long or unusable can see what
        // actually reached the model.
        hint,
        meta: captured.body.meta,
      });
    } catch (error) {
      runs.failed(estimateId);
      throw error;
    }
  };
}
