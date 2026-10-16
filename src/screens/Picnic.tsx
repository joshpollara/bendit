import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  api,
  ApiError,
  type PicnicCart,
  type PicnicCartArticle,
  type PicnicProduct,
  type PicnicProductDetails,
} from '../lib/api';
import { useData } from '../lib/useData';
import { ChevronLeftIcon, PlusIcon, SearchIcon } from '../components/Icons';
import Sheet from '../components/Sheet';

const euros = (cents: number) =>
  (cents / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });

const image = (id: string | undefined, size: 'small' | 'medium' = 'small') =>
  id ? `/api/picnic/images/${encodeURIComponent(id)}/${size}` : undefined;

const quantityOf = (article: PicnicCartArticle) =>
  article.decorators?.find((d) => d.type === 'QUANTITY')?.quantity ?? 1;

/** The search term, once typing has paused: every keystroke would be a request to Picnic. */
function useSettled(value: string, ms = 400) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function Thumb({ id, size = 'h-12 w-12' }: { id?: string; size?: string }) {
  return (
    <span className={`${size} shrink-0 overflow-hidden rounded-lg bg-white`}>
      {id && <img src={image(id)} alt="" loading="lazy" className="h-full w-full object-contain" />}
    </span>
  );
}

function ProductSheet({
  id,
  name,
  onClose,
  onAdd,
}: {
  id: string;
  name: string;
  onClose: () => void;
  onAdd: (id: string) => Promise<void>;
}) {
  const [product, setProduct] = useState<PicnicProductDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.picnicProduct(id, name).then(setProduct, (err) => setError(err.message));
  }, [id, name]);

  async function saveFood() {
    setBusy(true);
    setError(null);
    try {
      await api.picnicSaveFood(id, name);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose}>
      {error ? (
        <p className="text-sm text-over">{error}</p>
      ) : !product ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-3">
            <Thumb id={product.imageIds[0]} size="h-20 w-20" />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold leading-tight">{product.name || name}</h2>
              <p className="text-xs text-ink-muted">
                {[product.brand, product.unitQuantity, product.unitPrice].filter(Boolean).join(' · ')}
              </p>
              <p className="mt-1 font-semibold">{euros(product.displayPrice)}</p>
              {product.promotion && (
                <p className="text-xs font-medium text-good">{product.promotion.label}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onAdd(product.id).finally(() => setBusy(false));
            }}
            className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            Add to cart
          </button>
          {product.food ? (
            <div className="rounded-xl border border-line p-3">
              <p className="text-sm">
                <span className="font-semibold">{Math.round(product.food.kcal100)} kcal</span>
                <span className="text-ink-muted"> per 100 {product.food.basis}</span>
              </p>
              <p className="mb-2 text-xs text-ink-muted">
                Protein {product.food.protein100 ?? '—'} g · Carbs {product.food.carbs100 ?? '—'} g · Fat{' '}
                {product.food.fat100 ?? '—'} g
              </p>
              <button
                type="button"
                disabled={busy || saved}
                onClick={saveFood}
                className="w-full rounded-xl border border-line py-2 text-sm font-semibold text-ink-secondary disabled:opacity-60"
              >
                {saved ? 'In your foods' : 'Add to my foods'}
              </button>
            </div>
          ) : (
            <p className="text-xs text-ink-muted">No nutrition listed.</p>
          )}
          {product.allergens.length > 0 && (
            <p className="text-sm">
              <span className="font-medium">Allergens: </span>
              {product.allergens.join(', ')}
            </p>
          )}
          {product.infoSections.map((section) => (
            <details key={section.title} className="rounded-xl border border-line px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">{section.title}</summary>
              <p className="mt-2 whitespace-pre-line text-xs text-ink-secondary">{section.content}</p>
            </details>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function CartView({
  cart,
  onChange,
}: {
  cart: PicnicCart | undefined;
  onChange: (action: () => Promise<PicnicCart>) => Promise<void>;
}) {
  if (!cart) return <p className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</p>;
  const articles = cart.items.flatMap((line) => line.items);
  if (articles.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-ink-muted">The cart is empty.</p>;
  }
  return (
    <>
      <ul>
        {articles.map((article) => {
          const count = quantityOf(article);
          return (
            <li key={article.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5">
              <Thumb id={article.image_ids[0]} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{article.name}</span>
                <span className="block truncate text-xs text-ink-muted">
                  {article.unit_quantity} · {euros(article.price)}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`One fewer ${article.name}`}
                  onClick={() => onChange(() => api.picnicRemoveFromCart(article.id))}
                  className="h-8 w-8 rounded-lg border border-line text-ink-secondary"
                >
                  −
                </button>
                <span className="w-6 text-center text-sm tabular-nums">{count}</span>
                <button
                  type="button"
                  aria-label={`One more ${article.name}`}
                  disabled={count >= article.max_count}
                  onClick={() => onChange(() => api.picnicAddToCart(article.id))}
                  className="h-8 w-8 rounded-lg border border-line text-ink-secondary disabled:opacity-40"
                >
                  +
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Remove everything from the Picnic cart?')) void onChange(api.picnicClearCart);
          }}
          className="text-sm text-ink-muted hover:text-over"
        >
          Empty cart
        </button>
        <span className="text-sm">
          {cart.total_count} items · <span className="font-semibold">{euros(cart.checkout_total_price)}</span>
        </span>
      </div>
    </>
  );
}

export default function Picnic() {
  const navigate = useNavigate();
  const status = useData(() => api.picnicStatus(), []);
  const [tab, setTab] = useState<'search' | 'cart'>('search');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  const [cart, setCart] = useState<PicnicCart>();
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PicnicProduct[] | undefined>([]);

  const ready = status?.connected === true;
  const q = useSettled(query.trim());

  useEffect(() => {
    if (!ready || !q) return setResults([]);
    let alive = true;
    setResults(undefined);
    api.picnicSearch(q).then(
      (found) => alive && setResults(found),
      (err) => alive && (setError(err.message), setResults([])),
    );
    return () => {
      alive = false;
    };
  }, [ready, q]);

  useEffect(() => {
    if (ready) api.picnicCart().then(setCart, (err) => setError(err.message));
  }, [ready]);

  async function changeCart(action: () => Promise<PicnicCart>) {
    setError(null);
    try {
      setCart(await action());
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong.');
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
        <h1 className="text-lg font-semibold md:px-2 lg:text-2xl lg:font-bold lg:tracking-tight">Picnic</h1>
      </header>

      {status && !ready ? (
        <p className="mx-4 rounded-2xl border border-line bg-card p-4 text-sm text-ink-secondary lg:mx-0">
          {status.configured ? (
            <>
              Picnic isn't connected.{' '}
              <Link to="/settings" className="font-medium text-accent underline">
                Connect it in Settings
              </Link>
              .
            </>
          ) : (
            <>
              Picnic isn't set up on this server. Set <code className="text-xs">PICNIC_USERNAME</code> and{' '}
              <code className="text-xs">PICNIC_PASSWORD</code> to use it.
            </>
          )}
        </p>
      ) : (
        <>
          <div className="mx-4 grid grid-cols-2 rounded-xl bg-card p-1 text-center text-xs font-semibold lg:mx-0">
            {(['search', 'cart'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-lg py-2 ${tab === t ? 'bg-accent text-white' : 'text-ink-secondary'}`}
              >
                {t === 'search' ? 'Search' : `Cart${cart ? ` ${cart.total_count}` : ''}`}
              </button>
            ))}
          </div>

          {error && <p className="mx-4 mt-3 text-sm text-over lg:mx-0">{error}</p>}

          {tab === 'search' ? (
            <>
              <div className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-line bg-card px-3 lg:mx-0">
                <SearchIcon className="h-4 w-4 shrink-0 text-ink-muted" />
                <input
                  type="search"
                  placeholder="Search Picnic"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full bg-transparent py-2.5 text-sm outline-none"
                />
              </div>
              {q && (
                <div className="mx-4 mt-3 overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:mx-0">
                  {results === undefined ? (
                    <p className="px-4 py-6 text-center text-sm text-ink-muted">Searching…</p>
                  ) : results.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-ink-muted">Nothing found.</p>
                  ) : (
                    <ul>
                      {results.map((product) => (
                        <li
                          key={product.id}
                          className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
                        >
                          <button
                            type="button"
                            onClick={() => setOpen({ id: product.id, name: product.name })}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          >
                            <Thumb id={product.image_id} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{product.name}</span>
                              <span className="block truncate text-xs text-ink-muted">
                                {product.unit_quantity}
                              </span>
                            </span>
                            <span className="text-sm font-medium tabular-nums">
                              {euros(product.display_price)}
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Add ${product.name} to cart`}
                            onClick={() => changeCart(() => api.picnicAddToCart(product.id))}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white"
                          >
                            <PlusIcon className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="mx-4 mt-3 overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:mx-0">
              <CartView cart={cart} onChange={changeCart} />
            </div>
          )}
        </>
      )}

      {open && (
        <ProductSheet
          id={open.id}
          name={open.name}
          onClose={() => setOpen(null)}
          onAdd={async (id) => {
            await changeCart(() => api.picnicAddToCart(id));
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}
