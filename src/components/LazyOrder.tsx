import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type LazyOrder as Order, type LazyOrderRecipe, type PicnicOrderItem } from '../lib/api';
import { useData } from '../lib/useData';
import Sheet from './Sheet';
import { SparkleIcon } from './Icons';
import { Thumb } from './PicnicBits';

// "Make me an order": the due usuals and a few new recipes from the
// household's sites, picked by AI, with their ingredients as Picnic products.
// It's a preview: nothing is kept until the draft is added to the Picnic cart,
// when the recipes are saved and planned (see PicnicNewOrder).

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="flex-1 text-ink-secondary">{label}</span>
      <button
        type="button"
        aria-label={`Fewer ${label.toLowerCase()}`}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="h-8 w-8 rounded-lg border border-line"
      >
        −
      </button>
      <span className="w-6 text-center tabular-nums">{value}</span>
      <button
        type="button"
        aria-label={`More ${label.toLowerCase()}`}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="h-8 w-8 rounded-lg border border-line"
      >
        +
      </button>
    </div>
  );
}

export default function LazyOrder({
  onAdd,
  onClose,
}: {
  /** The items for the draft, and the recipes to save and plan when it reaches the cart. */
  onAdd: (items: PicnicOrderItem[], recipes: LazyOrderRecipe[], plan: boolean) => void;
  onClose: () => void;
}) {
  const members = useData(() => api.household(), []);
  const [dinners, setDinners] = useState(3);
  const [servings, setServings] = useState<number | null>(null);
  const [wish, setWish] = useState('');
  const [order, setOrder] = useState<Order | null>(null);
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [droppedItems, setDroppedItems] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = servings ?? Math.max(1, members?.length ?? 2);
  const recipes = (order?.recipes ?? []).filter((r) => !dropped.has(r.url));
  const keptTitles = new Set(recipes.map((r) => r.title));
  // An item stays if it's a usual or any recipe still in the order needs it.
  const items = (order?.items ?? []).filter(
    (i) => !droppedItems.has(i.productId) && i.for.some((f) => f === 'Usual' || keptTitles.has(f)),
  );
  const count = items.reduce((sum, i) => sum + i.quantity, 0);
  const usualCount = items.filter((i) => i.for.includes('Usual')).length;

  async function make() {
    setBusy(true);
    setError(null);
    try {
      setOrder(await api.picnicLazyOrder({ dinners, servings: people, wish: wish.trim() }));
      setDropped(new Set());
      setDroppedItems(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't put an order together.");
    } finally {
      setBusy(false);
    }
  }

  function accept() {
    onAdd(
      items.map(({ for: _for, ...item }) => item),
      recipes,
      plan,
    );
  }

  return (
    <Sheet onClose={onClose}>
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <SparkleIcon className="h-5 w-5 text-accent" />
        Make me an order
      </h2>

      {!order ? (
        <div className="mt-3 space-y-3">
          <Stepper label="Dinners" value={dinners} min={0} max={7} onChange={setDinners} />
          {dinners > 0 && <Stepper label="Servings each" value={people} min={1} max={12} onChange={setServings} />}
          {dinners > 0 && (
            <input
              className="w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm"
              placeholder="Anything in mind? Quick, fish, vegetarian…"
              value={wish}
              onChange={(e) => setWish(e.target.value)}
            />
          )}
          {error && <p className="text-sm text-over">{error}</p>}
          <button
            type="button"
            disabled={busy}
            onClick={() => void make()}
            className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Picking recipes and products…' : 'Make my order'}
          </button>
        </div>
      ) : (
        <div className="mt-3">
          {!order.usingSites && dinners > 0 && (
            <p className="mb-2 rounded-xl bg-surface px-3 py-2 text-xs text-ink-secondary">
              No new recipes: follow some recipe sites on{' '}
              <Link to="/recipes" className="font-medium text-accent underline">
                Recipes
              </Link>{' '}
              first.
            </p>
          )}
          {recipes.length > 0 && (
            <ul className="mb-3 divide-y divide-line">
              {recipes.map((r) => (
                <li key={r.url} className="flex items-center gap-3 py-2">
                  {r.image ? (
                    <img src={r.image} alt="" className="h-12 w-12 shrink-0 rounded-lg bg-surface object-cover" />
                  ) : (
                    <span className="h-12 w-12 shrink-0 rounded-lg bg-surface" />
                  )}
                  <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.title}</span>
                    <span className="line-clamp-2 text-xs text-ink-muted">
                      {r.reason} · {r.site}
                    </span>
                  </a>
                  <button
                    type="button"
                    aria-label={`Leave out ${r.title}`}
                    onClick={() => setDropped((d) => new Set(d).add(r.url))}
                    className="shrink-0 rounded-full px-2 py-1 text-ink-muted hover:bg-surface"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-ink-secondary">
            {count} {count === 1 ? 'item' : 'items'}: {usualCount} {usualCount === 1 ? 'usual' : 'usuals'}
            {recipes.length > 0 ? `, ${items.length - usualCount} for the recipes` : ''}
          </p>
          <ul className="mt-1 max-h-[32vh] divide-y divide-line overflow-y-auto">
            {items.map((item) => (
              <li key={item.productId} className="flex items-center gap-2 py-1.5">
                <Thumb id={item.imageId} size="h-8 w-8" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {item.quantity} × {item.name}
                  </span>
                  <span className="block truncate text-xs text-ink-muted">
                    {[item.unitQuantity, item.for.filter((f) => f === 'Usual' || keptTitles.has(f)).join(', ')]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Leave out ${item.name}`}
                  onClick={() => setDroppedItems((d) => new Set(d).add(item.productId))}
                  className="shrink-0 rounded-full px-2 py-1 text-ink-muted hover:bg-surface"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {recipes.length > 0 && (
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={plan}
                onChange={(e) => setPlan(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Put the recipes on the plan
            </label>
          )}
          {error && <p className="mt-2 text-sm text-over">{error}</p>}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setOrder(null)}
              className="rounded-xl border border-line px-4 py-3 text-sm font-semibold text-ink-secondary"
            >
              Again
            </button>
            <button
              type="button"
              disabled={busy || items.length === 0}
              onClick={() => void accept()}
              className="flex-1 rounded-xl bg-accent py-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              Add {count} to my order
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
