import { useEffect, useState } from 'react';
import { api, type PicnicProduct } from '../lib/api';
import { SearchIcon } from './Icons';
import Sheet from './Sheet';

// Pieces shared by the screens that show Picnic products.

export const euros = (cents: number) =>
  (cents / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });

export const picnicImage = (id: string | null | undefined, size: 'small' | 'medium' = 'small') =>
  id ? `/api/picnic/images/${encodeURIComponent(id)}/${size}` : undefined;

export function Thumb({ id, size = 'h-12 w-12' }: { id?: string | null; size?: string }) {
  return (
    <span className={`${size} shrink-0 overflow-hidden rounded-lg bg-white`}>
      {id && <img src={picnicImage(id)} alt="" loading="lazy" className="h-full w-full object-contain" />}
    </span>
  );
}

/** The search term, once typing has paused: every keystroke would be a request to Picnic. */
export function useSettled(value: string, ms = 400) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Choosing a Picnic product, starting from a search for `initial`. */
export function ProductPicker({
  title,
  initial,
  onPick,
  onClose,
}: {
  title: string;
  initial: string;
  onPick: (product: PicnicProduct) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initial);
  const [results, setResults] = useState<PicnicProduct[] | undefined>(undefined);
  const q = useSettled(query.trim());

  useEffect(() => {
    if (!q) return setResults([]);
    let alive = true;
    setResults(undefined);
    api.picnicSearch(q).then(
      (found) => alive && setResults(found.slice(0, 20)),
      () => alive && setResults([]),
    );
    return () => {
      alive = false;
    };
  }, [q]);

  return (
    <Sheet onClose={onClose}>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3">
        <SearchIcon className="h-4 w-4 shrink-0 text-ink-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full bg-transparent py-2.5 text-sm outline-none"
        />
      </div>
      <ul className="mt-2 max-h-[55vh] divide-y divide-line overflow-y-auto">
        {results === undefined ? (
          <li className="py-6 text-center text-sm text-ink-muted">Searching…</li>
        ) : results.length === 0 ? (
          <li className="py-6 text-center text-sm text-ink-muted">Nothing found.</li>
        ) : (
          results.map((product) => (
            <li key={product.id}>
              <button
                type="button"
                onClick={() => onPick(product)}
                className="flex w-full items-center gap-3 py-2.5 text-left"
              >
                <Thumb id={product.image_id} size="h-10 w-10" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{product.name}</span>
                  <span className="block truncate text-xs text-ink-muted">{product.unit_quantity}</span>
                </span>
                <span className="text-sm tabular-nums">{euros(product.display_price)}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </Sheet>
  );
}
