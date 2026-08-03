// POST /api/meals/estimate — a photograph of a plate becomes a draft meal.
//
// The model reads the photo; the database supplies every number. Kept beside
// the label route and built the same way, on top of the vision handler, so
// quota, logging and typed errors are shared rather than reimplemented.

import { estimateMeal } from './mealEstimate.mjs';

export function createMealEstimateHandler({ db, visionHandler }) {
  return async function mealEstimateHandler(req, res) {
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

    await visionHandler({ ...req, body: { ...req.body, task: 'meal' } }, proxyRes);

    if (captured.statusCode !== 200 || !captured.body?.data) {
      return res.status(captured.statusCode).json(captured.body ?? { error: { code: 'unknown' } });
    }

    const items = Array.isArray(captured.body.data.items) ? captured.body.data.items : [];
    if (items.length === 0) {
      return res.status(422).json({
        error: {
          code: 'no_food_found',
          message: "No food was recognised in that photo. Try again with the plate filling the frame.",
        },
      });
    }

    return res.json({ ...estimateMeal(db, items), meta: captured.body.meta });
  };
}
