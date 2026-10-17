import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format, parseISO, startOfWeek } from 'date-fns';
import { Link } from 'react-router-dom';
import {
  api,
  type HouseholdMember,
  type LessWasteLine,
  type PicnicListProduct,
  type PicnicShoppingList,
  type PlanItem,
  type Recipe,
  type ShoppingList,
} from '../lib/api';
import { useData } from '../lib/useData';
import { computeBudget } from '../lib/budget';
import { DAY, shiftDay, todayStr } from '../lib/dates';
import { macroTargets } from '../lib/macros';
import { formatCalories } from '../lib/units';
import { useUI } from '../store/ui';
import { MEALS, MEAL_LABELS, type Food, type Meal, type Profile } from '../types';
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, SearchIcon } from '../components/Icons';
import Sheet from '../components/Sheet';
import { euros, ProductPicker, Thumb } from '../components/PicnicBits';

const mondayOf = (date: string) => format(startOfWeek(parseISO(date), { weekStartsOn: 1 }), DAY);
const round2 = (n: number) => Math.round(n * 100) / 100;

const card = 'mx-4 mt-3 rounded-2xl border border-line bg-card shadow-sm lg:mx-0';

type Portions = Record<string, number>;

/** − 1.5 + for one person's servings. */
function Stepper({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        aria-label={`Fewer servings for ${label}`}
        disabled={value <= 0}
        onClick={() => onChange(Math.max(0, round2(value - 0.5)))}
        className="h-8 w-8 rounded-lg border border-line text-ink-secondary disabled:opacity-40"
      >
        −
      </button>
      <span className="w-8 text-center text-sm tabular-nums">{value}</span>
      <button
        type="button"
        aria-label={`More servings for ${label}`}
        onClick={() => onChange(round2(value + 0.5))}
        className="h-8 w-8 rounded-lg border border-line text-ink-secondary"
      >
        +
      </button>
    </span>
  );
}

function PortionsEditor({
  members,
  portions,
  onChange,
  servingLabel,
}: {
  members: HouseholdMember[];
  portions: Portions;
  onChange: (p: Portions) => void;
  servingLabel: string;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-ink-muted">Servings ({servingLabel})</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {members.map((m) => (
          <li key={m.id} className="flex items-center justify-between px-3 py-2">
            <span className="text-sm">{m.username}</span>
            <Stepper
              label={m.username}
              value={portions[m.id] ?? 0}
              onChange={(n) => onChange({ ...portions, [m.id]: n })}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function MealPicker({ meal, onChange }: { meal: Meal; onChange: (m: Meal) => void }) {
  return (
    <div className="grid grid-cols-4 gap-1 rounded-xl bg-surface p-1 text-center text-xs font-semibold">
      {MEALS.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`rounded-lg py-2 ${meal === m ? 'bg-accent text-white' : 'text-ink-secondary'}`}
        >
          {MEAL_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

const toList = (portions: Portions) =>
  Object.entries(portions)
    .filter(([, servings]) => servings > 0)
    .map(([userId, servings]) => ({ userId, servings }));

type Choice =
  | { kind: 'recipe'; id: string; name: string; servingLabel: string; calories: number | null }
  | { kind: 'food'; id: string; name: string; servingLabel: string; calories: number };

/**
 * A recipe's portions to start from: everyone, since a recipe is usually
 * cooked for everyone; one each, or the servings shared out to the half.
 */
const everyone = (members: HouseholdMember[], servings?: number): Portions =>
  Object.fromEntries(
    members.map((m) => [m.id, servings ? Math.max(0.5, Math.round((servings / members.length) * 2) / 2) : 1]),
  );

function AddSheet({
  date,
  members,
  me,
  initial,
  onClose,
  onAdded,
}: {
  date: string;
  members: HouseholdMember[];
  me: string | undefined;
  /** A recipe already picked, and how many servings, as when planning one to use up a leftover. */
  initial?: { choice: Choice; servings?: number };
  onClose: () => void;
  onAdded: () => void;
}) {
  const [meal, setMeal] = useState<Meal>('dinner');
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState<Choice | null>(initial?.choice ?? null);
  const [portions, setPortions] = useState<Portions>(() => (initial ? everyone(members, initial.servings) : {}));
  const [foods, setFoods] = useState<Food[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recipes = useData(() => api.recipes(), []);

  const q = query.trim().toLowerCase();
  useEffect(() => {
    if (q.length < 2) return setFoods([]);
    const timer = setTimeout(() => api.searchFoods(q).then(setFoods, () => setFoods([])), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const recipeMatches = (recipes ?? []).filter((r: Recipe) => !q || r.name.toLowerCase().includes(q)).slice(0, 8);
  // A recipe's own one-serving food would otherwise show up twice.
  const recipeFoods = new Set((recipes ?? []).map((r) => r.food?.id));

  function pick(next: Choice) {
    setChoice(next);
    // A recipe is usually cooked for everyone; a single food is usually one person's.
    setPortions(next.kind === 'recipe' ? everyone(members) : me ? { [me]: 1 } : {});
  }

  async function save() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await api.addPlanItem({
        date,
        meal,
        ...(choice.kind === 'recipe' ? { recipeId: choice.id } : { foodId: choice.id }),
        portions: toList(portions),
      });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add it.');
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose}>
      <h2 className="mb-3 text-lg font-semibold">{format(parseISO(date), 'EEEE d MMMM')}</h2>
      <MealPicker meal={meal} onChange={setMeal} />

      {choice ? (
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate font-medium">{choice.name}</p>
            <button type="button" onClick={() => setChoice(null)} className="text-sm text-accent">
              Change
            </button>
          </div>
          <PortionsEditor
            members={members}
            portions={portions}
            onChange={setPortions}
            servingLabel={choice.servingLabel}
          />
          {error && <p className="text-sm text-over">{error}</p>}
          <button
            type="button"
            disabled={busy || toList(portions).length === 0}
            onClick={save}
            className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            Add to plan
          </button>
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface px-3">
            <SearchIcon className="h-4 w-4 shrink-0 text-ink-muted" />
            <input
              type="search"
              autoFocus
              placeholder="Recipes and foods"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-transparent py-2.5 text-sm outline-none"
            />
          </div>
          <ul className="mt-2 max-h-[50vh] divide-y divide-line overflow-y-auto">
            {recipeMatches.map((r) => (
              <li key={`r-${r.id}`}>
                <button
                  type="button"
                  disabled={!r.food}
                  onClick={() =>
                    pick({
                      kind: 'recipe',
                      id: r.id,
                      name: r.name,
                      servingLabel: '1 serving',
                      calories: r.food?.caloriesPerServing ?? null,
                    })
                  }
                  className="flex w-full items-center gap-3 py-2.5 text-left disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.name}</span>
                    <span className="block text-xs text-ink-muted">Recipe · makes {r.servings}</span>
                  </span>
                  {r.food && (
                    <span className="text-sm tabular-nums text-ink-secondary">
                      {formatCalories(r.food.caloriesPerServing)}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {foods
              .filter((f) => !recipeFoods.has(f.id))
              .map((f) => (
                <li key={`f-${f.id}`}>
                  <button
                    type="button"
                    onClick={() =>
                      pick({
                        kind: 'food',
                        id: f.id,
                        name: f.name,
                        servingLabel: f.servingLabel,
                        calories: f.caloriesPerServing,
                      })
                    }
                    className="flex w-full items-center gap-3 py-2.5 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{f.name}</span>
                      <span className="block truncate text-xs text-ink-muted">
                        {f.servingLabel}
                        {f.brand ? ` · ${f.brand}` : ''}
                      </span>
                    </span>
                    <span className="text-sm tabular-nums text-ink-secondary">
                      {formatCalories(f.caloriesPerServing)}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}
    </Sheet>
  );
}

function EditSheet({
  item,
  week,
  members,
  onClose,
  onChanged,
}: {
  item: PlanItem;
  week: string[];
  members: HouseholdMember[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [meal, setMeal] = useState<Meal>(item.meal);
  const [date, setDate] = useState(item.date);
  const [portions, setPortions] = useState<Portions>(
    Object.fromEntries(item.portions.map((p) => [p.userId, p.servings])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose}>
      <h2 className="mb-3 text-lg font-semibold">{item.name}</h2>
      <div className="space-y-4">
        <MealPicker meal={meal} onChange={setMeal} />
        <div className="grid grid-cols-7 gap-1 text-center text-xs">
          {week.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDate(d)}
              className={`rounded-lg py-2 ${date === d ? 'bg-accent text-white' : 'bg-surface text-ink-secondary'}`}
            >
              <span className="block font-semibold">{format(parseISO(d), 'EEEEE')}</span>
              <span className="block">{format(parseISO(d), 'd')}</span>
            </button>
          ))}
        </div>
        <PortionsEditor
          members={members}
          portions={portions}
          onChange={setPortions}
          servingLabel={item.servingLabel}
        />
        {error && <p className="text-sm text-over">{error}</p>}
        <button
          type="button"
          disabled={busy || toList(portions).length === 0}
          onClick={() => run(() => api.updatePlanItem(item.id, { date, meal, portions: toList(portions) }))}
          className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => api.deletePlanItem(item.id))}
          className="w-full rounded-xl py-2 text-sm font-semibold text-over"
        >
          Remove from plan
        </button>
      </div>
    </Sheet>
  );
}

function DayCard({
  date,
  items,
  me,
  budget,
  targets,
  onAdd,
  onOpen,
}: {
  date: string;
  items: PlanItem[];
  me: string | undefined;
  budget: number;
  targets: ReturnType<typeof macroTargets>;
  onAdd: () => void;
  onOpen: (item: PlanItem) => void;
}) {
  const mine = (item: PlanItem) => item.portions.find((p) => p.userId === me)?.servings ?? 0;
  const total = items.reduce(
    (sum, item) => {
      const s = mine(item);
      return {
        calories: sum.calories + item.perServing.calories * s,
        protein: sum.protein + (item.perServing.protein ?? 0) * s,
        carbs: sum.carbs + (item.perServing.carbs ?? 0) * s,
        fat: sum.fat + (item.perServing.fat ?? 0) * s,
      };
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const over = total.calories > budget;
  const macro = (key: 'protein' | 'carbs' | 'fat', label: string) =>
    `${label} ${Math.round(total[key])}${targets[key] ? `/${targets[key]}` : ''} g`;

  return (
    <section className={card}>
      <header className="flex items-start gap-2 px-4 pt-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">
            {format(parseISO(date), 'EEEE d MMM')}
            {date === todayStr() && <span className="ml-2 text-xs font-medium text-accent">Today</span>}
          </h2>
          {items.length > 0 && (
            <p className="text-xs text-ink-muted">
              <span className={`tabular-nums ${over ? 'font-medium text-over' : ''}`}>
                {formatCalories(total.calories)} / {formatCalories(budget)} cal
              </span>{' '}
              · {macro('protein', 'P')} · {macro('carbs', 'C')} · {macro('fat', 'F')}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label={`Plan a meal on ${format(parseISO(date), 'EEEE')}`}
          onClick={onAdd}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </header>
      <ul className="mt-2 pb-1">
        {items.length === 0 && <li className="px-4 pb-2 text-sm text-ink-muted">Nothing planned.</li>}
        {MEALS.flatMap((meal) =>
          items
            .filter((item) => item.meal === meal)
            .map((item) => (
              <li key={item.id} className="border-t border-line">
                <button
                  type="button"
                  onClick={() => onOpen(item)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface"
                >
                  <span className="w-16 shrink-0 text-xs text-ink-muted">{MEAL_LABELS[meal]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.name}</span>
                    <span className="block truncate text-xs text-ink-muted">
                      {item.portions
                        .map((p) => `${p.username} ${round2(p.servings)}${p.logged ? ' ✓' : ''}`)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums text-ink-secondary">
                    {mine(item) > 0 ? formatCalories(item.perServing.calories * mine(item)) : '—'}
                  </span>
                </button>
              </li>
            )),
        )}
      </ul>
    </section>
  );
}

type ListItem = ShoppingList['items'][number] & Partial<PicnicShoppingList['items'][number]>;
type ListData = Omit<ShoppingList, 'items'> & { items: ListItem[] };

const grams = (n: number) => (n >= 1000 ? `${round2(n / 1000)} kg` : `${n} g`);

const amountOf = (item: ListItem) =>
  [item.grams != null ? grams(item.grams) : null, ...item.written].filter(Boolean).join(' + ');

function ShoppingView({
  list,
  picnic,
  waste,
  onToggle,
  onChoose,
  onAccept,
  onUse,
  onPlanRecipe,
  onAddToCart,
}: {
  list: ListData | undefined;
  /** Picnic is connected, so lines carry products. */
  picnic: boolean;
  /** What the packs leave over, when "Less waste" is on. */
  waste: LessWasteLine[] | undefined;
  onToggle: (key: string, checked: boolean) => void;
  onChoose: (item: ListItem) => void;
  onAccept: (item: ListItem) => void;
  onUse: (item: ListItem, product: PicnicListProduct) => void;
  onPlanRecipe: (recipe: LessWasteLine['recipes'][number]) => void;
  onAddToCart: () => void;
}) {
  if (!list) return <p className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</p>;
  if (list.items.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-ink-muted">Nothing planned this week.</p>;
  }
  // Only what someone chose is bought; a suggestion needs accepting first.
  const buying = list.items.filter((i) => !i.checked && i.choice);
  const total = buying.reduce((sum, i) => sum + (i.choice?.price ?? 0) * (i.packs ?? 1), 0);
  const wasteOf = new Map((waste ?? []).map((w) => [w.key, w]));
  const usable = (waste ?? []).filter((w) => w.recipes.length > 0);
  return (
    <>
      <ul>
        {list.items.map((item) => {
          const product = item.choice ?? item.suggestion;
          const left = wasteOf.get(item.key);
          return (
            <li key={item.key} className="border-b border-line last:border-b-0">
              <label className="flex cursor-pointer items-center gap-3 px-4 pt-2.5 pb-2">
                <input
                  type="checkbox"
                  checked={item.checked}
                  onChange={(e) => onToggle(item.key, e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span className={`min-w-0 flex-1 ${item.checked ? 'text-ink-muted line-through' : ''}`}>
                  <span className="block truncate text-sm font-medium">{item.name}</span>
                  <span className="block truncate text-xs text-ink-muted">{item.usedIn.join(', ')}</span>
                </span>
                <span className="text-sm tabular-nums text-ink-secondary">{amountOf(item)}</span>
              </label>
              {picnic && !item.checked && (
                <div className="flex items-center gap-2 pr-4 pb-2.5 pl-11">
                  {product ? (
                    <>
                      <Thumb id={product.imageId} size="h-8 w-8" />
                      <span className="min-w-0 flex-1 text-xs">
                        <span className="block truncate text-ink-secondary">
                          {item.packs ?? 1} × {product.name}
                        </span>
                        <span className="block truncate text-ink-muted">
                          {product.unitQuantity}
                          {product.price != null ? ` · ${euros(product.price * (item.packs ?? 1))}` : ''}
                          {!item.choice ? ' · suggested' : ''}
                          {left ? ` · ${grams(left.left)} left over` : ''}
                        </span>
                      </span>
                    </>
                  ) : (
                    <span className="flex-1 text-xs text-ink-muted">No Picnic product found.</span>
                  )}
                  {!item.choice && item.suggestion && (
                    <button
                      type="button"
                      onClick={() => onAccept(item)}
                      className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent"
                    >
                      Use
                    </button>
                  )}
                  <button type="button" onClick={() => onChoose(item)} className="text-xs font-semibold text-accent">
                    {product ? 'Change' : 'Choose'}
                  </button>
                </div>
              )}
              {picnic && !item.checked && left?.better && (
                <div className="mr-4 mb-2.5 ml-11 flex items-center gap-2 rounded-xl border border-line px-2 py-1.5">
                  <Thumb id={left.better.product.imageId} size="h-7 w-7" />
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="block truncate text-ink-secondary">
                      {left.better.packs} × {left.better.product.name}
                    </span>
                    <span className="block truncate text-ink-muted">
                      {left.better.product.unitQuantity}
                      {left.better.product.price != null
                        ? ` · ${euros(left.better.product.price * left.better.packs)}`
                        : ''}
                      {` · ${left.better.left ? `${grams(left.better.left)} left over` : 'nothing left over'}`}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onUse(item, left.better!.product)}
                    className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent"
                  >
                    Use
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {usable.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <h3 className="text-sm font-semibold">Use up what's left</h3>
          <ul className="mt-1">
            {usable.map((w) => (
              <li key={w.key} className="py-1.5">
                <p className="text-xs text-ink-secondary">
                  {w.name} · {grams(w.left)} of {grams(w.bought)}
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {w.recipes.map((r) => (
                    <button
                      key={r.recipeId}
                      type="button"
                      onClick={() => onPlanRecipe(r)}
                      className="rounded-full border border-line px-2.5 py-1 text-xs"
                    >
                      {r.name} · {r.servings} {r.servings === 1 ? 'serving' : 'servings'}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {picnic && buying.length > 0 && (
        <div className="border-t border-line p-3">
          <button
            type="button"
            onClick={onAddToCart}
            className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white"
          >
            Add {buying.length} to Picnic cart · {euros(total)}
          </button>
        </div>
      )}
    </>
  );
}

export default function Plan({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const bump = useUI((s) => s.bump);
  const [monday, setMonday] = useState(() => mondayOf(todayStr()));
  const [tab, setTab] = useState<'week' | 'shopping'>('week');
  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlanItem | null>(null);

  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDay(monday, i)), [monday]);
  const sunday = week[6];
  const members = useData(() => api.household(), []) ?? [];
  const session = useData(() => api.session(), []);
  const weights = useData(() => api.getWeights(), []);
  const items = useData(() => api.mealPlan(monday, sunday), [monday]);
  const picnic = useData(() => api.picnicStatus(), []);
  const viaPicnic = picnic?.connected === true;
  const shopping = useData(
    (): Promise<ListData | undefined> =>
      tab !== 'shopping' || picnic === undefined
        ? Promise.resolve(undefined)
        : viaPicnic
          ? api.picnicShoppingList(monday, sunday)
          : api.shoppingList(monday, sunday),
    [monday, tab, viaPicnic, picnic === undefined],
  );
  const [lessWaste, setLessWaste] = useState(() => {
    try {
      return localStorage.getItem('bendit.lessWaste') === '1';
    } catch {
      return false;
    }
  });
  const waste = useData(
    () =>
      tab === 'shopping' && viaPicnic && lessWaste
        ? api.picnicLessWaste(monday, sunday).then((r) => r.lines)
        : Promise.resolve(undefined),
    [monday, tab, viaPicnic, lessWaste],
  );
  const [planning, setPlanning] = useState<{ date: string; choice: Choice; servings: number } | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [choosing, setChoosing] = useState<ListItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const me = members.find((m) => m.username === session?.username)?.id;
  const latestWeight = weights?.length ? [...weights].sort((a, b) => b.date.localeCompare(a.date))[0].weightKg : undefined;
  const targets = macroTargets(profile);

  const shown = shopping && {
    ...shopping,
    items: shopping.items.map((i) => (i.key in checks ? { ...i, checked: checks[i.key] } : i)),
  };

  async function toggle(key: string, checked: boolean) {
    if (!shopping) return;
    setChecks((c) => ({ ...c, [key]: checked }));
    await api.setShoppingCheck(shopping.listKey, key, checked);
    // A ticked line is no longer bought, which changes the total and the suggestions.
    if (viaPicnic) bump();
  }

  function toggleLessWaste() {
    const next = !lessWaste;
    setLessWaste(next);
    try {
      localStorage.setItem('bendit.lessWaste', next ? '1' : '0');
    } catch {
      // Remembered for this visit only.
    }
  }

  async function choose(itemKey: string, p: PicnicListProduct) {
    await api.picnicChoose(itemKey, {
      id: p.productId,
      name: p.name,
      image_id: p.imageId ?? '',
      unit_quantity: p.unitQuantity ?? '',
      display_price: p.price ?? 0,
      max_count: 0,
    });
    bump();
  }

  /** The first day of the week, from today, with no dinner planned yet. */
  function freeDay() {
    const today = todayStr();
    const days = week.filter((d) => d >= today);
    return days.find((d) => !(items ?? []).some((i) => i.date === d && i.meal === 'dinner')) ?? days[0] ?? week[0];
  }

  async function addToCart() {
    // The cart is the household's, and it may already hold someone else's shopping.
    if (!window.confirm('Add the chosen products on this list to the Picnic cart?')) return;
    setNotice(null);
    try {
      const { added } = await api.picnicAddList(monday, sunday);
      setNotice(`Added ${added} to the Picnic cart.`);
      bump();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not add them.');
    }
  }

  return (
    <div className="pt-[env(safe-area-inset-top)] pb-4">
      <header className="flex items-center gap-1 px-2 py-3">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-ink-secondary hover:bg-card md:hidden"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <h1 className="flex-1 text-lg font-semibold md:px-2 lg:text-2xl lg:font-bold lg:tracking-tight">Plan</h1>
        <button
          type="button"
          aria-label="Previous week"
          onClick={() => setMonday(shiftDay(monday, -7))}
          className="rounded-full p-2 text-ink-secondary hover:bg-card"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <span className="text-sm font-medium tabular-nums">
          {format(parseISO(monday), 'd MMM')} – {format(parseISO(sunday), 'd MMM')}
        </span>
        <button
          type="button"
          aria-label="Next week"
          onClick={() => setMonday(shiftDay(monday, 7))}
          className="rounded-full p-2 text-ink-secondary hover:bg-card"
        >
          <ChevronRightIcon className="h-5 w-5" />
        </button>
      </header>

      <div className="mx-4 grid grid-cols-2 rounded-xl bg-card p-1 text-center text-xs font-semibold lg:mx-0">
        {(['week', 'shopping'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-lg py-2 ${tab === t ? 'bg-accent text-white' : 'text-ink-secondary'}`}
          >
            {t === 'week' ? 'Week' : 'Shopping list'}
          </button>
        ))}
      </div>

      {tab === 'week' ? (
        <div className="lg:mt-3 lg:grid lg:grid-cols-2 lg:gap-3">
          {week.map((date) => (
            <DayCard
              key={date}
              date={date}
              items={(items ?? []).filter((i) => i.date === date)}
              me={me}
              budget={computeBudget(profile, date, latestWeight).budget}
              targets={targets}
              onAdd={() => setAdding(date)}
              onOpen={setEditing}
            />
          ))}
        </div>
      ) : (
        <>
          {viaPicnic && (
            <div className="mx-4 mt-3 flex justify-end lg:mx-0">
              <button
                type="button"
                aria-pressed={lessWaste}
                onClick={toggleLessWaste}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  lessWaste ? 'bg-accent text-white' : 'bg-card text-ink-secondary'
                }`}
              >
                Less waste
              </button>
            </div>
          )}
          <div className={`${card} overflow-hidden`}>
            <ShoppingView
              list={shown}
              picnic={viaPicnic}
              waste={lessWaste ? waste : undefined}
              onToggle={toggle}
              onChoose={setChoosing}
              onAccept={(item) => item.suggestion && choose(item.key, item.suggestion)}
              onUse={(item, product) => choose(item.key, product)}
              onPlanRecipe={(r) =>
                setPlanning({
                  date: freeDay(),
                  choice: { kind: 'recipe', id: r.recipeId, name: r.name, servingLabel: '1 serving', calories: null },
                  servings: r.servings,
                })
              }
              onAddToCart={addToCart}
            />
          </div>
        </>
      )}
      {tab === 'shopping' && notice && (
        <p className="mx-4 mt-2 text-sm text-ink-secondary lg:mx-0">
          {notice}{' '}
          <Link to="/picnic" className="font-medium text-accent underline">
            Open the cart
          </Link>
        </p>
      )}
      {choosing && (
        <ProductPicker
          title={choosing.name}
          initial={choosing.name}
          onClose={() => setChoosing(null)}
          onPick={async (product) => {
            await api.picnicChoose(choosing.key, product);
            setChoosing(null);
            bump();
          }}
        />
      )}

      {planning && (
        <AddSheet
          date={planning.date}
          members={members}
          me={me}
          initial={planning}
          onClose={() => setPlanning(null)}
          onAdded={() => {
            setPlanning(null);
            bump();
          }}
        />
      )}
      {adding && (
        <AddSheet
          date={adding}
          members={members}
          me={me}
          onClose={() => setAdding(null)}
          onAdded={() => {
            setAdding(null);
            bump();
          }}
        />
      )}
      {editing && (
        <EditSheet
          item={editing}
          week={week}
          members={members}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setEditing(null);
            bump();
          }}
        />
      )}
    </div>
  );
}
