import { lazy, Suspense, useRef, useState } from 'react';
import { api } from '../lib/api';
import { rescale } from '../lib/labelParse';
import { readLabel, type LabelIssue, type LabelReading, type ReadStage } from '../lib/labelRead';
import { formatCalories } from '../lib/units';
import type { Food } from '../types';
import { CameraIcon } from './Icons';

// Only loaded when the camera is actually opened.
const CameraCapture = lazy(() => import('./CameraCapture'));

// One form for creating and editing a food, including reading one off a
// photographed label.
//
// Panels in much of Europe only state values per 100 g, which is not how
// anyone eats. In "Per 100 g" mode you type the weight of a real serving and
// the saved food carries that serving's numbers — the per-100g figures are
// scratch input, never what gets stored.

type Basis = 'serving' | '100g';

const field = 'w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm';
// A field the check flagged: amber for "look at this", red for "this can't be right".
const flagged = {
  warning: 'w-full rounded-xl border-2 border-warn bg-card px-3 py-2.5 text-sm',
  error: 'w-full rounded-xl border-2 border-over bg-card px-3 py-2.5 text-sm',
};
const round1 = (v: number | null | undefined) =>
  v == null ? null : Math.round(v * 10) / 10;
const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
const str = (v: number | null | undefined) => (v == null ? '' : String(v));

export default function FoodForm({
  initial,
  prefillBarcode,
  submitLabel = 'Save Food',
  onSaved,
}: {
  initial?: Food;
  prefillBarcode?: string;
  submitLabel?: string;
  onSaved: (food: Food) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [brand, setBrand] = useState(initial?.brand ?? '');
  const [servingLabel, setServingLabel] = useState(initial?.servingLabel ?? '1 serving');
  const [servingGrams, setServingGrams] = useState(str(initial?.servingGrams));
  const [calories, setCalories] = useState(str(initial?.caloriesPerServing));
  const [protein, setProtein] = useState(str(initial?.protein));
  const [carbs, setCarbs] = useState(str(initial?.carbs));
  const [fat, setFat] = useState(str(initial?.fat));
  const [basis, setBasis] = useState<Basis>('serving');

  const [scanState, setScanState] = useState<'idle' | ReadStage>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanText, setScanText] = useState<string | null>(null);
  // What the check found, so the fields in question can be pointed at rather
  // than the user re-reading the whole packet.
  const [issues, setIssues] = useState<LabelIssue[]>([]);
  const [shooting, setShooting] = useState(false);
  // The servings a scanned label offered — the printed portion, 100 g, and the
  // whole pack. Kept so saving keeps them too, which is what lets an entry be
  // rescaled later to "half the packet".
  const [scanned, setScanned] = useState<LabelReading['food'] | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  const grams = Number(servingGrams);
  const gramsValid = Number.isFinite(grams) && grams > 0;

  // In per-100g mode the typed numbers describe 100 g; these are what actually
  // gets saved for one serving.
  const perServing = (v: string) =>
    basis === 'serving' ? num(v) : (rescale(num(v) ?? null, 100, grams) ?? undefined);

  const savedCalories = perServing(calories);
  const valid =
    name.trim() !== '' &&
    savedCalories != null &&
    Number.isFinite(savedCalories) &&
    savedCalories >= 0 &&
    (basis === 'serving' || gramsValid);

  async function scanFromPhoto(file: Blob) {
    setShooting(false);
    setScanState('sending');
    setScanError(null);
    setIssues([]);
    setScanned(null);
    try {
      const reading = await readLabel(file, { barcode: prefillBarcode, onStage: setScanState });
      setScanText(reading.text ?? null);
      setIssues(reading.issues);

      if (!reading.food) {
        setScanError(
          reading.issues[0]?.message ??
            "Couldn't find any nutrition values in that photo. Try again with the panel filling the frame, in even light — or just type them in.",
        );
        return;
      }
      setScanned(reading.food);
      fillFrom(reading);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : "Couldn't read that photo.");
    } finally {
      setScanState('idle');
    }
  }

  /**
   * Fills the form the way the packet is printed: a per-portion panel goes in
   * as per-portion, a per-100 one as per-100. The user is looking at the label
   * while they check, and matching it is what makes checking quick.
   */
  function fillFrom(reading: LabelReading) {
    const food = reading.food as unknown as Food & Record<string, number | null>;
    const printedPerServing = reading.label.perServing != null && reading.label.per100 == null;

    if (food.name && food.name !== 'Scanned food') setName(food.name);
    if (food.brand) setBrand(food.brand);
    if (food.servingGrams != null) setServingGrams(str(food.servingGrams));

    if (printedPerServing) {
      setBasis('serving');
      if (food.servingLabel) setServingLabel(food.servingLabel);
      setCalories(str(Math.round(food.caloriesPerServing)));
      setProtein(str(food.protein ?? null));
      setCarbs(str(food.carbs ?? null));
      setFat(str(food.fat ?? null));
      return;
    }

    setBasis('100g');
    if (food.servingGrams == null) setServingGrams('100');
    setCalories(str(round1(food.kcal100)));
    setProtein(str(round1(food.protein100)));
    setCarbs(str(round1(food.carbs100)));
    setFat(str(round1(food.fat100)));
  }

  async function save() {
    const label =
      basis === '100g' ? `${grams} g` : servingLabel.trim() || (gramsValid ? `${grams} g` : '1 serving');
    const food: Food = {
      id: initial?.id ?? `custom-${crypto.randomUUID()}`,
      name: name.trim(),
      brand: brand.trim() || undefined,
      barcode: initial?.barcode ?? prefillBarcode,
      servingLabel: label,
      servingGrams: gramsValid ? grams : undefined,
      caloriesPerServing: Math.round(savedCalories ?? 0),
      protein: perServing(protein),
      carbs: perServing(carbs),
      fat: perServing(fat),
      source: initial?.source ?? 'custom',
    };
    // A scanned food carries more than the form shows: the per-100 figures it
    // was read from, and the portions the packet names. They ride along so the
    // entry can be rescaled later without re-reading the label.
    const extras = scanned
      ? {
          basis: (scanned as { basis?: string }).basis,
          servings: (scanned as { servings?: unknown }).servings,
        }
      : {};
    await api.saveFoods({ ...food, ...extras } as Food);
    onSaved(food);
  }

  const per = basis === '100g' ? ' / 100g' : '';

  // Issues name their column ("per100.calories") and the form shows one column
  // at a time. Only the column on screen is highlighted: painting a field red
  // over a fault in the other column marks a number that is right there in
  // front of the user and correct, which teaches them to ignore the colour.
  // The message still appears in the list either way.
  const shownColumn = basis === '100g' ? 'per100' : 'perServing';
  const issueFor = (name: string) =>
    issues.find((i) => i.field === name || i.field === `${shownColumn}.${name}`);
  const classFor = (name: string) => {
    const issue = issueFor(name);
    return issue ? flagged[issue.severity] : field;
  };

  return (
    <div className="flex flex-col gap-3">
      {prefillBarcode && !initial && (
        <p className="rounded-xl bg-accent-soft px-3 py-2 text-xs text-accent-deep">
          Saving with barcode {prefillBarcode} — next scan will find it.
        </p>
      )}

      {shooting && (
        <Suspense fallback={null}>
          <CameraCapture
            facing="environment"
            title="Photograph the label"
            hint="Fill the frame with the nutrition panel, square on."
            onCapture={(photo) => void scanFromPhoto(photo)}
            onClose={() => setShooting(false)}
            onPickFile={() => {
              setShooting(false);
              photoInput.current?.click();
            }}
          />
        </Suspense>
      )}

      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // let the same file be picked twice
          if (file) void scanFromPhoto(file);
        }}
      />
      <button
        type="button"
        disabled={scanState !== 'idle'}
        onClick={() => setShooting(true)}
        className="flex items-center justify-center gap-2 rounded-xl border border-accent py-2.5 text-sm font-semibold text-accent disabled:opacity-60"
      >
        <CameraIcon className="h-4 w-4" />
        {scanState === 'sending'
          ? 'Reading label…'
          : scanState === 'loading'
            ? 'Preparing the reader…'
            : scanState === 'reading'
              ? 'Reading on your phone…'
              : scanState === 'checking'
                ? 'Checking the numbers…'
                : 'Scan nutrition label'}
      </button>
      <p className="-mt-1 text-center text-xs text-ink-muted">Fill the frame with the panel.</p>
      {scanError && <p className="rounded-xl bg-over-soft px-3 py-2 text-xs text-over">{scanError}</p>}
      {issues.length > 0 && (
        <ul className="flex flex-col gap-1">
          {issues.map((issue) => (
            <li
              key={`${issue.field}:${issue.message}`}
              className={`rounded-xl px-3 py-2 text-xs ${
                issue.severity === 'error' ? 'bg-over-soft text-over' : 'bg-warn-soft text-warn-deep'
              }`}
            >
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      {scanText && (
        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer">What the scan read</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-surface p-2 text-[11px]">
            {scanText}
          </pre>
        </details>
      )}

      <input className={field} placeholder="Food name" value={name} onChange={(e) => setName(e.target.value)} />
      <input
        className={field}
        placeholder="Brand (optional)"
        value={brand}
        onChange={(e) => setBrand(e.target.value)}
      />

      <div className="grid grid-cols-2 gap-2 rounded-xl bg-surface p-1 text-center text-xs font-semibold">
        {(['serving', '100g'] as Basis[]).map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setBasis(b)}
            className={`rounded-lg py-2 ${basis === b ? 'bg-accent text-white' : 'text-ink-secondary'}`}
          >
            {b === 'serving' ? 'Values per serving' : 'Values per 100 g'}
          </button>
        ))}
      </div>

      {basis === 'serving' ? (
        <div className="flex gap-3">
          <input
            className={field}
            placeholder="Serving (e.g. 1 cup)"
            value={servingLabel}
            onChange={(e) => setServingLabel(e.target.value)}
          />
          <input
            className={field}
            type="number"
            inputMode="decimal"
            placeholder="Weight (g, optional)"
            value={servingGrams}
            onChange={(e) => setServingGrams(e.target.value)}
          />
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-sm text-ink-secondary">
          One serving weighs
          <input
            className={field}
            type="number"
            inputMode="decimal"
            placeholder="grams, e.g. 30"
            value={servingGrams}
            onChange={(e) => setServingGrams(e.target.value)}
          />
        </label>
      )}

      <div className="flex gap-3">
        <input
          className={classFor('calories')}
          type="number"
          inputMode="numeric"
          placeholder={`Calories${per}`}
          value={calories}
          onChange={(e) => setCalories(e.target.value)}
        />
        <input
          className={classFor('protein')}
          type="number"
          inputMode="decimal"
          placeholder={`Protein g${per}`}
          value={protein}
          onChange={(e) => setProtein(e.target.value)}
        />
      </div>
      <div className="flex gap-3">
        <input
          className={classFor('carbs')}
          type="number"
          inputMode="decimal"
          placeholder={`Carbs g${per}`}
          value={carbs}
          onChange={(e) => setCarbs(e.target.value)}
        />
        <input
          className={classFor('fat')}
          type="number"
          inputMode="decimal"
          placeholder={`Fat g${per}`}
          value={fat}
          onChange={(e) => setFat(e.target.value)}
        />
      </div>

      {basis === '100g' && (
        <p className="rounded-xl bg-surface px-3 py-2 text-center text-sm">
          {gramsValid && savedCalories != null ? (
            <>
              One serving ({grams} g) ={' '}
              <strong className="tabular-nums">{formatCalories(savedCalories)} cal</strong>
            </>
          ) : (
            <span className="text-ink-muted">Enter the serving weight to see the per-serving total.</span>
          )}
        </p>
      )}

      <button
        type="button"
        disabled={!valid}
        onClick={save}
        className="rounded-xl bg-accent py-3 font-semibold text-white disabled:opacity-40"
      >
        {submitLabel}
      </button>
    </div>
  );
}
