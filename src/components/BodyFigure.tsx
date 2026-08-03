// A simple, friendly cartoon figure whose build follows from weight and
// height. The proportions are driven by BMI, so the same person drawn at
// start, current, and goal weight visibly changes shape — which is the whole
// point. Deliberately gentle: outline style matching the app's icons, a
// constant head, no caricature.

import type { Sex } from '../types';

/** Maps BMI onto a 0..1 "build" factor. 19 draws the slimmest figure, 36+ the fullest. */
function buildFactor(weightKg: number, heightCm: number): number {
  const h = heightCm / 100;
  const bmi = weightKg / (h * h);
  return Math.max(0, Math.min(1, (bmi - 19) / (36 - 19)));
}

export default function BodyFigure({
  weightKg,
  heightCm,
  sex,
  dashed = false,
  className,
}: {
  weightKg: number;
  heightCm: number;
  sex: Sex;
  /** Outline only, dashed — used for the goal figure ("not there yet"). */
  dashed?: boolean;
  className?: string;
}) {
  const t = buildFactor(weightKg, heightCm);
  const male = sex === 'male';

  // All coordinates in a 120×170 box, figure centred on x = 60.
  const neckHalf = 5 + 2 * t;
  const shoulderHalf = 17 + 7 * t + (male ? 3 : 0);
  const waistHalf = 12 + 20 * t;
  const bulge = waistHalf + 8 * t; // curve control: the belly rounds outward
  const hipHalf = 13 + 15 * t + (male ? 0 : 4);
  const crotchHalf = Math.max(4, hipHalf * 0.3);

  const shoulderY = 46;
  const waistY = 78;
  const hipY = 102;
  const crotchY = 112;

  const legStroke = 7 + 6 * t;
  const armStroke = 6 + 5 * t;
  const legX = crotchHalf + legStroke / 2 + 1;
  // Arms hang outside the torso at any build — clear of the belly curve.
  const armEndX = Math.max(shoulderHalf + 6, bulge + armStroke / 2 + 3);
  const armStartY = shoulderY + 3;

  const torso = [
    `M ${60 - neckHalf} 37`,
    `C ${60 - neckHalf - 4} 42, ${60 - shoulderHalf + 4} 42, ${60 - shoulderHalf} ${shoulderY}`,
    `C ${60 - bulge} ${(shoulderY + waistY) / 2 + 6}, ${60 - bulge} ${waistY}, ${60 - hipHalf} ${hipY}`,
    `C ${60 - hipHalf + 2} ${crotchY}, ${60 - crotchHalf} ${crotchY}, 60 ${crotchY}`,
    `C ${60 + crotchHalf} ${crotchY}, ${60 + hipHalf - 2} ${crotchY}, ${60 + hipHalf} ${hipY}`,
    `C ${60 + bulge} ${waistY}, ${60 + bulge} ${(shoulderY + waistY) / 2 + 6}, ${60 + shoulderHalf} ${shoulderY}`,
    `C ${60 + shoulderHalf - 4} 42, ${60 + neckHalf + 4} 42, ${60 + neckHalf} 37`,
  ].join(' ');

  return (
    <svg
      viewBox="0 0 120 170"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={dashed ? '5 5' : undefined}
      aria-hidden="true"
    >
      <circle cx="60" cy="23" r="13" />
      <path d={torso} />
      {/* arms */}
      <path d={`M ${60 - shoulderHalf + 2} ${armStartY} L ${60 - armEndX} 92`} strokeWidth={armStroke} />
      <path d={`M ${60 + shoulderHalf - 2} ${armStartY} L ${60 + armEndX} 92`} strokeWidth={armStroke} />
      {/* legs */}
      <path d={`M ${60 - legX} ${crotchY - 2} L ${60 - legX - 3} 152`} strokeWidth={legStroke} />
      <path d={`M ${60 + legX} ${crotchY - 2} L ${60 + legX + 3} 152`} strokeWidth={legStroke} />
      {/* feet */}
      <path d={`M ${60 - legX - 3} 156 l -7 0`} strokeWidth="4" />
      <path d={`M ${60 + legX + 3} 156 l 7 0`} strokeWidth="4" />
    </svg>
  );
}
