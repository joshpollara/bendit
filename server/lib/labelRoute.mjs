// Reading a nutrition panel, and checking what was read.
//
// Two ways in, one way out. A photo goes to the model; numbers already read
// on-device by OCR come in as fields. Both are validated and normalised by the
// same code, so an offline scan is held to exactly the standard an online one
// is — the arithmetic check is the safeguard against a misread digit, and it
// would be worth little if half the readings skipped it.

import { normalizeLabel } from './labelNormalize.mjs';
import { validateLabel } from './labelValidate.mjs';

/**
 * Validates and normalises one reading, whatever produced it.
 * `source` is recorded so the client can say where the numbers came from.
 */
export function assessLabel(label, { source, barcode = null, meta = null } = {}) {
  const validation = validateLabel(label);
  const food = normalizeLabel(label, { barcode });

  return {
    source,
    label,
    food,
    issues: validation.issues,
    ok: validation.ok && food != null,
    // The model's own confidence, downgraded when the arithmetic disagrees with
    // it. A confident wrong answer is the failure worth guarding against.
    confidence: gradeConfidence(label.confidence, validation, food),
    meta,
  };
}

/**
 * Three tiers, meaning three different things to a person:
 *   high   — the numbers agree with each other; glance and save.
 *   medium — readable, but something is missing or unverifiable.
 *   low    — check every field against the packet.
 */
function gradeConfidence(stated, validation, food) {
  if (!food || validation.issues.some((i) => i.severity === 'error')) return 'low';
  if (validation.issues.length > 0) return 'low';
  if (stated === 'low') return 'low';
  if (stated === 'medium') return 'medium';
  // Claimed high, but nothing cross-checked it: the calories-versus-macros
  // identity needs all three macros, and a column missing one proves nothing.
  return validation.checkedColumns.length === 0 ? 'medium' : 'high';
}

/** POST /api/labels/extract — a photo, read by the model, then checked. */
export function createLabelExtractHandler({ visionHandler }) {
  return async function labelExtractHandler(req, res) {
    // Reuse the vision route wholesale: quota, logging, typed errors and all.
    // Its response is intercepted here rather than reimplemented.
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

    await visionHandler({ ...req, body: { ...req.body, task: 'label' } }, proxyRes);

    if (captured.statusCode !== 200 || !captured.body?.data) {
      return res.status(captured.statusCode).json(captured.body ?? { error: { code: 'unknown' } });
    }

    return res.json(
      assessLabel(captured.body.data, {
        source: 'vision',
        barcode: req.body?.barcode ?? null,
        meta: captured.body.meta,
      }),
    );
  };
}

/**
 * POST /api/labels/validate — numbers read on the device, checked by the same
 * rules. No model call, so no quota and no cost.
 */
export function createLabelValidateHandler() {
  return function labelValidateHandler(req, res) {
    const { label, barcode = null } = req.body ?? {};
    if (!label || typeof label !== 'object') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'No label was sent.' } });
    }
    return res.json(assessLabel(label, { source: req.body.source ?? 'ocr', barcode }));
  };
}
