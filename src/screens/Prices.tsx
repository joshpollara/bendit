import { useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type PriceNote, type PricePoint } from '../lib/api';
import { useData } from '../lib/useData';
import { ChevronLeftIcon, SearchIcon } from '../components/Icons';
import { euros, Thumb } from '../components/PicnicBits';

// What Picnic's products have cost over time, and what's been spent there.
// Prices are kept from past orders, searches and a daily look at the usuals;
// see server/lib/priceHistory.mjs.

const card = 'mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm lg:mx-0';
const label = 'text-xs font-semibold uppercase tracking-wide text-ink-muted';
const monthLabel = (month: string) => format(parseISO(`${month}-01`), 'MMM');

function Header({ title }: { title: string }) {
  const navigate = useNavigate();
  return (
    <header className="flex items-center gap-1 px-2 py-3">
      <button
        type="button"
        aria-label="Back"
        onClick={() => navigate(-1)}
        className="rounded-full p-2 text-ink-secondary hover:bg-card"
      >
        <ChevronLeftIcon className="h-5 w-5" />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:px-2 lg:text-2xl lg:font-bold lg:tracking-tight">
        {title}
      </h1>
    </header>
  );
}

/** Monthly totals as bars. */
function Bars({ months }: { months: { month: string; total: number }[] }) {
  const max = Math.max(1, ...months.map((m) => m.total));
  return (
    <div className="mt-3 flex h-28 items-end gap-1">
      {months.map((m) => (
        <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <div
            className="w-full rounded-t bg-accent"
            style={{ height: `${Math.max(m.total ? 3 : 0, (m.total / max) * 88)}px` }}
            title={`${m.month}: ${euros(m.total)}`}
          />
          <span className="text-[10px] text-ink-muted">{monthLabel(m.month).charAt(0)}</span>
        </div>
      ))}
    </div>
  );
}

/** A line through the values given, skipping gaps; small enough for a list row when `small`. */
export function Line({
  values,
  xs,
  small = false,
  dots = [],
}: {
  values: (number | null)[];
  /** Where each value sits along the line (a date, say); evenly when left out. */
  xs?: number[];
  small?: boolean;
  /** Extra points to mark, at an index and value. */
  dots?: { at: number; value: number }[];
}) {
  const W = small ? 64 : 320;
  const H = small ? 24 : 120;
  const pad = small ? 2 : 8;
  const known = [...values.filter((v): v is number => v != null), ...dots.map((d) => d.value)];
  if (known.length === 0) return <div style={{ width: W, height: H }} />;
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const [x0, x1] = xs?.length ? [xs[0], xs.at(-1)!] : [0, values.length - 1];
  const x = (i: number) => pad + (x1 > x0 ? (((xs ? xs[i] : i) - x0) / (x1 - x0)) * (W - 2 * pad) : (W - 2 * pad) / 2);
  const y = (v: number) => (hi === lo ? H / 2 : pad + ((hi - v) / (hi - lo)) * (H - 2 * pad));
  const segments: string[] = [];
  let current = '';
  values.forEach((v, i) => {
    if (v == null) {
      if (current) segments.push(current);
      current = '';
      return;
    }
    current += `${current ? ' L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (current) segments.push(current);
  const lone = values
    .map((v, i) => (v != null && values[i - 1] == null && values[i + 1] == null ? i : -1))
    .filter((i) => i >= 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={small ? W : '100%'} height={small ? H : undefined} className="block">
      {segments.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          className="stroke-accent"
          strokeWidth={small ? 1.5 : 2}
          strokeLinejoin="round"
        />
      ))}
      {lone.map((i) => (
        <circle key={i} cx={x(i)} cy={y(values[i]!)} r={small ? 1.5 : 2.5} className="fill-accent" />
      ))}
      {dots.map((d) => (
        <circle key={`d${d.at}`} cx={x(d.at)} cy={y(d.value)} r={small ? 1.5 : 3} className="fill-good" />
      ))}
    </svg>
  );
}

const NOTE_STYLE: Record<PriceNote['kind'], string> = {
  lowest: 'text-good',
  up: 'text-over',
  smaller: 'text-over',
};

/** How the usuals' prices compare with a year ago, or with the first month kept. */
function basketSince(yearChange: number | null, index: { month: string; index: number | null }[]) {
  let change = yearChange;
  let when = 'a year ago';
  if (change == null) {
    const first = index[0];
    if (!first?.index || index.length < 2) return 'Kept from now on';
    change = Math.round((100 / first.index - 1) * 100);
    when = `in ${monthLabel(first.month)} ${first.month.slice(0, 4)}`;
  }
  if (change === 0) return `Same as ${when}`;
  return `${Math.abs(change)}% ${change > 0 ? 'more' : 'less'} than ${when}`;
}

const priceText = (p: { price: number; paid: number | null }) => (p.paid != null ? euros(p.paid) : euros(p.price));

export default function Prices() {
  const data = useData(() => api.prices(), []);
  const [query, setQuery] = useState('');
  const products = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.products ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [data, query]);
  // From the first month with prices kept.
  const months = data?.basket.months ?? [];
  const index = months.slice(
    Math.max(
      0,
      months.findIndex((m) => m.index != null),
    ),
  );
  const since = basketSince(data?.basket.change ?? null, index);

  return (
    <div className="pt-[env(safe-area-inset-top)] pb-28 md:pb-20">
      <Header title="Prices" />
      {!data ? (
        <p className="mx-4 text-sm text-ink-muted">Loading…</p>
      ) : (
        <>
          <section className={card}>
            <h2 className={label}>Spent at Picnic</h2>
            <p className="mt-1 text-base font-semibold">
              {data.spending.perWeek != null ? `${euros(data.spending.perWeek)} a week lately` : 'No orders lately'}
            </p>
            <Bars months={data.spending.months} />
          </section>

          <section className={card}>
            <h2 className={label}>Your usuals</h2>
            {index.some((m) => m.index != null) ? (
              <>
                <p className="mt-1 text-base font-semibold">{since}</p>
                <div className="mt-2">
                  <Line values={index.map((m) => m.index)} />
                </div>
                <div className="flex justify-between text-[10px] text-ink-muted">
                  <span>
                    {monthLabel(index[0].month)} {index[0].month.slice(0, 4)}
                  </span>
                  <span>Now</span>
                </div>
              </>
            ) : (
              <p className="mt-1 text-sm text-ink-secondary">No prices kept yet.</p>
            )}
          </section>

          {data.notes.length > 0 && (
            <ul className="mx-4 mt-3 overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:mx-0">
              {data.notes.map((n) => (
                <li key={n.productId} className="border-b border-line last:border-b-0">
                  <Link to={`/prices/${n.productId}`} className="flex items-center gap-3 px-4 py-2.5">
                    <Thumb id={n.imageId} size="h-9 w-9" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{n.name}</span>
                      <span className={`block text-xs font-medium ${NOTE_STYLE[n.note.kind]}`}>{n.note.text}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {data.products.length > 0 && (
            <>
              <div className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-line bg-card px-3 lg:mx-0">
                <SearchIcon className="h-4 w-4 shrink-0 text-ink-muted" />
                <input
                  type="search"
                  placeholder="Find a usual"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full bg-transparent py-2.5 text-sm outline-none"
                />
              </div>
              <ul className="mx-4 mt-3 overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:mx-0">
                {products.map((p) => (
                  <li key={p.productId} className="border-b border-line last:border-b-0">
                    <Link to={`/prices/${p.productId}`} className="flex items-center gap-3 px-4 py-2.5">
                      <Thumb id={p.imageId} size="h-9 w-9" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{p.name}</span>
                        <span className="block truncate text-xs text-ink-muted">
                          {p.deal && <span className="mr-1 font-semibold text-good">{p.deal}</span>}
                          {p.unitQuantity}
                        </span>
                      </span>
                      <Line values={p.months} small />
                      <span className="w-16 shrink-0 text-right">
                        <span className="block text-sm font-medium tabular-nums">{priceText(p)}</span>
                        {p.change != null && p.change !== 0 && (
                          <span className={`block text-xs tabular-nums ${p.change > 0 ? 'text-over' : 'text-good'}`}>
                            {p.change > 0 ? '+' : ''}
                            {p.change}%
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
          {data.kept.since && (
            <p className="mx-4 mt-3 text-xs text-ink-muted lg:mx-0">
              {data.kept.n.toLocaleString()} prices since {format(parseISO(data.kept.since), 'd MMM yyyy')}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** One price per day across the kept history, for the chart: regular prices, and deals as dots. */
function series(points: PricePoint[]) {
  const values = points.map((p) => p.price);
  const xs = points.map((p) => Date.parse(p.day));
  const dots = points.flatMap((p, at) => (p.paid != null ? [{ at, value: p.paid }] : []));
  return { values, xs, dots };
}

export function ProductPriceScreen() {
  const { id = '' } = useParams();
  const data = useData(() => api.productPrices(id), [id]);
  const chart = data ? series(data.points) : null;
  return (
    <div className="pt-[env(safe-area-inset-top)] pb-28 md:pb-20">
      <Header title={data?.name ?? 'Prices'} />
      {!data || !chart ? (
        <p className="mx-4 text-sm text-ink-muted">Loading…</p>
      ) : (
        <>
          <section className={card}>
            <p className="text-sm text-ink-muted">{data.unitQuantity}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{priceText(data.latest)}</p>
            <p className="text-sm text-ink-secondary">
              {data.latest.deal ? (
                <>
                  <span className="font-semibold text-good">{data.latest.deal}</span> · usually{' '}
                  {euros(data.latest.price)}
                </>
              ) : (
                <>Seen {format(parseISO(data.latest.day), 'd MMM yyyy')}</>
              )}
            </p>
            {data.note && <p className={`mt-1 text-sm font-medium ${NOTE_STYLE[data.note.kind]}`}>{data.note.text}</p>}
          </section>

          <section className={card}>
            <h2 className={label}>Over time</h2>
            <div className="mt-2">
              <Line values={chart.values} xs={chart.xs} dots={chart.dots} />
            </div>
            <div className="flex justify-between text-[10px] text-ink-muted">
              <span>{format(parseISO(data.points[0].day), 'MMM yyyy')}</span>
              <span>{format(parseISO(data.points.at(-1)!.day), 'MMM yyyy')}</span>
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent" />
              Regular price
              <span className="ml-3 mr-1 inline-block h-2 w-2 rounded-full bg-good" />
              With a deal
            </p>
          </section>

          {data.year && (
            <section className={card}>
              <h2 className={label}>The last year</h2>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-ink-muted">Lowest</dt>
                  <dd className="font-semibold tabular-nums">{euros(data.year.low)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">Highest</dt>
                  <dd className="font-semibold tabular-nums">{euros(data.year.high)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">On a deal</dt>
                  <dd className="font-semibold tabular-nums">
                    {data.year.dealWeeks}/{data.year.weeks} weeks
                  </dd>
                </div>
              </dl>
            </section>
          )}

          {data.packs.length > 0 && (
            <section className={card}>
              <h2 className={label}>Pack size</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {data.packs.map((p) => (
                  <li key={p.day} className="flex justify-between">
                    <span>{p.unitQuantity}</span>
                    <span className="text-ink-muted">from {format(parseISO(p.day), 'd MMM yyyy')}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
