import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { rescale } from '../lib/labelParse';
import { scanLabel } from '../lib/labelScan';
import { formatCalories } from '../lib/units';
import type { Food } from '../types';
import { CameraIcon } from './Icons';

// One form for creating and editing a food, including reading one off a
// photographed label.
//
// Panels in much of Europe only state values per 100 g, which is not how
// anyone eats. In "Per 100 g" mode you type the weight of a real serving and
// the saved food carries that serving's numbers — the per-100g figures are
// scratch input, never what gets stored.

type Basis = 'serving' | '100g';

const field = 'w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm';
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

  const [scanState, setScanState] = useState<'idle' | 'scanning'>('idle');
  const [progress, setProgress] = useState(0);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanText, setScanText] = useState<string | null>(null);
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

  async function readLabel(file: File) {
    setScanState('scanning');
    setProgress(0);
    setScanError(null);
    setScanNote(null);
    try {
      const r = await scanLabel(file, setProgress);
      setScanText(r.text);
      if (r.found.length === 0) {
        setScanError(
          "Couldn't find any nutrition values in that photo. Try again with the panel filling the frame, in even light — or just type them in.",
        );
        return;
      }
      // Only fill what was read; anything missed stays as you left it.
      if (r.calories != null) setCalories(str(r.calories));
      if (r.protein != null) setProtein(str(r.protein));
      if (r.carbs != null) setCarbs(str(r.carbs));
      if (r.fat != null) setFat(str(r.fat));

      if (r.basis === '100g' || r.basis === '100ml') {
        setBasis('100g');
        // A portion size printed alongside the per-100g column is the best
        // available guess at a real serving; otherwise start at 100 g.
        setServingGrams(str(r.servingGrams ?? 100));
        setScanNote(
          `Read per 100 ${r.basis === '100ml' ? 'ml' : 'g'}. Set the serving weight below — everything rescales to it. Check the numbers.`,
        );
      } else {
        setBasis('serving');
        if (r.servingLabel) setServingLabel(r.servingLabel);
        if (r.servingGrams != null) setServingGrams(str(r.servingGrams));
        setScanNote(`Read ${r.found.join(', ')} from your photo. Check the values before saving.`);
      }
    } catch (e) {
      setScanError(e instanceof Error ? e.message : "Couldn't read that photo.");
    } finally {
      setScanState('idle');
    }
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
    await api.saveFoods(food);
    onSaved(food);
  }

  const per = basis === '100g' ? ' / 100g' : '';

  return (
    <div className="flex flex-col gap-3">
      {prefillBarcode && !initial && (
        <p className="rounded-xl bg-accent-soft px-3 py-2 text-xs text-accent-deep">
          Saving with barcode {prefillBarcode} — next scan will find it.
        </p>
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
          if (file) void readLabel(file);
        }}
      />
      <button
        type="button"
        disabled={scanState === 'scanning'}
        onClick={() => photoInput.current?.click()}
        className="flex items-center justify-center gap-2 rounded-xl border border-accent py-2.5 text-sm font-semibold text-accent disabled:opacity-60"
      >
        <CameraIcon className="h-4 w-4" />
        {scanState === 'scanning'
          ? `Reading label… ${Math.round(progress * 100)}%`
          : 'Scan nutrition label'}
      </button>
      <p className="-mt-1 text-center text-xs text-ink-muted">
        Fill the frame with the panel. Reading happens on your phone — nothing is uploaded.
      </p>
      {scanError && <p className="rounded-xl bg-over-soft px-3 py-2 text-xs text-over">{scanError}</p>}
      {scanNote && (
        <p className="rounded-xl bg-accent-soft px-3 py-2 text-xs text-accent-deep">{scanNote}</p>
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
          className={field}
          type="number"
          inputMode="numeric"
          placeholder={`Calories${per}`}
          value={calories}
          onChange={(e) => setCalories(e.target.value)}
        />
        <input
          className={field}
          type="number"
          inputMode="decimal"
          placeholder={`Protein g${per}`}
          value={protein}
          onChange={(e) => setProtein(e.target.value)}
        />
      </div>
      <div className="flex gap-3">
        <input
          className={field}
          type="number"
          inputMode="decimal"
          placeholder={`Carbs g${per}`}
          value={carbs}
          onChange={(e) => setCarbs(e.target.value)}
        />
        <input
          className={field}
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
