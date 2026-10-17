import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { api, type Recipe, type RecipeIngredient } from '../lib/api';
import { useData } from '../lib/useData';
import { useUI } from '../store/ui';
import { shiftDay, todayStr } from '../lib/dates';
import { formatCalories } from '../lib/units';
import { MEALS, MEAL_LABELS, type Meal } from '../types';
import { ChevronLeftIcon } from '../components/Icons';
import GradeBadge from '../components/GradeBadge';
import RecipeEditor, { draftFromRecipe } from '../components/RecipeEditor';
import RecipeShop from '../components/RecipeShop';
import Sheet from '../components/Sheet';
import { AddSheet } from './Plan';

// A recipe to read and cook from: its photo, ingredients for any number of
// servings, and the method — and from here, shop for it, plan it or log it.

const FRACTIONS: [number, string][] = [
  [0.25, '¼'],
  [1 / 3, '⅓'],
  [0.5, '½'],
  [2 / 3, '⅔'],
  [0.75, '¾'],
];

/** 1.5 → "1½", 0.333 → "⅓", 2.4 → "2.4", 250 → "250". */
export function amount(n: number) {
  const whole = Math.floor(n);
  const part = n - whole;
  if (part < 0.05) return String(whole);
  if (part > 0.95) return String(whole + 1);
  const fraction = FRACTIONS.find(([value]) => Math.abs(part - value) < 0.05);
  if (fraction && n < 10) return `${whole || ''}${fraction[1]}`;
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

/** The amount a line starts with: "1 1/2 ", "1-1/2 ", "½ ", "1.3 ". */
const LEADING_AMOUNT = /^\s*(?:\d+\s*-\s*\d+\/\d+|\d+(?:[.,]\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+|[¼½¾⅓⅔])(?:\s*[¼½¾⅓⅔])?\s+/;
/** A range a line starts with: "2-3 ", "1 or 2 ", "2 to 3 ". */
const LEADING_RANGE = /^\s*(\d+(?:[.,]\d+)?)\s*(-|–|to|or)\s*(\d+(?:[.,]\d+)?)(?!\s*\/)\s+/;

/**
 * An ingredient line for `factor` times the recipe: the line as written with
 * its amount scaled, so "2 onions, sliced" stays itself. As written when it
 * has no amount.
 */
export function scaledLine(ing: RecipeIngredient, factor: number) {
  if (factor === 1 || ing.quantity == null) return ing.raw;
  const range = LEADING_RANGE.exec(ing.raw);
  if (range) {
    const [from, to] = [range[1], range[3]].map((n) => amount(Number(n.replace(',', '.')) * factor));
    return ing.raw.replace(LEADING_RANGE, `${from}–${to} `);
  }
  const scaled = amount(ing.quantity * factor);
  if (LEADING_AMOUNT.test(ing.raw)) return ing.raw.replace(LEADING_AMOUNT, `${scaled} `);
  return [scaled, ing.unit, ing.name ?? ing.raw].filter(Boolean).join(' ');
}

/** Keeps the screen on while `on`, where the browser can. */
function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || !('wakeLock' in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    const take = async () => {
      try {
        lock = await (navigator as Navigator & { wakeLock: { request: (t: 'screen') => Promise<typeof lock> } }).wakeLock.request('screen');
      } catch {
        // Refused, as on low battery: the screen just sleeps as usual.
      }
    };
    // The lock goes when the page is hidden; take it again on return.
    const visible = () => document.visibilityState === 'visible' && void take();
    void take();
    document.addEventListener('visibilitychange', visible);
    return () => {
      document.removeEventListener('visibilitychange', visible);
      lock?.release().catch(() => {});
    };
  }, [on]);
}

const mealNow = (): Meal => {
  const hour = new Date().getHours();
  return hour < 11 ? 'breakfast' : hour < 15 ? 'lunch' : hour < 21 ? 'dinner' : 'snacks';
};

function LogSheet({ recipe, onClose }: { recipe: Recipe; onClose: () => void }) {
  const bump = useUI((s) => s.bump);
  const [meal, setMeal] = useState<Meal>(mealNow);
  const [servings, setServings] = useState(1);
  const [busy, setBusy] = useState(false);
  const perServing = recipe.food?.caloriesPerServing ?? 0;

  async function log() {
    if (!recipe.food) return;
    setBusy(true);
    try {
      await api.addLogEntry({
        date: todayStr(),
        meal,
        foodId: recipe.food.id,
        servings,
        caloriesCached: Math.round(perServing * servings),
      });
      bump();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose}>
      <h2 className="text-lg font-semibold">Log {recipe.name}</h2>
      <div className="mt-3 grid grid-cols-4 gap-1 rounded-xl bg-surface p-1 text-center text-xs font-semibold">
        {MEALS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMeal(m)}
            className={`rounded-lg py-2 ${meal === m ? 'bg-accent text-white' : 'text-ink-secondary'}`}
          >
            {MEAL_LABELS[m]}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className="flex-1 text-ink-secondary">Servings</span>
        <button
          type="button"
          aria-label="Less"
          onClick={() => setServings((n) => Math.max(0.5, n - 0.5))}
          className="h-8 w-8 rounded-lg border border-line"
        >
          −
        </button>
        <span className="w-8 text-center tabular-nums">{amount(servings)}</span>
        <button
          type="button"
          aria-label="More"
          onClick={() => setServings((n) => Math.min(10, n + 0.5))}
          className="h-8 w-8 rounded-lg border border-line"
        >
          +
        </button>
      </div>
      <button
        type="button"
        disabled={busy || !recipe.food}
        onClick={() => void log()}
        className="mt-4 w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        Log {formatCalories(Math.round(perServing * servings))} cal to today
      </button>
    </Sheet>
  );
}

function PlanDaySheet({ onPick, onClose }: { onPick: (date: string) => void; onClose: () => void }) {
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(todayStr(), i));
  return (
    <Sheet onClose={onClose}>
      <h2 className="mb-3 text-lg font-semibold">Which day?</h2>
      <div className="grid grid-cols-2 gap-2">
        {days.map((d, i) => (
          <button
            key={d}
            type="button"
            onClick={() => onPick(d)}
            className="rounded-xl border border-line px-3 py-2.5 text-left text-sm"
          >
            {i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : format(parseISO(d), 'EEEE d MMM')}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export default function RecipePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const bump = useUI((s) => s.bump);
  const recipe = useData(() => api.recipe(id).catch(() => null), [id]);
  const session = useData(() => api.session(), []);
  const members = useData(() => api.household(), []) ?? [];
  const picnic = useData(() => api.picnicStatus().catch(() => null), []);
  const [servings, setServings] = useState<number | null>(null);
  const [awake, setAwake] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState<'shop' | 'log' | 'day' | null>(null);
  const [planDate, setPlanDate] = useState<string | null>(null);
  useWakeLock(awake);

  if (recipe === undefined) return <p className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</p>;
  if (recipe === null) return <p className="px-4 py-6 text-center text-sm text-ink-muted">That recipe isn't here.</p>;

  if (editing) {
    return (
      <RecipeEditor
        initial={draftFromRecipe(recipe)}
        recipeId={recipe.id}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          bump();
        }}
      />
    );
  }

  const makes = servings ?? recipe.servings;
  const factor = recipe.servings > 0 ? makes / recipe.servings : 1;
  const steps = (recipe.instructions ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const me = members.find((m) => m.username === session?.username)?.id;
  const mine = session?.username != null && recipe.author === session.username;
  let site: string | null = null;
  try {
    site = recipe.sourceUrl ? new URL(recipe.sourceUrl).hostname.replace(/^www\./, '') : null;
  } catch {
    site = null;
  }

  return (
    <div className="mx-auto w-full max-w-3xl pt-[env(safe-area-inset-top)] pb-6">
      <header className="flex items-center gap-1 px-2 py-3">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-ink-secondary hover:bg-card"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{recipe.name}</h1>
        {mine && (
          <button type="button" onClick={() => setEditing(true)} className="px-3 text-sm font-medium text-accent">
            Edit
          </button>
        )}
      </header>

      {recipe.imageUrl && (
        <img src={recipe.imageUrl} alt="" className="mx-4 aspect-[4/3] w-[calc(100%-2rem)] rounded-2xl bg-surface object-cover" />
      )}

      <div className="mx-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-secondary">
        {recipe.grade && (
          <span className="flex items-center gap-1">
            <GradeBadge grade={recipe.grade.grade} /> Nutri-Score
          </span>
        )}
        {recipe.perServing.calories != null && <span>{formatCalories(recipe.perServing.calories)} cal a serving</span>}
        {site && (
          <a href={recipe.sourceUrl!} target="_blank" rel="noreferrer" className="text-accent underline">
            {site}
          </a>
        )}
      </div>

      <div className="mx-4 mt-3 grid grid-cols-3 gap-2">
        {picnic?.connected && (
          <button
            type="button"
            onClick={() => setSheet('shop')}
            className="rounded-xl border border-accent py-2.5 text-sm font-semibold text-accent"
          >
            Shop
          </button>
        )}
        <button
          type="button"
          onClick={() => setSheet('day')}
          className="rounded-xl border border-accent py-2.5 text-sm font-semibold text-accent"
        >
          Plan
        </button>
        <button
          type="button"
          disabled={!recipe.food}
          onClick={() => setSheet('log')}
          className="rounded-xl border border-accent py-2.5 text-sm font-semibold text-accent disabled:opacity-40"
        >
          Log
        </button>
      </div>

      <section className="mx-4 mt-4 rounded-2xl border border-line bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 font-semibold">Ingredients</h2>
          <button
            type="button"
            aria-label="Fewer servings"
            onClick={() => setServings(Math.max(1, makes - 1))}
            className="h-8 w-8 rounded-lg border border-line"
          >
            −
          </button>
          <span className="w-20 text-center text-sm tabular-nums">
            {amount(makes)} {makes === 1 ? 'serving' : 'servings'}
          </span>
          <button
            type="button"
            aria-label="More servings"
            onClick={() => setServings(Math.min(50, makes + 1))}
            className="h-8 w-8 rounded-lg border border-line"
          >
            +
          </button>
        </div>
        <ul className="mt-2 space-y-1.5 text-sm">
          {recipe.ingredients.map((ing, i) => (
            <li key={ing.id ?? i} className="flex gap-2">
              <span className="text-ink-muted">•</span>
              <span>{scaledLine(ing, factor)}</span>
            </li>
          ))}
        </ul>
      </section>

      {steps.length > 0 && (
        <section className="mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <h2 className="flex-1 font-semibold">Method</h2>
            {'wakeLock' in navigator && (
              <label className="flex items-center gap-2 text-sm text-ink-secondary">
                <input
                  type="checkbox"
                  checked={awake}
                  onChange={(e) => setAwake(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                Keep screen on
              </label>
            )}
          </div>
          <ol className="mt-2 space-y-3 text-sm">
            {steps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                  {i + 1}
                </span>
                <span className="pt-0.5">{step}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {recipe.notes && <p className="mx-4 mt-3 text-sm text-ink-secondary">{recipe.notes}</p>}

      {sheet === 'shop' && (
        <RecipeShop recipe={{ id: recipe.id, name: recipe.name, servings: makes }} onClose={() => setSheet(null)} />
      )}
      {sheet === 'log' && <LogSheet recipe={recipe} onClose={() => setSheet(null)} />}
      {sheet === 'day' && (
        <PlanDaySheet
          onClose={() => setSheet(null)}
          onPick={(d) => {
            setSheet(null);
            setPlanDate(d);
          }}
        />
      )}
      {planDate && (
        <AddSheet
          date={planDate}
          members={members}
          me={me}
          initial={{
            choice: { kind: 'recipe', id: recipe.id, name: recipe.name, servingLabel: '1 serving', calories: recipe.perServing.calories },
            servings: makes,
          }}
          onClose={() => setPlanDate(null)}
          onAdded={() => {
            setPlanDate(null);
            bump();
          }}
        />
      )}
    </div>
  );
}

