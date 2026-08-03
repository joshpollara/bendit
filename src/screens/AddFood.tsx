import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { todayStr } from '../lib/dates';
import { lookupBarcodeRemote, searchOpenFoodFacts } from '../lib/openfoodfacts';
import { formatCalories } from '../lib/units';
import { STRINGS } from '../lib/strings';
import { useUI } from '../store/ui';
import type { Food, Meal } from '../types';
import ServingSheet from '../components/ServingSheet';
import { BarcodeIcon, ChevronLeftIcon, SearchIcon } from '../components/Icons';

// zxing is heavy; only load it when the user actually opens the scanner.
const BarcodeScanner = lazy(() => import('../components/BarcodeScanner'));

type Tab = 'search' | 'recent' | 'mine' | 'create';

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

function CreateFoodForm({
  prefillBarcode,
  onCreated,
}: {
  prefillBarcode?: string;
  onCreated: (food: Food) => void;
}) {
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [servingLabel, setServingLabel] = useState('1 serving');
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');

  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const valid = name.trim() !== '' && Number.isFinite(Number(calories)) && Number(calories) >= 0;

  async function save() {
    const food: Food = {
      id: `custom-${crypto.randomUUID()}`,
      name: name.trim(),
      brand: brand.trim() || undefined,
      barcode: prefillBarcode,
      servingLabel: servingLabel.trim() || '1 serving',
      caloriesPerServing: Math.round(Number(calories)),
      protein: num(protein),
      carbs: num(carbs),
      fat: num(fat),
      source: 'custom',
    };
    await api.saveFoods(food);
    onCreated(food);
  }

  const field = 'w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm';

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      {prefillBarcode && (
        <p className="rounded-xl bg-accent-soft px-3 py-2 text-xs text-accent-deep">
          Creating a food for barcode {prefillBarcode}
        </p>
      )}
      <input className={field} placeholder="Food name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className={field} placeholder="Brand (optional)" value={brand} onChange={(e) => setBrand(e.target.value)} />
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
          inputMode="numeric"
          placeholder="Calories"
          value={calories}
          onChange={(e) => setCalories(e.target.value)}
        />
      </div>
      <div className="flex gap-3">
        <input className={field} type="number" inputMode="decimal" placeholder="Protein g" value={protein} onChange={(e) => setProtein(e.target.value)} />
        <input className={field} type="number" inputMode="decimal" placeholder="Carbs g" value={carbs} onChange={(e) => setCarbs(e.target.value)} />
        <input className={field} type="number" inputMode="decimal" placeholder="Fat g" value={fat} onChange={(e) => setFat(e.target.value)} />
      </div>
      <button
        type="button"
        disabled={!valid}
        onClick={save}
        className="rounded-xl bg-accent py-3 font-semibold text-white disabled:opacity-40"
      >
        Save Food
      </button>
    </div>
  );
}

export default function AddFood() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setDate = useUI((s) => s.setDate);
  const bump = useUI((s) => s.bump);

  const meal = (params.get('meal') as Meal | null) ?? defaultMeal();
  const date = params.get('date') ?? todayStr();

  const [tab, setTab] = useState<Tab>('search');
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
        setBanner(`Barcode ${code} isn't in Open Food Facts yet. Create it as a custom food?`);
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

  const recents = useData(() => api.recentFoods(), []);
  const mine = useData(() => api.customFoods(), []);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'search', label: 'Search' },
    { key: 'recent', label: 'Recent' },
    { key: 'mine', label: 'My Foods' },
    { key: 'create', label: 'Create' },
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

      <div className="mx-4 mt-3 grid grid-cols-4 rounded-xl bg-card p-1 text-center text-xs font-semibold">
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

        {tab === 'mine' &&
          ((mine?.length ?? 0) === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-muted">
              Custom foods you create will live here.
            </p>
          ) : (
            mine!.map((f) => <FoodRow key={f.id} food={f} onPick={setSelected} />)
          ))}

        {tab === 'create' && (
          <CreateFoodForm
            prefillBarcode={pendingBarcode}
            onCreated={(food) => {
              setBanner(null);
              setPendingBarcode(undefined);
              setSelected(food);
            }}
          />
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
