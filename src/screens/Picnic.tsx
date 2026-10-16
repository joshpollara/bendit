import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  api,
  ApiError,
  type PicnicCart,
  type PicnicDelivery,
  type PicnicSlots,
  type PicnicCartArticle,
  type PicnicProduct,
  type PicnicProductDetails,
} from '../lib/api';
import { useData } from '../lib/useData';
import { ChevronLeftIcon, PlusIcon, SearchIcon } from '../components/Icons';
import Sheet from '../components/Sheet';
import { euros, Thumb, useSettled } from '../components/PicnicBits';
import CheckoutSheet from '../components/PicnicCheckout';

const quantityOf = (article: PicnicCartArticle) =>
  article.decorators?.find((d) => d.type === 'QUANTITY')?.quantity ?? 1;

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

const when = (iso: string | null | undefined, pattern = 'EEE d MMM HH:mm') =>
  iso ? format(parseISO(iso), pattern) : '—';
const windowText = (start: string | null | undefined, end: string | null | undefined) =>
  start ? `${when(start)}–${when(end, 'HH:mm')}` : '—';

/** The delivery slot the cart is booked into, and the ones it could move to. */
function SlotSection({ onChanged }: { onChanged: () => void }) {
  const [slots, setSlots] = useState<PicnicSlots>();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.picnicSlots().then(setSlots, (err) => setError(err.message));
  useEffect(() => {
    void load();
  }, []);

  const selected = slots?.selectedSlot;
  const available = (slots?.slots ?? []).filter((slot) => slot.isAvailable);
  const days = [...new Set(available.map((slot) => slot.windowStart.slice(0, 10)))];

  async function choose(slotId: string) {
    setError(null);
    try {
      await api.picnicSetSlot(slotId);
      setPicking(false);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the slot.');
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-ink-muted">Delivery</p>
        <p className="truncate text-sm font-medium">
          {!slots ? 'Loading…' : selected ? windowText(selected.windowStart, selected.windowEnd) : 'No slot chosen'}
          {selected && !selected.isExplicitSelection && (
            <span className="ml-1 font-normal text-ink-muted">(Picnic's pick)</span>
          )}
        </p>
        {error && <p className="text-xs text-over">{error}</p>}
      </div>
      {available.length > 0 && (
        <button type="button" onClick={() => setPicking(true)} className="text-sm font-semibold text-accent">
          Change
        </button>
      )}
      {picking && (
        <Sheet onClose={() => setPicking(false)}>
          <h2 className="mb-3 text-lg font-semibold">Delivery slot</h2>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto">
            {days.map((day) => (
              <div key={day}>
                <p className="mb-1 text-xs font-semibold text-ink-muted">{when(day, 'EEEE d MMMM')}</p>
                <div className="grid grid-cols-2 gap-2">
                  {available
                    .filter((slot) => slot.windowStart.startsWith(day))
                    .map((slot) => (
                      <button
                        key={slot.slotId}
                        type="button"
                        onClick={() => choose(slot.slotId)}
                        className={`rounded-xl border px-3 py-2 text-left text-sm ${
                          slot.slotId === selected?.slotId
                            ? 'border-accent bg-accent-soft text-accent'
                            : 'border-line'
                        }`}
                      >
                        <span className="block tabular-nums">
                          {when(slot.windowStart, 'HH:mm')}–{when(slot.windowEnd, 'HH:mm')}
                        </span>
                        {slot.minimumOrderValue != null && (
                          <span className="block text-xs text-ink-muted">
                            Minimum {euros(slot.minimumOrderValue)}
                          </span>
                        )}
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  CURRENT: 'Upcoming',
  IN_PROGRESS: 'On its way',
  COMPLETED: 'Delivered',
  CANCELLED: 'Cancelled',
};

function DeliverySheet({ id, onClose }: { id: string; onClose: () => void }) {
  const [delivery, setDelivery] = useState<PicnicDelivery>();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  useEffect(() => {
    api.picnicDelivery(id).then(setDelivery, (err) => setError(err.message));
  }, [id]);

  async function act(action: () => Promise<unknown>, done: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <Sheet onClose={onClose}>
      {error ? (
        <p className="text-sm text-over">{error}</p>
      ) : !delivery ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">{STATUS_LABEL[delivery.status] ?? delivery.status}</h2>
            <p className="text-sm text-ink-secondary">
              {delivery.status === 'COMPLETED' && delivery.delivered
                ? `Delivered ${when(delivery.delivered.start)}`
                : `Slot ${windowText(delivery.window.start, delivery.window.end)}`}
            </p>
            {delivery.position ? (
              <p className="text-sm font-medium text-accent">
                Expected {when(new Date(delivery.position.eta).toISOString(), 'HH:mm')}
              </p>
            ) : (
              delivery.status !== 'COMPLETED' &&
              delivery.eta && (
                <p className="text-sm text-ink-secondary">Expected {windowText(delivery.eta.start, delivery.eta.end)}</p>
              )
            )}
          </div>
          {delivery.status === 'COMPLETED' && (
            <div>
              <p className="mb-1 text-xs font-medium text-ink-muted">Rate this delivery</p>
              <div className="grid grid-cols-11 gap-0.5">
                {Array.from({ length: 11 }, (_, n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setRating(n);
                      void act(() => api.picnicRate(delivery.id, n), `Rated ${n} out of 10.`);
                    }}
                    className={`rounded-md py-1.5 text-xs tabular-nums ${
                      rating === n ? 'bg-accent text-white' : 'bg-surface text-ink-secondary'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            {delivery.status === 'COMPLETED' && (
              <button
                type="button"
                onClick={() => act(() => api.picnicEmailInvoice(delivery.id), 'Picnic is emailing the invoice.')}
                className="flex-1 rounded-xl border border-line py-2 text-sm font-semibold text-ink-secondary"
              >
                Email invoice
              </button>
            )}
            {delivery.status === 'CURRENT' && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Cancel this delivery?')) {
                    void act(() => api.picnicCancelDelivery(delivery.id), 'Delivery cancelled.');
                  }
                }}
                className="flex-1 rounded-xl border border-line py-2 text-sm font-semibold text-over"
              >
                Cancel delivery
              </button>
            )}
          </div>
          {notice && <p className="text-sm text-good">{notice}</p>}
          {error && <p className="text-sm text-over">{error}</p>}
          <ul className="max-h-[45vh] divide-y divide-line overflow-y-auto">
            {delivery.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2">
                <Thumb id={item.imageId} size="h-10 w-10" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{item.name}</span>
                  <span className="block truncate text-xs text-ink-muted">{item.unitQuantity}</span>
                </span>
                <span className="text-sm tabular-nums text-ink-secondary">× {item.quantity}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
}

function PaymentsView() {
  const [page, setPage] = useState(1);
  const payments = useData(() => api.picnicWallet(page), [page]);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useData(() => (open ? api.picnicWalletDetail(open) : Promise.resolve(null)), [open]);
  if (!payments) return <p className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</p>;
  return (
    <>
      <ul>
        {payments.map((p) => (
          <li key={p.id} className="border-b border-line last:border-b-0">
            <button
              type="button"
              onClick={() => setOpen(p.id)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {format(new Date(p.timestamp), 'EEE d MMM yyyy')}
                </span>
                <span className="block truncate text-xs text-ink-muted">
                  {p.display_name}
                  {p.account ? ` ${p.account}` : ''} · {p.status === 'PAID' ? 'Paid' : p.status.toLowerCase()}
                </span>
              </span>
              <span className={`text-sm tabular-nums ${p.transaction_type === 'REFUND' ? 'text-good' : ''}`}>
                {p.transaction_type === 'REFUND' ? '+' : ''}
                {euros(p.amount_in_cents)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-between px-4 py-2.5 text-sm">
        <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)} className="text-accent disabled:opacity-30">
          Newer
        </button>
        <button
          type="button"
          disabled={payments.length === 0}
          onClick={() => setPage(page + 1)}
          className="text-accent disabled:opacity-30"
        >
          Older
        </button>
      </div>
      {open && (
        <Sheet onClose={() => setOpen(null)}>
          <h2 className="mb-3 text-lg font-semibold">Payment</h2>
          {!detail ? (
            <p className="text-sm text-ink-muted">Loading…</p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
              {detail.lines.map((line, i) => (
                <li key={i} className="flex items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{line.name}</span>
                  <span className="text-ink-muted">× {line.quantity}</span>
                  <span className="w-16 text-right tabular-nums">{line.price != null ? euros(line.price) : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </Sheet>
      )}
    </>
  );
}

function OrdersView() {
  const [view, setView] = useState<'deliveries' | 'payments'>('deliveries');
  return (
    <>
      <div className="grid grid-cols-2 border-b border-line text-center text-xs font-semibold">
        {(['deliveries', 'payments'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`py-2.5 ${view === v ? 'text-accent' : 'text-ink-muted'}`}
          >
            {v === 'deliveries' ? 'Deliveries' : 'Payments'}
          </button>
        ))}
      </div>
      {view === 'deliveries' ? <DeliveriesView /> : <PaymentsView />}
    </>
  );
}

function DeliveriesView() {
  const deliveries = useData(() => api.picnicDeliveries(), []);
  const [open, setOpen] = useState<string | null>(null);
  if (!deliveries) return <p className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</p>;
  if (deliveries.length === 0) return <p className="px-4 py-6 text-center text-sm text-ink-muted">No orders yet.</p>;
  return (
    <>
      <ul>
        {deliveries.map((d) => (
          <li key={d.id} className="border-b border-line last:border-b-0">
            <button
              type="button"
              onClick={() => setOpen(d.id)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{windowText(d.windowStart, d.windowEnd)}</span>
                <span className="block text-xs text-ink-muted">{STATUS_LABEL[d.status] ?? d.status}</span>
              </span>
              <span className="text-sm tabular-nums text-ink-secondary">{euros(d.totalPrice)}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && <DeliverySheet id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export default function Picnic() {
  const navigate = useNavigate();
  const status = useData(() => api.picnicStatus(), []);
  const [params] = useSearchParams();
  const [tab, setTab] = useState<'search' | 'cart' | 'orders'>(() =>
    params.get('tab') === 'cart' ? 'cart' : params.get('tab') === 'orders' ? 'orders' : 'search',
  );
  const [checkingOut, setCheckingOut] = useState(false);
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
        <h1 className="flex-1 text-lg font-semibold md:px-2 lg:text-2xl lg:font-bold lg:tracking-tight">Picnic</h1>
        {status?.connected && (
          <Link
            to="/picnic/new"
            className="rounded-full bg-accent px-3.5 py-1.5 text-sm font-semibold text-white"
          >
            New order
          </Link>
        )}
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
          <div className="mx-4 grid grid-cols-3 rounded-xl bg-card p-1 text-center text-xs font-semibold lg:mx-0">
            {(['search', 'cart', 'orders'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-lg py-2 ${tab === t ? 'bg-accent text-white' : 'text-ink-secondary'}`}
              >
                {t === 'search' ? 'Search' : t === 'orders' ? 'Orders' : `Cart${cart ? ` ${cart.total_count}` : ''}`}
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
          ) : tab === 'cart' ? (
            <div className="mx-4 mt-3 overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:mx-0">
              <SlotSection onChanged={() => api.picnicCart().then(setCart)} />
              <CartView cart={cart} onChange={changeCart} />
              {cart && cart.total_count > 0 && (
                <div className="border-t border-line p-3">
                  <button
                    type="button"
                    onClick={() => setCheckingOut(true)}
                    className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white"
                  >
                    Check out · {euros(cart.checkout_total_price)}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="mx-4 mt-3 overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:mx-0">
              <OrdersView />
            </div>
          )}
        </>
      )}

      {checkingOut && <CheckoutSheet onClose={() => setCheckingOut(false)} />}
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
