// How a recipe could grade better.
//
// A recipe's Nutri-Score, where it comes from its ingredients, is their grades
// averaged by weight (see gradeMeal). So what lifts it is plain arithmetic:
// less of the worst-graded ingredients, or more of something graded A. Each
// tip here is one of those, worked out against the same average, so the grade
// it promises is the grade the changed recipe gets.

import { gradeMeal } from './nutriScore.mjs';

/** Under this share of a recipe's weight graded, its grade would say little. */
export const MIN_GRADED = 0.5;

const VALUE = { A: 1, B: 2, C: 3, D: 4, E: 5 };
const MAX_TIPS = 4;
/**
 * Only lines graded this or worse are worth changing: leaving out the chicken
 * and the rice would lift most dinners to an A, and isn't advice.
 */
const CHANGEABLE = VALUE.C;
/** Leaving out more than this share of a recipe by weight makes it another dish. */
const MOST_LEFT_OUT = 0.4;
/** Vegetables are added in steps of this, for the whole recipe. */
const VEG_STEP = 50;

/** The grade of these lines, by weight, or null when too little of it is graded. */
export function gradeLines(lines) {
  const graded = gradeMeal(lines.filter((l) => l.grams > 0).map((l) => ({ grams: l.grams, grade: l.grade })));
  return graded && graded.covered >= MIN_GRADED ? graded.grade : null;
}

const better = (to, from) => to != null && from != null && VALUE[to] < VALUE[from];

const apply = (lines, changes) =>
  lines.map((line, index) => {
    const change = changes.find((c) => c.index === index);
    if (!change) return line;
    return { ...line, grams: change.kind === 'leave_out' ? 0 : line.grams / 2 };
  });

/**
 * Grams of an A-graded food to add to reach `target`: the average by weight
 * rounds to the target once it's under half a grade above it.
 */
function vegToReach(lines, target) {
  const graded = lines.filter((l) => l.grams > 0 && VALUE[l.grade]);
  const weight = graded.reduce((sum, l) => sum + l.grams, 0);
  const points = graded.reduce((sum, l) => sum + VALUE[l.grade] * l.grams, 0);
  const limit = VALUE[target] + 0.49;
  if (limit <= VALUE.A) return null;
  const grams = Math.ceil((points - limit * weight) / (limit - VALUE.A) / VEG_STEP) * VEG_STEP;
  return grams > 0 ? grams : null;
}

/**
 * Up to four ways to a better grade, best first. `lines` are the ingredients
 * in order, each { grams, grade }. Each tip names what to change and the grade
 * after it:
 *
 *   { kind: 'leave_out' | 'halve', index, to }
 *   { kind: 'add_veg', grams, to }  — grams for the whole recipe
 *   { kind: 'together', changes: [{ kind, index }], to }
 */
export function recipeTips(lines) {
  const now = gradeLines(lines);
  if (!now || now === 'A') return [];
  const total = lines.reduce((sum, l) => sum + (l.grams > 0 ? l.grams : 0), 0);

  // Each change to one line that lifts the grade. Halving is the smaller ask,
  // so leaving a line out is only offered when it does better than halving it.
  const singles = [];
  lines.forEach((line, index) => {
    if (!(line.grams > 0) || !(VALUE[line.grade] >= CHANGEABLE) || VALUE[line.grade] <= VALUE[now]) return;
    const halved = gradeLines(apply(lines, [{ kind: 'halve', index }]));
    const gone = gradeLines(apply(lines, [{ kind: 'leave_out', index }]));
    if (better(halved, now)) singles.push({ kind: 'halve', index, to: halved, grams: line.grams / 2 });
    if (better(gone, now) && (!better(halved, now) || better(gone, halved))) {
      singles.push({ kind: 'leave_out', index, to: gone, grams: line.grams });
    }
  });
  singles.sort((a, b) => VALUE[a.to] - VALUE[b.to] || a.grams - b.grams);

  const tips = singles.map(({ kind, index, to }) => ({ kind, index, to }));

  // When no one change reaches A, the fewest changes that do, worst line first.
  if (!tips.some((t) => t.to === 'A')) {
    const worst = lines
      .map((line, index) => ({ ...line, index }))
      .filter((l) => l.grams > 0 && VALUE[l.grade] >= CHANGEABLE)
      .sort((a, b) => (VALUE[b.grade] - 1) * b.grams - (VALUE[a.grade] - 1) * a.grams);
    const changes = [];
    let grade = now;
    let left = 0;
    for (const line of worst.slice(0, 3)) {
      left += line.grams;
      if (left > MOST_LEFT_OUT * total) break;
      changes.push({ kind: 'leave_out', index: line.index });
      grade = gradeLines(apply(lines, changes));
      if (grade === 'A') break;
    }
    if (changes.length > 1 && grade === 'A') tips.push({ kind: 'together', changes, to: 'A' });
  }

  // More vegetables, when a sensible amount gets a grade better: no more than
  // the recipe weighs now.
  const target = Object.keys(VALUE)[VALUE[now] - 2];
  const veg = vegToReach(lines, target);
  if (veg && veg <= total) tips.push({ kind: 'add_veg', grams: veg, to: target });

  return tips.slice(0, MAX_TIPS);
}
