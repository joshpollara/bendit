import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format, parseISO, startOfWeek } from 'date-fns';
import {
  api,
  type NutriGrade,
  type LazyOrderRecipe,
  type PicnicDeal,
  type PicnicNutriCheck,
  type PicnicOrderItem,
  type PicnicPastOrder,
  type PicnicPriceCheck,
} from '../lib/api';
import { useData } from '../lib/useData';
import { DAY, shiftDay, todayStr } from '../lib/dates';
import { ChevronLeftIcon, SparkleIcon } from '../components/Icons';
import LazyOrder from '../components/LazyOrder';
import { euros, Thumb } from '../components/PicnicBits';
import Sheet from '../components/Sheet';
import { GRADE_STYLE } from '../components/MealGrade';

// Building the next Picnic order from what's usually bought, a past order, or
// the meal plan, then adding it to the cart in one go. The draft lives on this
// device until it's added.

type Draft = Record<string, PicnicOrderItem>;
const DRAFT_KEY = 'bendit.picnicDraft';

function loadDraft(): Draft {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveDraft(draft: Draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // A draft that can't be kept still works for this visit.
  }
}

/** Recipes from "Make me an order", saved and planned once the draft reaches the cart. */
type Pending = { recipes: LazyOrderRecipe[]; plan: boolean };
const PENDING_KEY = 'bendit.picnicDraftRecipes';

function loadPending(): Pending {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') ?? { recipes: [], plan: false };
  } catch {
    return { recipes: [], plan: false };
  }
}

function savePending(pending: Pending) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Kept for this visit only.
  }
}

function Stepper({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        aria-label={`One fewer ${label}`}
        onClick={() => onChange(value - 1)}
        className="h-8 w-8 rounded-lg border border-line text-ink-secondary"
      >
        −
      </button>
      <span className="w-6 text-center text-sm tabular-nums">{value}</span>
      <button
        type="button"
        aria-label={`One more ${label}`}
        onClick={() => onChange(value + 1)}
        className="h-8 w-8 rounded-lg border border-line text-ink-secondary"
      >
        +
      </button>
    </span>
  );
}

function Grade({ grade }: { grade: NutriGrade }) {
  return (
    <span
      title={`Nutri-Score ${grade}`}
      className={`mr-1.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded align-[-2px] text-[10px] font-bold ${GRADE_STYLE[grade]}`}
    >
      {grade}
    </span>
  );
}

/** A product row: in the draft it shows a stepper, otherwise an add button. */
function ProductRow({
  item,
  detail,
  badge,
  grade,
  draft,
  setQuantity,
  children,
}: {
  item: PicnicOrderItem;
  detail?: string;
  badge?: string;
  grade?: NutriGrade | null;
  draft: Draft;
  setQuantity: (item: PicnicOrderItem, quantity: number) => void;
  children?: React.ReactNode;
}) {
  const inDraft = draft[item.productId];
  return (
    <li className="border-b border-line px-4 py-2 last:border-b-0">
      <div className="flex items-center gap-3">
        <Thumb id={item.imageId} size="h-10 w-10" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {grade && <Grade grade={grade} />}
            {item.name}
          </span>
          <span className="block truncate text-xs text-ink-muted">
            {badge && <span className="mr-1 font-semibold text-accent">{badge}</span>}
            {[detail, item.unitQuantity].filter(Boolean).join(' · ')}
          </span>
        </span>
        {inDraft ? (
          <Stepper label={item.name} value={inDraft.quantity} onChange={(n) => setQuantity(item, n)} />
        ) : (
          <button
            type="button"
            onClick={() => setQuantity(item, item.quantity)}
            className="shrink-0 rounded-full bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent"
          >
            Add {item.quantity > 1 ? item.quantity : ''}
          </button>
        )}
      </div>
      {children}
    </li>
  );
}

/** How often, in the words a person would use. */
const howOften = (days: number | null) =>
  days == null ? 'once' : days <= 9 ? 'weekly' : days <= 16 ? 'every 2 weeks' : days <= 23 ? 'every 3 weeks' : `every ~${Math.round(days / 7)} weeks`;

/** "400 gram" → 400, "1,5 liter" → 1500, "6 x 330 ml" → 1980; null for "4 stuks". */
function packGrams(unitQuantity: string | null) {
  const match = (unitQuantity ?? '')
    .toLowerCase()
    .match(/(?:(\d+)\s*x\s*)?(\d+(?:[.,]\d+)?)\s*(kg|kilo|gram|g|liter|l|ml|cl)\b/);
  if (!match) return null;
  const scale = { kg: 1000, kilo: 1000, gram: 1, g: 1, liter: 1000, l: 1000, ml: 1, cl: 10 }[match[3]] ?? 1;
  return Number(match[1] ?? 1) * Number(match[2].replace(',', '.')) * scale;
}

/** How many of a swap make up what was ordered: 4 × 95 g is 2 × 200 g. */
function swapCount(item: PicnicOrderItem, to: { unitQuantity: string | null }) {
  const from = packGrams(item.unitQuantity);
  const into = packGrams(to.unitQuantity);
  return from && into ? Math.max(1, Math.round((item.quantity * from) / into)) : item.quantity;
}

/** "€2.01, was €2.69" for a reduction; "€2.99 each" for a multi-buy. */
const dealPrice = (deal: PicnicDeal, price: number | null) =>
  deal.was != null && deal.price != null
    ? `${euros(deal.price)}, was ${euros(deal.was)}`
    : price != null
      ? `${euros(price)} each`
      : '';

const card = 'mx-4 mt-3 overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:mx-0';
const orderDate = (o: PicnicPastOrder) => format(parseISO(o.windowStart), 'EEE d MMM');

export default function PicnicNewOrder() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'usuals' | 'deals' | 'past' | 'plan'>('usuals');
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [refresh, setRefresh] = useState(0);
  const data = useData(() => api.picnicNewOrder(refresh > 0), [refresh]);
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [lazy, setLazy] = useState(false);
  const [pending, setPending] = useState<Pending>(loadPending);
  useEffect(() => savePending(pending), [pending]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Nutri-Score of what's in the draft, once someone asks for it.
  const [checked, setChecked] = useState<Record<string, PicnicNutriCheck>>({});
  const [checking, setChecking] = useState(false);
  // Prices and deals for what's in the draft, at the quantity they were checked for.
  const [prices, setPrices] = useState<Record<string, PicnicPriceCheck & { quantity: number }>>({});
  const [pricing, setPricing] = useState(false);
  const deals = useData(() => (tab === 'deals' ? api.picnicDeals() : Promise.resolve(undefined)), [tab]);

  // The plan's shopping list, this week or next.
  const [planWeek, setPlanWeek] = useState(0);
  const monday = shiftDay(format(startOfWeek(parseISO(todayStr()), { weekStartsOn: 1 }), DAY), planWeek * 7);
  const planList = useData(
    () => (tab === 'plan' ? api.picnicShoppingList(monday, shiftDay(monday, 6)) : Promise.resolve(undefined)),
    [tab, monday],
  );

  useEffect(() => saveDraft(draft), [draft]);

  const items = Object.values(draft);
  const count = items.reduce((sum, i) => sum + i.quantity, 0);

  function setQuantity(item: PicnicOrderItem, quantity: number) {
    setDraft((current) => {
      const next = { ...current };
      if (quantity <= 0) delete next[item.productId];
      else next[item.productId] = { ...item, quantity };
      return next;
    });
  }

  /** Adds products to the draft, adding to the count of any already in it. */
  function addAll(list: PicnicOrderItem[]) {
    setDraft((current) => {
      const next = { ...current };
      for (const item of list) {
        next[item.productId] = { ...item, quantity: (next[item.productId]?.quantity ?? 0) + item.quantity };
      }
      return next;
    });
  }

  const unchecked = items.filter((i) => !checked[i.productId]);
  const swappable = items.some((i) => checked[i.productId]?.swaps.length);

  async function checkNutriScore() {
    setChecking(true);
    setError(null);
    try {
      const { results } = await api.picnicNutriCheck(unchecked.map((i) => ({ productId: i.productId, name: i.name })));
      setChecked((current) => ({
        ...current,
        ...Object.fromEntries(results.map((r) => [r.productId, r])),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check them.');
    } finally {
      setChecking(false);
    }
  }

  const priced = (i: PicnicOrderItem) => (prices[i.productId]?.quantity === i.quantity ? prices[i.productId] : null);
  const unpriced = items.filter((i) => !priced(i));
  const pricedItems = items.map(priced).filter((p): p is NonNullable<typeof p> => p != null);
  const estimate = pricedItems.reduce((sum, p) => sum + (p.cost ?? 0), 0);
  const dealSavings = pricedItems.reduce((sum, p) => sum + p.saves, 0);
  const couldSave = pricedItems.reduce((sum, p) => sum + (p.cheaper[0]?.saves ?? 0), 0);

  async function checkPrices() {
    setPricing(true);
    setError(null);
    try {
      const { results } = await api.picnicPriceCheck(unpriced);
      const quantities = new Map(unpriced.map((i) => [i.productId, i.quantity]));
      setPrices((current) => ({
        ...current,
        ...Object.fromEntries(results.map((r) => [r.productId, { ...r, quantity: quantities.get(r.productId) ?? 0 }])),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check prices.');
    } finally {
      setPricing(false);
    }
  }

  /** Puts a swap in an item's place: the same weight where both packs say, else the same count. */
  function swap(item: PicnicOrderItem, to: PicnicNutriCheck['swaps'][number] | PicnicPriceCheck['cheaper'][number]) {
    setDraft((current) => {
      const next: Draft = {};
      for (const [id, entry] of Object.entries(current)) {
        if (id === to.productId) continue;
        if (id !== item.productId) next[id] = entry;
        else
          next[to.productId] = {
            productId: to.productId,
            name: to.name,
            imageId: to.imageId,
            unitQuantity: to.unitQuantity,
            quantity: ('quantity' in to ? to.quantity : swapCount(entry, to)) + (current[to.productId]?.quantity ?? 0),
          };
      }
      return next;
    });
    if ('grade' in to) {
      setChecked((current) => ({
        ...current,
        [to.productId]: { productId: to.productId, grade: to.grade, swaps: [] },
      }));
    }
  }

  function clearDraft() {
    setDraft({});
    setPending({ recipes: [], plan: false });
  }

  async function addToCart() {
    setBusy(true);
    setError(null);
    try {
      await api.picnicAddBulk(items.map((i) => ({ productId: i.productId, quantity: i.quantity })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add them.');
      setBusy(false);
      return;
    }
    // Now the recipes are being bought for: save and plan the ones whose
    // products are still in the order.
    const keep = pending.recipes.filter((r) => r.matched.length === 0 || r.matched.some((m) => draft[m.productId]));
    let kept: string | null = null;
    if (keep.length > 0) {
      try {
        await api.picnicKeepRecipes(keep, pending.plan);
      } catch (err) {
        kept = `Added to the cart, but the recipes weren't saved: ${err instanceof Error ? err.message : 'try again'}`;
      }
    }
    clearDraft();
    if (kept) window.alert(kept);
    navigate('/picnic?tab=cart');
  }

  const due = (data?.usuals ?? []).filter((u) => u.due);
  const planItems: PicnicOrderItem[] = useMemo(
    () =>
      (planList?.items ?? [])
        .filter((i) => !i.checked && i.choice)
        .map((i) => ({
          productId: i.choice!.productId,
          name: i.choice!.name,
          unitQuantity: i.choice!.unitQuantity,
          imageId: i.choice!.imageId,
          quantity: i.packs ?? 1,
        })),
    [planList],
  );
  const unchosen = (planList?.items ?? []).filter((i) => !i.checked && !i.choice).length;

  return (
    <div className="pt-[env(safe-area-inset-top)] pb-28 md:pb-20">
      <header className="flex items-center gap-1 px-2 py-3">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-ink-secondary hover:bg-card"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <h1 className="flex-1 text-lg font-semibold md:px-2 lg:text-2xl lg:font-bold lg:tracking-tight">New order</h1>
        {items.length > 0 && (
          <button type="button" onClick={clearDraft} className="px-3 text-sm text-ink-muted">
            Clear
          </button>
        )}
      </header>

      <button
        type="button"
        onClick={() => setLazy(true)}
        className="mx-4 mb-3 flex w-[calc(100%-2rem)] items-center justify-center gap-2 rounded-2xl border border-accent bg-accent-soft py-3 text-sm font-semibold text-accent lg:mx-0 lg:w-full"
      >
        <SparkleIcon className="h-4 w-4" />
        Make me an order
      </button>

      <div className="mx-4 grid grid-cols-4 rounded-xl bg-card p-1 text-center text-xs font-semibold lg:mx-0">
        {(['usuals', 'deals', 'past', 'plan'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-lg py-2 ${tab === t ? 'bg-accent text-white' : 'text-ink-secondary'}`}
          >
            {t === 'usuals' ? 'Usuals' : t === 'deals' ? 'Deals' : t === 'past' ? 'Past orders' : 'From plan'}
          </button>
        ))}
      </div>

      {tab === 'deals' ? (
        deals === undefined ? (
          <p className="mx-4 mt-6 text-center text-sm text-ink-muted">Checking this week's deals…</p>
        ) : deals.usuals.length === 0 ? (
          <p className="mx-4 mt-6 text-center text-sm text-ink-muted">None of your usuals are on a deal this week.</p>
        ) : (
          <ul className={card}>
            {deals.usuals.map((u) => (
              <ProductRow
                key={u.productId}
                item={u}
                badge={u.deal.label}
                detail={dealPrice(u.deal, u.price)}
                draft={draft}
                setQuantity={setQuantity}
              />
            ))}
          </ul>
        )
      ) : tab !== 'plan' && !data ? (
        <p className="mx-4 mt-6 text-center text-sm text-ink-muted">Reading your past orders…</p>
      ) : tab === 'usuals' ? (
        <>
          {due.length > 0 && (
            <button
              type="button"
              onClick={() => addAll(due.filter((u) => !draft[u.productId]))}
              className="mx-4 mt-3 w-[calc(100%-2rem)] rounded-xl bg-accent py-2.5 text-sm font-semibold text-white lg:mx-0 lg:w-full"
            >
              Add everything due ({due.length})
            </button>
          )}
          <ul className={card}>
            {data!.usuals.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-ink-muted">No orders in the last three months.</li>
            )}
            {data!.usuals.map((u) => (
              <ProductRow
                key={u.productId}
                item={u}
                badge={u.due ? 'Due' : undefined}
                detail={`${howOften(u.everyDays)} · ${u.orders}/${u.ofOrders}`}
                draft={draft}
                setQuantity={setQuantity}
              />
            ))}
          </ul>
        </>
      ) : tab === 'past' ? (
        <div className={card}>
          {data!.orders.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-muted">No orders in the last three months.</p>
          ) : (
            data!.orders.map((order, index) => (
              <div key={order.id} className="border-b border-line last:border-b-0">
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => setOpenOrder(openOrder === order.id ? null : order.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block text-sm font-medium">
                      {index === 0 ? `Last order · ${orderDate(order)}` : orderDate(order)}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {order.items.length} products · {euros(order.totalPrice)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => addAll(order.items)}
                    className="shrink-0 rounded-full bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent"
                  >
                    Add all
                  </button>
                </div>
                {openOrder === order.id && (
                  <ul className="border-t border-line bg-surface/40">
                    {order.items.map((item) => (
                      <ProductRow key={item.productId} item={item} draft={draft} setQuantity={setQuantity} />
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <div className="mx-4 mt-3 grid grid-cols-2 rounded-xl bg-card p-1 text-center text-xs font-semibold lg:mx-0">
            {[0, 1].map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setPlanWeek(w)}
                className={`rounded-lg py-2 ${planWeek === w ? 'bg-accent-soft text-accent' : 'text-ink-secondary'}`}
              >
                {w === 0 ? 'This week' : 'Next week'}
              </button>
            ))}
          </div>
          {planItems.length > 0 && (
            <button
              type="button"
              onClick={() => addAll(planItems.filter((i) => !draft[i.productId]))}
              className="mx-4 mt-3 w-[calc(100%-2rem)] rounded-xl bg-accent py-2.5 text-sm font-semibold text-white lg:mx-0 lg:w-full"
            >
              Add the plan's shopping ({planItems.length})
            </button>
          )}
          <ul className={card}>
            {!planList ? (
              <li className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</li>
            ) : planList.items.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-ink-muted">Nothing planned that week.</li>
            ) : (
              planItems.map((item) => (
                <ProductRow key={item.productId} item={item} draft={draft} setQuantity={setQuantity} />
              ))
            )}
          </ul>
          {unchosen > 0 && (
            <p className="mx-4 mt-2 text-xs text-ink-muted lg:mx-0">
              {unchosen} {unchosen === 1 ? 'line has' : 'lines have'} no product chosen yet — choose on the Plan's
              shopping list.
            </p>
          )}
        </>
      )}

      {items.length > 0 && (
        <div className="fixed inset-x-0 bottom-20 z-30 px-4 md:bottom-4 md:left-auto md:right-8 md:w-96">
          <button
            type="button"
            onClick={() => setReviewing(true)}
            className="w-full rounded-2xl bg-ink py-3 text-sm font-semibold text-surface shadow-lg"
          >
            Review order · {count} {count === 1 ? 'item' : 'items'}
          </button>
        </div>
      )}

      {lazy && (
        <LazyOrder
          onClose={() => setLazy(false)}
          onAdd={(list, recipes, plan) => {
            addAll(list);
            setPending((current) => ({
              recipes: [...current.recipes.filter((r) => !recipes.some((n) => n.url === r.url)), ...recipes],
              plan,
            }));
            setLazy(false);
            setReviewing(true);
          }}
        />
      )}

      {reviewing && (
        <Sheet onClose={() => setReviewing(false)}>
          <h2 className="text-lg font-semibold">Your order</h2>
          {(unchecked.length > 0 || unpriced.length > 0) && (
            <div className="mt-2 flex gap-2">
              {unchecked.length > 0 && (
                <button
                  type="button"
                  disabled={checking}
                  onClick={checkNutriScore}
                  className="rounded-full bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent disabled:opacity-60"
                >
                  {checking ? 'Checking…' : 'Check Nutri-Score'}
                </button>
              )}
              {unpriced.length > 0 && (
                <button
                  type="button"
                  disabled={pricing}
                  onClick={checkPrices}
                  className="rounded-full bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent disabled:opacity-60"
                >
                  {pricing ? 'Checking…' : 'Check prices'}
                </button>
              )}
            </div>
          )}
          {pricedItems.length > 0 && (
            <p className="mt-2 text-xs text-ink-secondary">
              About {euros(estimate)}
              {dealSavings > 0 ? ` · deals save ${euros(dealSavings)}` : ''}
              {couldSave > 0 ? ` · swaps could save ${euros(couldSave)}` : ''}
            </p>
          )}
          <div className="mb-3" />
          {unchecked.length === 0 && items.length > 0 && !swappable && (
            <p className="mb-2 text-xs text-ink-muted">No better-scoring swaps found.</p>
          )}
          <ul className="max-h-[55vh] overflow-y-auto">
            {items.map((item) => (
              <ProductRow
                key={item.productId}
                item={item}
                grade={checked[item.productId]?.grade}
                badge={priced(item)?.deal?.label}
                draft={draft}
                setQuantity={setQuantity}
              >
                {priced(item)?.unavailable && (
                  <p className="mt-1 text-xs font-medium text-over">Sold out at Picnic: {priced(item)!.unavailable}</p>
                )}
                {priced(item)?.oneMore && (
                  <button
                    type="button"
                    onClick={() => setQuantity(item, item.quantity + 1)}
                    className="mt-1.5 flex w-full items-center gap-2 rounded-xl border border-line px-2 py-1.5 text-left text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-semibold text-good">−{euros(priced(item)!.oneMore!.saves)}</span> One more
                      for {euros(priced(item)!.oneMore!.extra)}
                    </span>
                    <span className="shrink-0 font-semibold text-accent">Add</span>
                  </button>
                )}
                {priced(item)?.cheaper.map((to) => (
                  <button
                    key={to.productId}
                    type="button"
                    onClick={() => swap(item, to)}
                    className="mt-1.5 flex w-full items-center gap-2 rounded-xl border border-line px-2 py-1.5 text-left"
                  >
                    <Thumb id={to.imageId} size="h-7 w-7" />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      <span className="font-semibold text-good">−{euros(to.saves)}</span> {to.quantity} × {to.name}
                      {to.unitQuantity ? <span className="text-ink-muted"> · {to.unitQuantity}</span> : null}
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-accent">Swap</span>
                  </button>
                ))}
                {checked[item.productId]?.swaps.map((to) => (
                  <button
                    key={to.productId}
                    type="button"
                    onClick={() => swap(item, to)}
                    className="mt-1.5 flex w-full items-center gap-2 rounded-xl border border-line px-2 py-1.5 text-left"
                  >
                    <Thumb id={to.imageId} size="h-7 w-7" />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      <Grade grade={to.grade} />
                      {to.name}
                      <span className="text-ink-muted">
                        {[to.unitQuantity, to.price != null ? euros(to.price) : null]
                          .filter(Boolean)
                          .map((t) => ` · ${t}`)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-accent">Swap</span>
                  </button>
                ))}
              </ProductRow>
            ))}
          </ul>
          {pending.recipes.length > 0 && (
            <div className="mt-3 rounded-xl bg-surface px-3 py-2">
              <p className="text-xs font-medium text-ink-secondary">Recipes, saved when added to the cart</p>
              <ul>
                {pending.recipes.map((r) => (
                  <li key={r.url} className="flex items-center gap-2 py-0.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">{r.title}</span>
                    <button
                      type="button"
                      aria-label={`Don't save ${r.title}`}
                      onClick={() =>
                        setPending((current) => ({ ...current, recipes: current.recipes.filter((x) => x.url !== r.url) }))
                      }
                      className="shrink-0 rounded-full px-2 text-ink-muted"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <label className="mt-1 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={pending.plan}
                  onChange={(e) => setPending((current) => ({ ...current, plan: e.target.checked }))}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                Put them on the plan
              </label>
            </div>
          )}
          {error && <p className="mt-2 text-sm text-over">{error}</p>}
          <button
            type="button"
            disabled={busy || items.length === 0}
            onClick={addToCart}
            className="mt-3 w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            Add {count} to Picnic cart
          </button>
        </Sheet>
      )}

      {tab !== 'plan' && data && (
        <button
          type="button"
          onClick={() => setRefresh((n) => n + 1)}
          className="mx-4 mt-3 text-xs text-ink-muted underline lg:mx-0"
        >
          Check Picnic for newer orders
        </button>
      )}
    </div>
  );
}
