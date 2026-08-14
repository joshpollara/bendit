// Three gram fields for an entry with no food behind it — a quick add, or a
// photographed item that matched nothing. Blank stays blank: an unfilled field
// is unknown, and the day's totals count it as unknown rather than as zero.

export const MACROS = ['protein', 'carbs', 'fat'] as const;
export type Macro = (typeof MACROS)[number];
export type MacroFields = Record<Macro, string>;

export const EMPTY_MACROS: MacroFields = { protein: '', carbs: '', fat: '' };

/** What was typed, in grams — or null for blank and anything unusable. */
export function macroGrams(value: string): number | null {
  const grams = Number(value);
  if (value.trim() === '' || !Number.isFinite(grams) || grams < 0) return null;
  return Math.round(grams * 10) / 10;
}

/** The stored grams back as field text, for editing what was logged. */
export function macroFields(entry: {
  proteinCached?: number | null;
  carbsCached?: number | null;
  fatCached?: number | null;
}): MacroFields {
  const text = (g: number | null | undefined) => (g == null ? '' : String(g));
  return {
    protein: text(entry.proteinCached),
    carbs: text(entry.carbsCached),
    fat: text(entry.fatCached),
  };
}

export default function MacroInputs({
  values,
  onChange,
}: {
  values: MacroFields;
  onChange: (values: MacroFields) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {MACROS.map((macro) => (
        <label key={macro} className="flex flex-col items-center gap-1">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder="—"
            value={values[macro]}
            onChange={(e) => onChange({ ...values, [macro]: e.target.value })}
            className="w-full rounded-xl border border-line bg-card py-2 text-center text-sm tabular-nums"
            aria-label={`${macro} in grams`}
          />
          <span className="text-[11px] capitalize text-ink-muted">{macro} g</span>
        </label>
      ))}
    </div>
  );
}
