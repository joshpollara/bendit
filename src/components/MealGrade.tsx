// The Nutri-Score grade for a meal, and how processed it was.
//
// Two published standards rather than a score of our own: the A–E grade is the
// European front-of-pack algorithm, and 1–4 is the NOVA processing
// classification. Both can be looked up and argued with.

const GRADE_STYLE: Record<string, string> = {
  A: 'bg-good text-white',
  B: 'bg-good-soft text-good',
  C: 'bg-warn-soft text-warn-deep',
  D: 'bg-over-soft text-over',
  E: 'bg-over text-white',
};

export type MealGradeData = {
  grade?: string | null;
  /** 0–1: how much of the meal's weight could be graded at all. */
  covered?: number;
  processing?: { worst: number; ultraShare: number } | null;
};

export default function MealGrade({ data }: { data?: MealGradeData | null }) {
  if (!data?.grade && !data?.processing) return null;

  const thin = (data.covered ?? 1) < 0.5;
  const ultra = (data.processing?.ultraShare ?? 0) >= 0.3;

  return (
    <span className="flex items-center gap-1">
      {data.grade && (
        <span
          title={
            thin
              ? `Nutri-Score ${data.grade}, from ${Math.round((data.covered ?? 0) * 100)}% of this meal`
              : `Nutri-Score ${data.grade}`
          }
          className={`flex h-5 w-5 items-center justify-center rounded text-[11px] font-bold ${
            GRADE_STYLE[data.grade] ?? ''
          } ${thin ? 'opacity-50' : ''}`}
        >
          {data.grade}
        </span>
      )}
      {ultra && (
        <span
          title={`${Math.round((data.processing?.ultraShare ?? 0) * 100)}% of this meal was ultra-processed`}
          className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary"
        >
          UPF
        </span>
      )}
    </span>
  );
}
