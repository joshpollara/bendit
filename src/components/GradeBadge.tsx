import type { NutriGrade } from '../lib/api';
import { GRADE_STYLE } from './MealGrade';

/** A small Nutri-Score letter, in the grade's colour. */
export default function GradeBadge({ grade, className = '' }: { grade: NutriGrade | null | undefined; className?: string }) {
  if (!grade) return null;
  return (
    <span
      title={`Nutri-Score ${grade}`}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded align-[-2px] text-[10px] font-bold ${GRADE_STYLE[grade]} ${className}`}
    >
      {grade}
    </span>
  );
}
