import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type MealTemplate } from '../lib/api';
import { useData } from '../lib/useData';
import { todayStr } from '../lib/dates';
import { lookupBarcodeRemote, searchOpenFoodFacts } from '../lib/openfoodfacts';
import { formatCalories } from '../lib/units';
import { STRINGS } from '../lib/strings';
import { useUI } from '../store/ui';
import { MEALS, MEAL_LABELS, type Food, type Meal } from '../types';
import ServingSheet from '../components/ServingSheet';
import FoodForm from '../components/FoodForm';
import { BarcodeIcon, ChevronLeftIcon, SearchIcon, TrashIcon } from '../components/Icons';

// zxing is heavy; only load it when the user actually opens the scanner.
const BarcodeScanner = lazy(() => import('../components/BarcodeScanner'));

type Tab = 'quick' | 'search' | 'recent' | 'meals' | 'mine' | 'create';

function defaultMeal(): Meal {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snacks';
}

function rankFoods(all: Food[], q: string): Food[] {
  const matches = all.filter(
    (f) => f.name.toLowerCase().includes(q) || f.brand?.toLowerCase().includes(q),
  );
  matches.sort((a, b) => {
    const aPre = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bPre = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (aPre !== bPre) return aPre - bPre;
    return a.name.length - b.name.length;
  });
  return matches.slice(0, 40);
}

function FoodRow({ food, onPick }: { food: Food; onPick: (f: Food) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(food)}
      className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-surface"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{food.name}</p>
        <p className="truncate text-xs text-ink-muted">
          {food.brand ? `${food.brand} · ` : ''}
          {food.servingLabel}
        </p>
      </div>
      <span className="text-sm font-medium tabular-nums text-ink-secondary">
        {formatCalories(food.caloriesPerServing)}
      </span>
    </button>
  );
}

// Saved meals: one tap logs every item in the bundle. A saved meal can also be
// turned into a single food, which is what a recipe is — ingredients divided
// into portions.
function SavedMeals({
  templates,
  onLog,
  onChanged,
}: {
  templates: MealTemplate[] | undefined;
  onLog: (template: MealTemplate) => void;
  onChanged: () => void;
}) {
  if (templates === undefined) {
    return <p className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</p>;
  }
  if (templates.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-ink-muted">
        On the Budget screen, tap "Save as a meal" under anything you've logged, and it shows up
        here to log again in one tap.
      </p>
    );
  }

  async function asRecipe(template: MealTemplate) {
    const servings = window.prompt(`"${template.name}" makes how many servings?`, '1');
    const makes = Number(servings);
    if (!servings || !Number.isFinite(makes) || makes <= 0) return;
    const name = window.prompt('Save the recipe as:', template.name);
    if (!name?.trim()) return;
    const food = await api.mealTemplateAsFood(template.id, name.trim(), makes);
    onChanged();
    window.alert(`Saved "${food.name}" — ${food.caloriesPerServing} cal per serving.`);
  }

  async function remove(template: MealTemplate) {
    if (!window.confirm(`Delete the saved meal "${template.name}"?`)) return;
    await api.deleteMealTemplate(template.id);
    onChanged();
  }

  return (
    <ul>
      {templates.map((t) => {
        const calories = t.items.reduce((sum, i) => sum + i.caloriesCached, 0);
        return (
          <li key={t.id} className="border-b border-line last:border-b-0">
            <div className="flex items-center gap-3 px-4 py-3">
              <button type="button" onClick={() => onLog(t)} className="min-w-0 flex-1 text-left">
                <p className="truncate text-sm font-medium">{t.name}</p>
                <p className="truncate text-xs text-ink-muted">
                  {t.items.length} item{t.items.length === 1 ? '' : 's'} ·{' '}
                  {t.items.map((i) => i.food?.name ?? i.label ?? 'item').join(', ')}
                </p>
              </button>
              <span className="text-sm font-medium tabular-nums text-ink-secondary">
                {formatCalories(calories)}
              </span>
              <button
                type="button"
                aria-label={`Delete ${t.name}`}
                onClick={() => remove(t)}
                className="rounded-full p-1.5 text-ink-muted hover:bg-surface hover:text-over"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => asRecipe(t)}
              className="px-4 pb-2 text-xs font-medium text-accent"
            >
              Save as a recipe food
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// For when there's no time to find the exact food: type the calories, pick the
// meal, done. No Food row is created — the entry stands on its own.
function QuickAddForm({
  initialMeal,
  onAdd,
}: {
  initialMeal: Meal;
  onAdd: (calories: number, label: string, meal: Meal) => void;
}) {
  const [calories, setCalories] = useState('');
  const [label, setLabel] = useState('');
  const [meal, setMeal] = useState<Meal>(initialMeal);

  const value = Number(calories);
  const valid = calories.trim() !== '' && Number.isFinite(value) && value > 0;
  const field = 'w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm';

  return (
    <form
      className="flex flex-col gap-3 px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onAdd(Math.round(value), label.trim(), meal);
      }}
    >
      <label className="flex flex-col items-center gap-1">
        <input
          type="number"
          inputMode="numeric"
          autoFocus
          min={1}
          placeholder="0"
          value={calories}
          onChange={(e) => setCalories(e.target.value)}
          className="w-40 rounded-xl border border-line bg-surface py-3 text-center text-3xl font-bold tabular-nums"
          aria-label="Calories"
        />
        <span className="text-xs uppercase tracking-wide text-ink-muted">calories</span>
      </label>

      <input
        className={field}
        placeholder="What was it? (optional)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />

      <div className="grid grid-cols-4 gap-2">
        {MEALS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMeal(m)}
            className={`rounded-full py-2 text-xs font-semibold ${
              meal === m ? 'bg-accent text-white' : 'bg-surface text-ink-secondary'
            }`}
          >
            {MEAL_LABELS[m]}
          </button>
        ))}
      </div>

      <button
        type="submit"
        disabled={!valid}
        className="rounded-xl bg-accent py-3 font-semibold text-white disabled:opacity-40"
      >
        Add to {MEAL_LABELS[meal]}
      </button>
    </form>
  );
}

export default function AddFood() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setDate = useUI((s) => s.setDate);
  const bump = useUI((s) => s.bump);

  const meal = (params.get('meal') as Meal | null) ?? defaultMeal();
  const date = params.get('date') ?? todayStr();

  const [tab, setTab] = useState<Tab>(params.get('tab') === 'quick' ? 'quick' : 'search');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Food | null>(null);
  const [scanning, setScanning] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [pendingBarcode, setPendingBarcode] = useState<string | undefined>();
  const [offResults, setOffResults] = useState<Food[]>([]);
  const [offState, setOffState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');

  const q = query.trim().toLowerCase();

  const local = useData(async () => (q ? rankFoods(await api.searchFoods(q), q) : []), [q]);
  const localRef = useRef<Food[]>([]);
  localRef.current = local ?? [];

  const queryRef = useRef(q);
  queryRef.current = q;

  // Debounced Open Food Facts fallback when the seed DB comes up empty.
  useEffect(() => {
    setOffResults([]);
    setOffState('idle');
    if (q.length < 3) return;
    const timer = setTimeout(() => {
      if (localRef.current.length === 0) void runOffSearch(q);
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function runOffSearch(term: string) {
    setOffState('loading');
    try {
      const results = await searchOpenFoodFacts(term);
      if (results.length > 0) await api.saveFoods(results); // cache server-side
      if (queryRef.current !== term) return; // stale response
      const localIds = new Set(localRef.current.map((f) => f.id));
      const localNames = new Set(localRef.current.map((f) => `${f.name}|${f.brand ?? ''}`.toLowerCase()));
      setOffResults(
        results.filter(
          (f) => !localIds.has(f.id) && !localNames.has(`${f.name}|${f.brand ?? ''}`.toLowerCase()),
        ),
      );
      setOffState('done');
    } catch {
      if (queryRef.current === term) setOffState('error');
    }
  }

  async function handleScan(code: string) {
    setScanning(false);
    setBanner(null);
    try {
      let food = await api.foodByBarcode(code);
      if (!food) {
        food = await lookupBarcodeRemote(code);
        if (food) await api.saveFoods(food);
      }
      if (food) {
        setSelected(food);
      } else {
        setPendingBarcode(code);
        setBanner(
          `Barcode ${code} isn't in any database yet. Photograph the nutrition label below and it'll be saved with this barcode.`,
        );
        setTab('create');
      }
    } catch {
      setBanner("Couldn't reach Open Food Facts. Check your connection and try again.");
    }
  }

  async function addEntry(food: Food, servings: number, chosenMeal: Meal) {
    await api.addLogEntry({
      date,
      meal: chosenMeal,
      foodId: food.id,
      servings,
      caloriesCached: Math.round(food.caloriesPerServing * servings),
    });
    bump();
    setDate(date);
    navigate('/');
  }

  const templates = useData(() => api.mealTemplates(), []);

  async function logTemplate(template: MealTemplate) {
    await api.logMealTemplate(template.id, date, meal);
    bump();
    setDate(date);
    navigate('/');
  }

  const recents = useData(() => api.recentFoods(), []);
  const mine = useData(() => api.customFoods(), []);

  async function quickAdd(calories: number, label: string, chosenMeal: Meal) {
    await api.addLogEntry({
      date,
      meal: chosenMeal,
      servings: 1,
      caloriesCached: calories,
      label: label || 'Quick add',
    });
    bump();
    setDate(date);
    navigate('/');
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'quick', label: 'Quick' },
    { key: 'search', label: 'Search' },
    { key: 'recent', label: 'Recent' },
    { key: 'meals', label: 'Meals' },
    { key: 'mine', label: 'Mine' },
    { key: 'create', label: 'New' },
  ];

  const showLocal = local ?? [];
  const noResults = q.length > 0 && showLocal.length === 0 && offResults.length === 0 && offState !== 'loading';

  return (
    <div className="pt-[env(safe-area-inset-top)]">
      <header className="flex items-center gap-1 px-2 py-3">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-ink-secondary hover:bg-card"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold capitalize">Add Food · {meal}</h1>
      </header>

      <div className="mx-4 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-xl border border-line bg-card px-3">
          <SearchIcon className="h-4 w-4 shrink-0 text-ink-muted" />
          <input
            type="search"
            placeholder="Search foods"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (tab !== 'search') setTab('search');
            }}
            className="w-full bg-transparent py-2.5 text-sm outline-none"
          />
        </div>
        <button
          type="button"
          aria-label="Scan a barcode"
          onClick={() => setScanning(true)}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-card text-accent"
        >
          <BarcodeIcon className="h-5 w-5" />
        </button>
      </div>

      {banner && (
        <p className="mx-4 mt-3 rounded-xl bg-over-soft px-3 py-2.5 text-sm text-over">{banner}</p>
      )}

      <div className="mx-4 mt-3 grid grid-cols-6 rounded-xl bg-card p-1 text-center text-[11px] font-semibold">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-lg py-2 ${tab === t.key ? 'bg-accent text-white' : 'text-ink-secondary'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mx-4 mt-3 mb-4 overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
        {tab === 'quick' && <QuickAddForm initialMeal={meal} onAdd={quickAdd} />}

        {tab === 'search' && (
          <>
            {q === '' && (
              <p className="px-4 py-6 text-center text-sm text-ink-muted">
                Search the food database, or scan a barcode.
              </p>
            )}
            {showLocal.map((f) => (
              <FoodRow key={f.id} food={f} onPick={setSelected} />
            ))}
            {offResults.length > 0 && (
              <p className="border-b border-line bg-surface px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                Open Food Facts
              </p>
            )}
            {offResults.map((f) => (
              <FoodRow key={f.id} food={f} onPick={setSelected} />
            ))}
            {offState === 'loading' && (
              <p className="px-4 py-3 text-center text-sm text-ink-muted">Searching online…</p>
            )}
            {offState === 'error' && (
              <p className="px-4 py-3 text-center text-sm text-ink-muted">
                Online search failed — showing local results only.
              </p>
            )}
            {q.length >= 3 && offState === 'idle' && showLocal.length > 0 && (
              <button
                type="button"
                onClick={() => runOffSearch(q)}
                className="w-full px-4 py-3 text-center text-sm font-medium text-accent hover:bg-surface"
              >
                Search Open Food Facts for “{query.trim()}”
              </button>
            )}
            {noResults && offState !== 'idle' && (
              <p className="px-4 py-6 text-center text-sm text-ink-muted">{STRINGS.noResults}</p>
            )}
          </>
        )}

        {tab === 'recent' &&
          ((recents?.length ?? 0) === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-muted">
              Foods you log will show up here for fast re-logging.
            </p>
          ) : (
            recents!.map((f) => <FoodRow key={f.id} food={f} onPick={setSelected} />)
          ))}

        {tab === 'meals' && (
          <SavedMeals templates={templates} onLog={logTemplate} onChanged={bump} />
        )}

        {tab === 'mine' &&
          ((mine?.length ?? 0) === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-muted">
              Custom foods you create will live here.
            </p>
          ) : (
            mine!.map((f) => <FoodRow key={f.id} food={f} onPick={setSelected} />)
          ))}

        {tab === 'create' && (
          <div className="px-4 py-4">
            <FoodForm
              prefillBarcode={pendingBarcode}
              onSaved={(food) => {
                setBanner(null);
                setPendingBarcode(undefined);
                setSelected(food);
              }}
            />
          </div>
        )}
      </div>

      {scanning && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-black" />}>
          <BarcodeScanner onDetected={handleScan} onClose={() => setScanning(false)} />
        </Suspense>
      )}

      {selected && (
        <ServingSheet
          food={selected}
          initialMeal={meal}
          onClose={() => setSelected(null)}
          onAdd={(servings, chosenMeal) => addEntry(selected, servings, chosenMeal)}
        />
      )}
    </div>
  );
}
