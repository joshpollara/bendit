// Turning a photographed meal into numbers.
//
// The model that reads the photograph also supplies the nutrition. It used to
// supply only a name and a weight, and each name was looked up in the food
// database — which sounds more rigorous than it is. A database match is exact
// about the wrong thing: a bowl from a restaurant matched a supermarket packet
// with a similar name and was then priced to the calorie from that packet's
// label, with no trace on screen that a substitution had happened. Roughly half
// of the meals logged that way were corrected by hand first, and the correction
// was usually the food itself rather than the amount.
//
// An estimate that says 420 kcal and means it, with a range around it, is worth
// more than a number that is precise about a food nobody ate. So nothing here
// consults the database. A person can still attach a real food record by hand
// on the review screen, and then the numbers are that record's — chosen, not
// guessed on their behalf.
//
// What remains here is validation. Structured output constrains the shape of
// what comes back; it cannot make the values finite, ordered, or plausible.

export const PORTION_ERROR = { high: 0.15, medium: 0.25, low: 0.4 };

const MAX_ITEMS = 20;
const MAX_ITEM_GRAMS = 5_000;
const MAX_ITEM_KCAL = 10_000;
const MAX_ITEM_MACRO_G = 1_000;
const MAX_HIDDEN_GRAMS = 500;
const MEAL_TYPES = new Set([
  'simple_plate',
  'mixed_dish',
  'packaged',
  'restaurant',
  'drink',
  'other',
  'not_food',
]);

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const round = (value, dp = 0) => {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
};

const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);

const shortText = (value, max = 180) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
};

const uniqueStrings = (values, limit = 8) =>
  [...new Set((values ?? []).map((value) => shortText(value)).filter(Boolean))].slice(0, limit);

function orderedRange(value, { max, requirePositive = false } = {}) {
  const values = [finite(value?.low), finite(value?.median), finite(value?.high)];
  if (values.some((part) => part == null)) return null;
  const ceiling = max ?? Number.MAX_SAFE_INTEGER;
  const sorted = values.map((part) => clamp(part, 0, ceiling)).sort((a, b) => a - b);
  if (requirePositive && sorted[1] <= 0) return null;
  return { low: sorted[0], median: sorted[1], high: sorted[2] };
}

function confidenceTier(value, fallback = 'medium') {
  if (typeof value === 'string' && PORTION_ERROR[value]) return value;
  const number = finite(value);
  if (number == null) return fallback;
  if (number >= 0.75) return 'high';
  if (number >= 0.4) return 'medium';
  return 'low';
}

function normalizeCaptureQuality(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    blurProbability: clamp(finite(value.blurProbability) ?? 0, 0, 1),
    glareProbability: clamp(finite(value.glareProbability) ?? 0, 0, 1),
    occlusionProbability: clamp(finite(value.occlusionProbability) ?? 0, 0, 1),
    underexposureProbability: clamp(finite(value.underexposureProbability) ?? 0, 0, 1),
    fullMealVisible: value.fullMealVisible !== false,
    needsRetake: value.needsRetake === true,
    retakeReason: shortText(value.retakeReason, 240),
  };
}

function normalizeScaleEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  const dimension = finite(value.knownDimensionMm);
  const available = value.available === true && dimension > 0;
  return {
    available,
    source: available ? shortText(value.source, 120) : null,
    knownDimensionMm: available ? clamp(dimension, 1, 10_000) : null,
    confidence: clamp(finite(value.confidence) ?? 0, 0, 1),
  };
}

function normalizeHiddenRisks(risks) {
  return (Array.isArray(risks) ? risks : [])
    .slice(0, 6)
    .map((risk) => {
      const ingredient = shortText(risk?.ingredient, 80);
      const rawLow = finite(risk?.quantityG?.low);
      const rawHigh = finite(risk?.quantityG?.high);
      if (!ingredient || rawLow == null || rawHigh == null) return null;
      const [low, high] = [rawLow, rawHigh]
        .map((value) => clamp(value, 0, MAX_HIDDEN_GRAMS))
        .sort((a, b) => a - b);
      return {
        ingredient,
        likelihood: clamp(finite(risk?.likelihood) ?? 0.5, 0, 1),
        quantityG: { low, high },
        evidence: shortText(risk?.evidence, 240) ?? '',
      };
    })
    .filter(Boolean);
}

function uniqueItemIds(items) {
  const used = new Set();
  return items.map((item, index) => {
    const root = shortText(item?.id, 64) ?? `item_${index + 1}`;
    let id = root;
    for (let copy = 2; used.has(id); copy++) {
      const suffix = `_${copy}`;
      id = `${root.slice(0, 64 - suffix.length)}${suffix}`;
    }
    used.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

/**
 * The energy the model gave an item, or a band derived from its confidence.
 *
 * A missing or nonsensical figure is not filled in from anywhere else — there
 * is nowhere else. The item comes back without nutrition and the review screen
 * offers a box to type it into, which is what it already did for a food the
 * database could not place.
 */
function normalizeEnergy(item, tier) {
  const energy = orderedRange(item?.energyKcal, { max: MAX_ITEM_KCAL, requirePositive: true });
  if (!energy) return null;
  // A model that returns the same number three times has reported a weighed
  // meal. Nothing about a photograph justifies that, so the confidence it
  // stated for the portion sets the band instead.
  if (energy.low === energy.high) {
    const error = PORTION_ERROR[tier];
    return {
      low: energy.median * (1 - error),
      median: energy.median,
      high: energy.median * (1 + error),
    };
  }
  return energy;
}

function normalizeMacros(value) {
  const macro = (name) => {
    const grams = finite(value?.[name]);
    return grams == null ? null : clamp(grams, 0, MAX_ITEM_MACRO_G);
  };
  return { protein: macro('protein'), carbs: macro('carbs'), fat: macro('fat') };
}

/**
 * Semantic validation for model output. Structured JSON constrains its shape,
 * but it cannot guarantee finite, ordered, plausible values.
 */
export function normalizeMealEvidence(evidenceOrItems = {}) {
  const raw = Array.isArray(evidenceOrItems) ? { items: evidenceOrItems } : evidenceOrItems ?? {};
  const items = uniqueItemIds((Array.isArray(raw.items) ? raw.items : [])
    .slice(0, MAX_ITEMS)
    .map((item, index) => {
      const name = shortText(item?.name, 120);
      if (!name) return null;

      let portionG = orderedRange(item?.portionG, {
        max: MAX_ITEM_GRAMS,
        requirePositive: true,
      });
      let tier = confidenceTier(item?.confidence?.portion ?? item?.confidence);
      if (!portionG) {
        const grams = finite(item?.grams);
        if (!(grams > 0)) return null;
        const median = clamp(grams, 0, MAX_ITEM_GRAMS);
        const error = PORTION_ERROR[tier];
        portionG = {
          low: median * (1 - error),
          median,
          high: median * (1 + error),
        };
      } else {
        tier = confidenceTier(item?.confidence?.portion, tier);
      }

      return {
        id: shortText(item?.id, 64) ?? `item_${index + 1}`,
        name,
        portionG,
        energyKcal: normalizeEnergy(item, tier),
        macrosG: normalizeMacros(item?.macrosG),
        confidence: {
          identity: clamp(finite(item?.confidence?.identity) ?? (tier === 'low' ? 0.35 : 0.75), 0, 1),
          portion: clamp(finite(item?.confidence?.portion) ?? (tier === 'high' ? 0.85 : tier === 'low' ? 0.3 : 0.6), 0, 1),
        },
        confidenceTier: tier,
        hiddenIngredientRisks: normalizeHiddenRisks(item?.hiddenIngredientRisks),
        uncertainties: uniqueStrings(item?.uncertainties, 5),
      };
    })
    .filter(Boolean));

  const mealType = MEAL_TYPES.has(raw.mealType) ? raw.mealType : items.length ? 'other' : 'not_food';
  return {
    captureQuality: normalizeCaptureQuality(raw.captureQuality),
    mealType,
    scaleEvidence: normalizeScaleEvidence(raw.scaleEvidence),
    items,
    uncertainties: uniqueStrings(raw.uncertainties, 8),
  };
}

/**
 * Chooses at most one portion question: the item where the amount is worth
 * asking about, because its energy range is the widest part of the meal's.
 * Answering it is the cheapest correction available — no second model call,
 * no search — so it is offered before anything else on the screen.
 */
export function selectPortionQuestion(estimate, { minimumKcal = 80, minimumFraction = 0.15 } = {}) {
  const threshold = Math.max(minimumKcal, (estimate?.total?.calories ?? 0) * minimumFraction);
  const best = (estimate?.items ?? [])
    .filter(
      (item) =>
        item.nutrition &&
        item.range &&
        item.portionG?.high > item.portionG?.low &&
        item.grams > 0,
    )
    .map((item) => ({ item, sensitivity: item.range.high - item.range.low }))
    .filter((candidate) => candidate.sensitivity >= threshold)
    .sort((a, b) => b.sensitivity - a.sensitivity)[0];
  if (!best) return null;

  const amounts = [
    ['low', 'Small', best.item.portionG.low],
    ['median', 'Medium', best.item.portionG.median],
    ['high', 'Large', best.item.portionG.high],
  ];
  const seen = new Set();
  const choices = amounts
    .map(([id, label, grams]) => ({ id, label, grams: Math.max(1, round(grams)) }))
    .filter((choice) => {
      if (seen.has(choice.grams)) return false;
      seen.add(choice.grams);
      return true;
    })
    .map((choice) => ({ ...choice, label: `${choice.label} (${choice.grams} g)` }));
  if (choices.length < 2) return null;

  return {
    id: `portion:${best.item.id}`,
    targetItemId: best.item.id,
    question: `Which amount of ${best.item.name} was closest?`,
    choices,
    expectedReductionKcal: round(best.sensitivity),
  };
}

/**
 * The meal as the model estimated it: one row per food, each carrying its own
 * energy, macros and range, and no food record behind any of them.
 */
export function estimateMeal(evidenceOrItems = []) {
  const evidence = normalizeMealEvidence(evidenceOrItems);

  const items = evidence.items.map((item) => {
    const grams = round(item.portionG.median);
    const base = {
      id: item.id,
      kind: 'food',
      name: item.name,
      grams,
      portionG: {
        low: round(item.portionG.low),
        median: grams,
        high: round(item.portionG.high),
      },
      confidence: item.confidenceTier,
      // The food a person attaches by hand goes here. Nothing fills it in on
      // their behalf.
      food: null,
      hiddenIngredientRisks: item.hiddenIngredientRisks,
      uncertainties: item.uncertainties,
    };

    if (!item.energyKcal) {
      return { ...base, nutrition: null, range: null, error: PORTION_ERROR[item.confidenceTier] };
    }

    const calories = round(item.energyKcal.median);
    return {
      ...base,
      nutrition: {
        calories,
        protein: round(item.macrosG.protein, 1),
        carbs: round(item.macrosG.carbs, 1),
        fat: round(item.macrosG.fat, 1),
      },
      range: { low: round(item.energyKcal.low), high: round(item.energyKcal.high) },
      // Half the width of the range, as a fraction of the estimate. The screen
      // uses it to tell an estimated row from one someone has since corrected.
      error:
        calories > 0
          ? round((item.energyKcal.high - item.energyKcal.low) / (2 * calories), 3)
          : PORTION_ERROR[item.confidenceTier],
    };
  });

  const priced = items.filter((item) => item.nutrition);
  const total = {
    calories: round(sum(priced.map((item) => item.nutrition.calories))),
    protein: round(sum(priced.map((item) => item.nutrition.protein)), 1),
    carbs: round(sum(priced.map((item) => item.nutrition.carbs)), 1),
    fat: round(sum(priced.map((item) => item.nutrition.fat)), 1),
    // A plate is one photograph: overestimating one portion tends to come with
    // overestimating the next, so the bands are added rather than combined in
    // quadrature. The wider, more honest reading.
    low: round(sum(priced.map((item) => item.range.low))),
    high: round(sum(priced.map((item) => item.range.high))),
  };

  const unpriced = items.length - priced.length;
  const hiddenCount = items.reduce((count, item) => count + item.hiddenIngredientRisks.length, 0);
  const uncertaintyReasons = [...evidence.uncertainties];
  if (unpriced > 0) {
    uncertaintyReasons.push(
      `${unpriced} visible item${unpriced === 1 ? ' has' : 's have'} no estimate; add the calories to include ${unpriced === 1 ? 'it' : 'them'}.`,
    );
  }
  if (hiddenCount > 0) {
    uncertaintyReasons.push('Cooking fat, dressing, or other hidden ingredients may change the total.');
  }
  if (items.some((item) => item.portionG.high > item.portionG.low)) {
    uncertaintyReasons.push('Portions are inferred from a single photograph.');
  }

  const provisional = {
    items,
    total,
    /** Rows the model named but could not put a number on. */
    unpriced,
    evidence,
    mealType: evidence.mealType,
    captureQuality: evidence.captureQuality,
    uncertaintyReasons: uniqueStrings(uncertaintyReasons, 8),
  };

  if (evidence.mealType === 'not_food') {
    return {
      ...provisional,
      question: null,
      status: evidence.captureQuality?.needsRetake ? 'retake' : 'ready',
    };
  }

  const question = selectPortionQuestion(provisional);
  return {
    ...provisional,
    question,
    status: evidence.captureQuality?.needsRetake
      ? 'retake'
      : question
        ? 'needs_question'
        : 'ready',
  };
}
