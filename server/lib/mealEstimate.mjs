// Turning photographed meal evidence into traceable nutrition.
//
// The visual parser supplies identities and portion ranges. Nutrition for every
// matched food comes from the database and is calculated here. A separate
// whole-meal estimate is used only by the reconciler: it can cover unresolved
// foods or preparation that the item path likely missed, and it widens the
// range when the two paths disagree.

import { nutritionForGrams } from './foodSchema.mjs';
import { matchCandidates } from './foodSearch.mjs';

export const PORTION_ERROR = { high: 0.15, medium: 0.25, low: 0.4 };

const MAX_ITEMS = 20;
const MAX_ITEM_GRAMS = 5_000;
const MAX_HIDDEN_GRAMS = 500;
const MAX_MEAL_KCAL = 10_000;
const MEAL_TYPES = new Set([
  'simple_plate',
  'mixed_dish',
  'packaged',
  'restaurant',
  'drink',
  'other',
  'not_food',
]);
const PREPARATIONS = new Set([
  'raw',
  'boiled',
  'steamed',
  'baked',
  'fried',
  'sauteed',
  'grilled',
  'roasted',
  'mixed',
  'unknown',
]);
const COOKED_WORDS = /\b(cooked|boiled|steamed|baked|fried|sauteed|grilled|roasted|broiled|poached)\b/i;

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

function normalizeProbabilities(candidates, fallbackName) {
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .slice(0, 3)
    .map((candidate) => ({
      name: shortText(candidate?.name, 120),
      probability: clamp(finite(candidate?.probability) ?? 0, 0, 1),
      visualEvidence: shortText(candidate?.visualEvidence, 240) ?? '',
    }))
    .filter((candidate) => candidate.name);

  if (normalized.length === 0) {
    return fallbackName ? [{ name: fallbackName, probability: 1, visualEvidence: '' }] : [];
  }
  const total = sum(normalized.map((candidate) => candidate.probability));
  if (total <= 0) {
    return normalized.map((candidate, index) => ({
      ...candidate,
      probability: index === 0 ? 1 : 0,
    }));
  }
  return normalized.map((candidate) => ({
    ...candidate,
    probability: round(candidate.probability / total, 4),
  }));
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
      let legacyError = null;
      let tier = confidenceTier(item?.confidence?.portion ?? item?.confidence);
      if (!portionG) {
        const grams = finite(item?.grams);
        if (!(grams > 0)) return null;
        const median = clamp(grams, 0, MAX_ITEM_GRAMS);
        legacyError = PORTION_ERROR[tier];
        portionG = {
          low: median * (1 - legacyError),
          median,
          high: median * (1 + legacyError),
        };
      } else {
        tier = confidenceTier(item?.confidence?.portion, tier);
      }

      const query = shortText(item?.query, 120) ?? name;
      const alternate = shortText(item?.alternate, 120);
      const preparation = PREPARATIONS.has(item?.preparation) ? item.preparation : 'unknown';
      return {
        id: shortText(item?.id, 64) ?? `item_${index + 1}`,
        name,
        query,
        alternate,
        identityCandidates: normalizeProbabilities(item?.identityCandidates, query),
        preparation,
        portionG,
        confidence: {
          identity: clamp(finite(item?.confidence?.identity) ?? (tier === 'low' ? 0.35 : 0.75), 0, 1),
          portion: clamp(finite(item?.confidence?.portion) ?? (tier === 'high' ? 0.85 : tier === 'low' ? 0.3 : 0.6), 0, 1),
          preparation: clamp(finite(item?.confidence?.preparation) ?? 0.5, 0, 1),
        },
        confidenceTier: tier,
        legacyError,
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

function stateContradicts(food, item, term) {
  const row = String(food?.name ?? '');
  const requested = `${term ?? ''} ${item.preparation ?? ''}`;
  const wantsRaw = /\braw\b/i.test(requested);
  const wantsCooked = COOKED_WORDS.test(requested);
  const rowRaw = /\braw\b/i.test(row);
  const rowCooked = COOKED_WORDS.test(row);
  return (wantsRaw && rowCooked && !rowRaw) || (wantsCooked && rowRaw && !rowCooked);
}

function resolveFood(db, item, ownerId) {
  const terms = [
    item.query,
    ...item.identityCandidates.map((candidate) => candidate.name),
    item.name,
    item.alternate,
  ]
    .map((term) => shortText(term, 120))
    .filter(Boolean);
  const seen = new Set();

  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const options = ownerId === undefined ? {} : { ownerId };
    const candidates = matchCandidates(db, term, { ...options, limit: 5 });
    const food = candidates.find((candidate) => !stateContradicts(candidate, item, term));
    if (food) return { food, term };
  }
  return null;
}

function publicFood(food, servings) {
  return {
    id: food.id,
    name: food.name,
    brand: food.brand ?? null,
    source: food.source,
    kcal100: food.kcal100,
    servingLabel: food.servingLabel,
    servingGrams: food.servingGrams ?? null,
    servings: servings.all(food.id),
  };
}

function publicNutrition(nutrition) {
  return {
    calories: round(nutrition.calories),
    protein: round(nutrition.protein, 1),
    carbs: round(nutrition.carbs, 1),
    fat: round(nutrition.fat, 1),
  };
}

function hiddenRiskCalories(db, item, ownerId) {
  let high = 0;
  const priced = [];
  for (const risk of item.hiddenIngredientRisks) {
    const synthetic = {
      ...item,
      query: risk.ingredient,
      name: risk.ingredient,
      alternate: null,
      identityCandidates: [],
      preparation: 'unknown',
    };
    const resolved = resolveFood(db, synthetic, ownerId);
    const kcal100 = resolved?.food?.kcal100;
    const possibleHigh = kcal100 == null ? 0 : (kcal100 * risk.quantityG.high) / 100;
    high += possibleHigh;
    priced.push({ ...risk, possibleKcalHigh: round(possibleHigh) });
  }
  return { high, risks: priced };
}

/** Match items to food records and perform all per-100g arithmetic. */
export function estimateMeal(db, evidenceOrItems = [], { ownerId } = {}) {
  const evidence = normalizeMealEvidence(evidenceOrItems);
  const servingsFor = db.prepare(
    'SELECT label, grams FROM food_servings WHERE foodId = ? ORDER BY isDefault DESC, grams',
  );

  const items = evidence.items.map((item) => {
    const resolved = resolveFood(db, item, ownerId);
    const grams = item.portionG.median;
    const base = {
      id: item.id,
      kind: 'food',
      name: item.name,
      grams: round(grams),
      portionG: {
        low: round(item.portionG.low),
        median: round(grams),
        high: round(item.portionG.high),
      },
      confidence: item.confidenceTier,
      hiddenIngredientRisks: item.hiddenIngredientRisks,
      uncertainties: item.uncertainties,
    };

    if (!resolved) {
      return {
        ...base,
        food: null,
        nutrition: null,
        range: null,
        error: PORTION_ERROR[item.confidenceTier],
      };
    }

    const { food, term } = resolved;
    const nutrition = publicNutrition(nutritionForGrams(food, grams));
    const lowNutrition = nutritionForGrams(food, item.portionG.low);
    const highNutrition = nutritionForGrams(food, item.portionG.high);
    const hidden = hiddenRiskCalories(db, item, ownerId);
    const error = item.legacyError ??
      (grams > 0 ? Math.max(0, item.portionG.high - item.portionG.low) / (2 * grams) : 0);
    const range = item.legacyError
      ? {
          low: round((nutrition.calories ?? 0) * (1 - item.legacyError)),
          high: round((nutrition.calories ?? 0) * (1 + item.legacyError) + hidden.high),
        }
      : {
          low: round(lowNutrition.calories ?? 0),
          high: round((highNutrition.calories ?? 0) + hidden.high),
        };

    return {
      ...base,
      food: publicFood(food, servingsFor),
      servings: round(food.servingGrams ? grams / food.servingGrams : grams / 100, 3),
      nutrition,
      range,
      error: round(error, 3),
      match: {
        query: term,
        coverage: round(food.coverage, 3),
        score: round(food.score, 3),
        stateMatched: true,
      },
      hiddenIngredientRisks: hidden.risks,
    };
  });

  const found = items.filter((item) => item.nutrition);
  const total = {
    calories: round(sum(found.map((item) => item.nutrition.calories))),
    protein: round(sum(found.map((item) => item.nutrition.protein)), 1),
    carbs: round(sum(found.map((item) => item.nutrition.carbs)), 1),
    fat: round(sum(found.map((item) => item.nutrition.fat)), 1),
    low: round(sum(found.map((item) => item.range?.low))),
    high: round(sum(found.map((item) => item.range?.high))),
  };
  const unmatched = items.filter((item) => !item.food).length;
  const hiddenCount = items.reduce((count, item) => count + item.hiddenIngredientRisks.length, 0);
  const uncertaintyReasons = [...evidence.uncertainties];
  if (unmatched > 0) uncertaintyReasons.push(`${unmatched} visible item${unmatched === 1 ? '' : 's'} had no reliable food-record match.`);
  if (hiddenCount > 0) uncertaintyReasons.push('Cooking fat, dressing, or other hidden ingredients may change the total.');
  if (items.some((item) => item.portionG.high > item.portionG.low)) {
    uncertaintyReasons.push('Portions are inferred from a single photograph.');
  }

  return {
    items,
    total,
    unmatched,
    evidence,
    mealType: evidence.mealType,
    captureQuality: evidence.captureQuality,
    uncertaintyReasons: uniqueStrings(uncertaintyReasons, 8),
    matchQuality: {
      matchedItems: found.length,
      totalItems: items.length,
      matchedFraction: items.length ? found.length / items.length : 0,
      hiddenRiskCount: hiddenCount,
    },
  };
}

export function normalizeHolisticEstimate(value) {
  if (!value || typeof value !== 'object') return null;
  const energyKcal = orderedRange(value.energyKcal, { max: MAX_MEAL_KCAL });
  if (!energyKcal) return null;
  const macro = (name) => orderedRange(value.macrosG?.[name], { max: 1_000 });
  return {
    mealType: MEAL_TYPES.has(value.mealType) ? value.mealType : 'other',
    energyKcal,
    macrosG: {
      protein: macro('protein'),
      carbs: macro('carbs'),
      fat: macro('fat'),
      fiber: macro('fiber'),
    },
    hiddenIngredientRisks: (Array.isArray(value.hiddenIngredientRisks)
      ? value.hiddenIngredientRisks
      : []
    ).slice(0, 6),
    uncertaintyReasons: uniqueStrings(value.uncertaintyReasons, 8),
  };
}

function totalsFor(items) {
  const priced = items.filter((item) => item.nutrition);
  return {
    calories: round(sum(priced.map((item) => item.nutrition.calories))),
    protein: round(sum(priced.map((item) => item.nutrition.protein)), 1),
    carbs: round(sum(priced.map((item) => item.nutrition.carbs)), 1),
    fat: round(sum(priced.map((item) => item.nutrition.fat)), 1),
    low: round(sum(priced.map((item) => item.range?.low))),
    high: round(sum(priced.map((item) => item.range?.high))),
  };
}

function directItem(item, calories, range, macros = {}) {
  const median = Math.max(0, round(calories) ?? 0);
  const low = Math.min(median, Math.max(0, round(range?.low) ?? median));
  const high = Math.max(median, round(range?.high) ?? median);
  return {
    ...item,
    kind: item?.kind ?? 'food',
    grams: item?.grams ?? 0,
    confidence: 'low',
    food: null,
    servings: 1,
    nutrition: {
      calories: median,
      protein: round(macros.protein, 1),
      carbs: round(macros.carbs, 1),
      fat: round(macros.fat, 1),
    },
    range: {
      low,
      high,
    },
    error: median > 0 ? round((high - low) / (2 * median), 3) : 1,
  };
}

function allocateResidual(items, residual, holistic) {
  if (!(residual > 0)) return items;
  const current = totalsFor(items);
  const residualMacros = {
    protein: Math.max(0, (holistic.macrosG.protein?.median ?? current.protein) - current.protein),
    carbs: Math.max(0, (holistic.macrosG.carbs?.median ?? current.carbs) - current.carbs),
    fat: Math.max(0, (holistic.macrosG.fat?.median ?? current.fat) - current.fat),
  };
  const unresolved = items.filter((item) => !item.nutrition);
  if (unresolved.length === 0) {
    return [
      ...items,
      directItem(
        {
          id: 'holistic_adjustment',
          kind: 'adjustment',
          name: 'Preparation and unlisted ingredients',
          grams: 0,
        },
        residual,
        { low: 0, high: Math.max(residual, holistic.energyKcal.high - totalsFor(items).calories) },
        residualMacros,
      ),
    ];
  }

  const weightTotal = sum(unresolved.map((item) => Math.max(1, item.grams)));
  let allocated = 0;
  return items.map((item) => {
    if (item.nutrition) return item;
    const isLast = unresolved[unresolved.length - 1].id === item.id;
    const share = isLast
      ? residual - allocated
      : round((residual * Math.max(1, item.grams)) / weightTotal);
    allocated += share;
    const fraction = residual > 0 ? share / residual : 0;
    return directItem(
      item,
      share,
      {
        low: holistic.energyKcal.low * fraction,
        high: holistic.energyKcal.high * fraction,
      },
      {
        protein: residualMacros.protein * fraction,
        carbs: residualMacros.carbs * fraction,
        fat: residualMacros.fat * fraction,
      },
    );
  });
}

function fitRangeEnvelope(items, low, high) {
  let next = items.map((item) => ({
    ...item,
    range: item.range ? { ...item.range } : item.range,
  }));
  const indices = next
    .map((item, index) => (item.nutrition && item.range ? index : null))
    .filter((index) => index != null);
  if (indices.length === 0) return next;

  const point = sum(indices.map((index) => next[index].nutrition.calories));
  const targetLow = clamp(round(low) ?? point, 0, point);
  const targetHigh = Math.max(point, round(high) ?? point);

  // Preserve where the uncertainty came from: rows with wider visual ranges
  // receive more of the meal envelope. A lower bound cannot go below zero, so
  // capped rows are removed and the remainder is redistributed.
  const lowerGap = point - targetLow;
  const lower = new Map(indices.map((index) => [index, 0]));
  let remaining = lowerGap;
  let active = [...indices];
  while (remaining > 1e-6 && active.length) {
    const weights = active.map((index) =>
      Math.max(1, next[index].nutrition.calories - next[index].range.low),
    );
    const weightTotal = sum(weights);
    let distributed = 0;
    const before = remaining;
    for (let position = 0; position < active.length; position++) {
      const index = active[position];
      const capacity = next[index].nutrition.calories - lower.get(index);
      const amount = Math.min(capacity, (before * weights[position]) / weightTotal);
      lower.set(index, lower.get(index) + amount);
      distributed += amount;
    }
    remaining -= distributed;
    active = active.filter(
      (index) => next[index].nutrition.calories - lower.get(index) > 1e-6,
    );
    if (distributed <= 1e-6) break;
  }

  const upperGap = targetHigh - point;
  const upperWeights = indices.map((index) =>
    Math.max(1, next[index].range.high - next[index].nutrition.calories),
  );
  const upperWeightTotal = sum(upperWeights);
  for (let position = 0; position < indices.length; position++) {
    const index = indices[position];
    const median = next[index].nutrition.calories;
    next[index].range = {
      low: round(median - lower.get(index)),
      high: round(median + (upperGap * upperWeights[position]) / upperWeightTotal),
    };
  }

  // Remove integer-rounding drift while retaining low <= median <= high.
  const correct = (key, target) => {
    let delta = target - sum(indices.map((index) => next[index].range[key]));
    for (const index of indices) {
      if (delta === 0) break;
      const median = next[index].nutrition.calories;
      const current = next[index].range[key];
      const minimum = key === 'low' ? 0 : median;
      const maximum = key === 'low' ? median : Number.MAX_SAFE_INTEGER;
      const change = clamp(delta, minimum - current, maximum - current);
      next[index].range[key] += change;
      delta -= change;
    }
  };
  correct('low', targetLow);
  correct('high', targetHigh);
  return next;
}

/** Choose no more than one portion question using deterministic calorie sensitivity. */
export function selectPortionQuestion(estimate, { minimumKcal = 80, minimumFraction = 0.15 } = {}) {
  const threshold = Math.max(minimumKcal, (estimate?.total?.calories ?? 0) * minimumFraction);
  const candidates = (estimate?.items ?? [])
    .filter((item) => item.food?.kcal100 != null && item.portionG?.high > item.portionG?.low)
    .map((item) => ({
      item,
      sensitivity: (item.food.kcal100 * (item.portionG.high - item.portionG.low)) / 100,
    }))
    .filter((candidate) => candidate.sensitivity >= threshold)
    .sort((a, b) => b.sensitivity - a.sensitivity);
  const best = candidates[0];
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
    question: `Which amount of ${best.item.food?.name ?? best.item.name} was closest?`,
    choices,
    expectedReductionKcal: round(best.sensitivity),
  };
}

/**
 * Reconcile the independent database and whole-meal paths without blind
 * averaging. Reliable item arithmetic remains the point estimate. A material
 * positive holistic residual is used only when unresolved or hidden-food risk
 * makes undercounting plausible; all disagreement still expands the range.
 */
export function reconcileMealEstimates(databaseResult, holisticValue, options = {}) {
  const holistic = normalizeHolisticEstimate(holisticValue);
  const database = databaseResult ?? {
    items: [],
    total: { calories: 0, protein: 0, carbs: 0, fat: 0, low: 0, high: 0 },
    unmatched: 0,
    evidence: normalizeMealEvidence([]),
    matchQuality: { matchedItems: 0, totalItems: 0, hiddenRiskCount: 0 },
    uncertaintyReasons: [],
  };
  const evidence = options.evidence ?? database.evidence ?? normalizeMealEvidence([]);
  const dbPath = {
    calories: database.total.calories,
    low: database.total.low,
    high: database.total.high,
    matchedItems: database.matchQuality?.matchedItems ?? database.items.filter((item) => item.food).length,
    totalItems: database.matchQuality?.totalItems ?? database.items.length,
  };

  if (evidence.mealType === 'not_food') {
    return {
      ...database,
      status: evidence.captureQuality?.needsRetake ? 'retake' : 'ready',
      question: null,
      path: { selected: 'database', database: dbPath, holistic: null, disagreementKcal: null },
    };
  }

  let items = uniqueItemIds(database.items.map((item) => ({ ...item })));
  let selected = holistic ? 'hybrid' : 'database';
  const disagreement = holistic
    ? Math.abs(holistic.energyKcal.median - database.total.calories)
    : null;
  const materialDifference = holistic
    ? holistic.energyKcal.median - database.total.calories >=
      Math.max(40, database.total.calories * 0.1)
    : false;
  const undercountRisk =
    database.unmatched > 0 ||
    (database.matchQuality?.hiddenRiskCount ?? 0) > 0 ||
    ['mixed_dish', 'restaurant'].includes(evidence.mealType);

  if (holistic && database.total.calories === 0 && holistic.energyKcal.median > 0) {
    const seed = database.items[0] ?? {
      id: 'holistic_meal',
      kind: 'adjustment',
      name: 'Meal from photo',
      grams: 0,
    };
    items = [
      directItem(seed, holistic.energyKcal.median, holistic.energyKcal, {
        protein: holistic.macrosG.protein?.median,
        carbs: holistic.macrosG.carbs?.median,
        fat: holistic.macrosG.fat?.median,
      }),
    ];
    selected = 'holistic';
  } else if (holistic && undercountRisk && materialDifference) {
    items = allocateResidual(items, holistic.energyKcal.median - database.total.calories, holistic);
  }
  // The holistic residual uses a stable synthetic id. A parser-provided id may
  // have the same text, so enforce the invariant again after the paths merge.
  items = uniqueItemIds(items);

  let total = totalsFor(items);
  if (holistic) {
    // Use the two independent path envelopes, not the ranges after a residual
    // row was added. Adding that row first and then taking its range would count
    // the same uncertainty twice.
    const hasDatabaseEstimate = database.total.calories > 0;
    const envelopeLow = hasDatabaseEstimate
      ? Math.min(database.total.low, holistic.energyKcal.low, total.calories)
      : Math.min(holistic.energyKcal.low, total.calories);
    const envelopeHigh = hasDatabaseEstimate
      ? Math.max(database.total.high, holistic.energyKcal.high, total.calories)
      : Math.max(holistic.energyKcal.high, total.calories);
    items = fitRangeEnvelope(items, envelopeLow, envelopeHigh);
    total = totalsFor(items);
  }

  const uncertaintyReasons = uniqueStrings([
    ...(database.uncertaintyReasons ?? []),
    ...(holistic?.uncertaintyReasons ?? []),
  ]);
  if (disagreement != null && disagreement >= Math.max(80, total.calories * 0.15)) {
    uncertaintyReasons.unshift(`The food-record and whole-meal estimates differ by about ${round(disagreement)} kcal.`);
  }

  const provisional = {
    ...database,
    items,
    total,
    mealType: evidence.mealType,
    captureQuality: evidence.captureQuality,
    uncertaintyReasons: uniqueStrings(uncertaintyReasons, 8),
    path: {
      selected,
      database: dbPath,
      holistic: holistic
        ? {
            calories: round(holistic.energyKcal.median),
            low: round(holistic.energyKcal.low),
            high: round(holistic.energyKcal.high),
          }
        : null,
      disagreementKcal: round(disagreement),
    },
  };
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
