import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type PicnicListProduct, type RecipeShopping } from '../lib/api';
import { useData } from '../lib/useData';
import { useUI } from '../store/ui';
import Sheet from './Sheet';
import { euros, ProductPicker, Thumb } from './PicnicBits';

// Buying one recipe's ingredients at Picnic, without planning it first. Each
// line's product is the household's pick for it, shared with the plan's list;
// a line with only Picnic's suggestion needs a "Use" before it's bought.

type Line = RecipeShopping['items'][number];

const amountOf = (line: Line) =>
  [
    line.grams != null ? (line.grams >= 1000 ? `${Math.round(line.grams / 100) / 10} kg` : `${line.grams} g`) : null,
    ...line.written,
  ]
    .filter(Boolean)
    .join(' + ');

const asPicnicProduct = (p: PicnicListProduct) => ({
  id: p.productId,
  name: p.name,
  image_id: p.imageId ?? '',
  unit_quantity: p.unitQuantity ?? '',
  display_price: p.price ?? 0,
  max_count: 0,
});

export default function RecipeShop({
  recipe,
  onClose,
}: {
  recipe: { id: string; name: string; servings: number };
  onClose: () => void;
}) {
  const bump = useUI((s) => s.bump);
  const [servings, setServings] = useState(recipe.servings);
  const list = useData(() => api.picnicRecipeShopping(recipe.id, servings), [recipe.id, servings]);
  // Lines someone said are already in the cupboard; staples start that way.
  const [have, setHave] = useState<Record<string, boolean>>({});
  const [choosing, setChoosing] = useState<Line | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const has = (line: Line) => have[line.key] ?? line.staple;
  const lines = list?.items ?? [];
  const buying = lines.filter((l) => !has(l) && l.choice);
  const suggested = lines.filter((l) => !has(l) && !l.choice && l.suggestion);
  const count = buying.reduce((sum, l) => sum + (l.packs ?? 1), 0);
  const total = buying.reduce((sum, l) => sum + (l.choice?.price ?? 0) * (l.packs ?? 1), 0);

  async function choose(line: Line, product: PicnicListProduct) {
    await api.picnicChoose(line.key, asPicnicProduct(product));
  }

  async function useAll() {
    setBusy(true);
    try {
      for (const line of suggested) await choose(line, line.suggestion!);
      bump();
    } finally {
      setBusy(false);
    }
  }

  async function addToCart() {
    setBusy(true);
    setError(null);
    try {
      await api.picnicAddBulk(buying.map((l) => ({ productId: l.choice!.productId, quantity: l.packs ?? 1 })));
      setDone(`Added ${count} to the Picnic cart.`);
      bump();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add them.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Sheet onClose={onClose}>
        <h2 className="text-lg font-semibold">{recipe.name}</h2>
        <div className="mt-2 flex items-center gap-2 text-sm text-ink-secondary">
          <span className="flex-1">Servings</span>
          <button
            type="button"
            aria-label="Fewer servings"
            onClick={() => setServings((n) => Math.max(1, n - 1))}
            className="h-8 w-8 rounded-lg border border-line"
          >
            −
          </button>
          <span className="w-6 text-center tabular-nums">{servings}</span>
          <button
            type="button"
            aria-label="More servings"
            onClick={() => setServings((n) => Math.min(50, n + 1))}
            className="h-8 w-8 rounded-lg border border-line"
          >
            +
          </button>
        </div>

        {list === undefined ? (
          <p className="py-6 text-center text-sm text-ink-muted">Finding products…</p>
        ) : (
          <ul className="mt-2 max-h-[52vh] divide-y divide-line overflow-y-auto">
            {lines.map((line) => {
              const product = line.choice ?? line.suggestion;
              const inCupboard = has(line);
              return (
                <li key={line.key} className="py-2">
                  <label className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={!inCupboard}
                      onChange={(e) => setHave((h) => ({ ...h, [line.key]: !e.target.checked }))}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <span
                      className={`min-w-0 flex-1 truncate text-sm ${inCupboard ? 'text-ink-muted' : 'font-medium'}`}
                    >
                      {line.name}
                    </span>
                    <span className="text-xs tabular-nums text-ink-muted">
                      {inCupboard ? 'have it' : amountOf(line)}
                    </span>
                  </label>
                  {!inCupboard && (
                    <div className="mt-1 flex items-center gap-2 pl-7">
                      {product ? (
                        <>
                          <Thumb id={product.imageId} size="h-8 w-8" />
                          <span className="min-w-0 flex-1 text-xs">
                            <span className="block truncate text-ink-secondary">
                              {line.packs ?? 1} × {product.name}
                            </span>
                            <span className="block truncate text-ink-muted">
                              {product.unitQuantity}
                              {product.price != null ? ` · ${euros(product.price * (line.packs ?? 1))}` : ''}
                              {!line.choice ? ' · suggested' : ''}
                            </span>
                          </span>
                        </>
                      ) : (
                        <span className="flex-1 text-xs text-ink-muted">No Picnic product found.</span>
                      )}
                      {!line.choice && line.suggestion && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            await choose(line, line.suggestion!);
                            bump();
                          }}
                          className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent"
                        >
                          Use
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setChoosing(line)}
                        className="text-xs font-semibold text-accent"
                      >
                        {product ? 'Change' : 'Choose'}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {suggested.length > 1 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void useAll()}
            className="mt-2 w-full rounded-xl border border-accent py-2 text-sm font-semibold text-accent disabled:opacity-50"
          >
            Use all {suggested.length} suggestions
          </button>
        )}
        {error && <p className="mt-2 text-sm text-over">{error}</p>}
        {done ? (
          <p className="mt-3 text-sm text-ink-secondary">
            {done}{' '}
            <Link to="/picnic?tab=cart" className="font-medium text-accent underline">
              Open the cart
            </Link>
          </p>
        ) : (
          <button
            type="button"
            disabled={busy || buying.length === 0}
            onClick={() => void addToCart()}
            className="mt-3 w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            Add {count} to Picnic cart{buying.length ? ` · ${euros(total)}` : ''}
          </button>
        )}
      </Sheet>
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
    </>
  );
}
