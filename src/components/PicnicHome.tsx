import { format, parseISO, startOfWeek } from 'date-fns';
import { Link } from 'react-router-dom';
import { api, type PicnicCart } from '../lib/api';
import { useData } from '../lib/useData';
import { DAY, shiftDay, todayStr } from '../lib/dates';
import { unavailableOf } from '../lib/picnicUnavailable';
import { euros } from './PicnicBits';
import { ChevronRightIcon, SparkleIcon, TagIcon } from './Icons';

const clock = (iso: string) => format(parseISO(iso), 'HH:mm');

/** "today", "tomorrow" or "Tue 21 Oct". */
export function dayOf(iso: string, today = todayStr()) {
  const date = format(parseISO(iso), DAY);
  if (date === today) return 'today';
  if (date === shiftDay(today, 1)) return 'tomorrow';
  return format(parseISO(iso), 'EEE d MMM');
}

export const windowOf = (start: string, end: string | null) =>
  `${dayOf(start)}, ${clock(start)}${end ? `–${clock(end)}` : ''}`;

/** How long until the cutoff: "40 min left", "5 h left", "2 days left", or null once it's passed. */
export function leftUntil(iso: string, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return null;
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min left`;
  if (hours < 24) return `${Math.floor(hours)} h left`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} left`;
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function PicnicHome({
  cart,
  onCart,
  onDelivery,
}: {
  cart?: PicnicCart;
  onCart: () => void;
  onDelivery: (id: string) => void;
}) {
  const monday = format(startOfWeek(parseISO(todayStr()), { weekStartsOn: 1 }), DAY);
  const home = useData(() => api.picnicHome(monday, shiftDay(monday, 6)), [monday]);
  const soldOut = (cart?.items ?? []).reduce(
    (n, line) => n + line.items.filter((a) => unavailableOf(a, line)).length,
    0,
  );
  const next = home?.next;
  const left = next && !next.ordered ? leftUntil(next.cutOffTime) : null;
  const card = 'mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm lg:mx-0';

  const starts = [
    { label: 'Usuals due', count: home?.usualsDue ?? 0, to: '/picnic/new' },
    { label: 'Usuals on a deal', count: home?.deals ?? 0, to: '/picnic/new?tab=deals' },
    { label: "From this week's plan", count: home?.plan ?? 0, to: '/picnic/new?tab=plan' },
  ].filter((s) => s.count > 0);

  return (
    <>
      <section className={card}>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Next delivery</h2>
        {!home ? (
          <p className="mt-2 text-sm text-ink-muted">Loading…</p>
        ) : next ? (
          <>
            <p className="mt-1 text-base font-semibold">{sentence(windowOf(next.windowStart, next.windowEnd))}</p>
            {next.ordered ? (
              <p className="text-sm text-good">Ordered</p>
            ) : (
              <p className="text-sm text-ink-secondary">
                Order closes {dayOf(next.cutOffTime)} {clock(next.cutOffTime)}
                {left && <span className="font-semibold text-accent"> · {left}</span>}
              </p>
            )}
          </>
        ) : (
          <p className="mt-1 text-sm text-ink-secondary">No delivery slot picked.</p>
        )}
        <button
          type="button"
          onClick={onCart}
          className="mt-3 flex w-full items-center justify-between rounded-xl bg-accent-soft px-3 py-2.5 text-sm font-semibold text-accent"
        >
          <span>
            {cart
              ? cart.total_count > 0
                ? `${cart.total_count} ${cart.total_count === 1 ? 'item' : 'items'} · ${euros(cart.checkout_total_price)}`
                : 'Cart is empty'
              : 'Cart'}
          </span>
          <span>{next || !home ? 'Cart →' : 'Pick a slot →'}</span>
        </button>
        {soldOut > 0 && (
          <p className="mt-2 text-sm font-medium text-over">
            {soldOut} {soldOut === 1 ? 'item' : 'items'} sold out
          </p>
        )}
      </section>

      {home?.arriving && (
        <button
          type="button"
          onClick={() => onDelivery(home.arriving!.id)}
          className={`${card} block w-[calc(100%-2rem)] text-left lg:w-full`}
        >
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">On its way</h2>
          <p className="mt-1 text-base font-semibold">
            {sentence(windowOf(home.arriving.windowStart, home.arriving.windowEnd))}
          </p>
          {home.arriving.eta ? (
            <p className="text-sm font-medium text-accent">
              Arriving about {clock(home.arriving.eta)}
              {home.arriving.minutes ? ` · ${home.arriving.minutes} min` : ''}
            </p>
          ) : (
            home.arriving.totalPrice != null && (
              <p className="text-sm text-ink-secondary">{euros(home.arriving.totalPrice)}</p>
            )
          )}
        </button>
      )}

      {starts.length > 0 && (
        <ul className="mx-4 mt-3 overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:mx-0">
          {starts.map((s) => (
            <li key={s.label} className="border-b border-line last:border-b-0">
              <Link to={s.to} className="flex items-center justify-between px-4 py-3 text-sm">
                <span className="font-medium">{s.label}</span>
                <span className="font-semibold tabular-nums text-accent">{s.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link
        to="/picnic/new?lazy=1"
        className="mx-4 mt-3 flex items-center justify-center gap-2 rounded-2xl border border-accent bg-accent-soft py-3 text-sm font-semibold text-accent lg:mx-0"
      >
        <SparkleIcon className="h-4 w-4" />
        Make me an order
      </Link>

      <Link
        to="/prices"
        className="mx-4 mt-3 flex items-center justify-between rounded-2xl border border-line bg-card px-4 py-3 text-sm shadow-sm lg:mx-0"
      >
        <span className="flex items-center gap-2 font-medium">
          <TagIcon className="h-4 w-4 text-accent" />
          Prices and spending
        </span>
        <ChevronRightIcon className="h-4 w-4 text-ink-muted" />
      </Link>
    </>
  );
}
