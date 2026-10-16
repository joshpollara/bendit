import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type PicnicCheckoutState } from '../lib/api';
import { euros } from '../components/PicnicBits';

// Where the bank sends someone back after paying for a Picnic order. Waits for
// Picnic to report the payment, then for the order to appear.

const POLL_MS = 3000;
const GIVE_UP_MS = 3 * 60 * 1000;

export default function PicnicCheckout() {
  const [params] = useSearchParams();
  const orderId = params.get('order') ?? '';
  const [state, setState] = useState<PicnicCheckoutState>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);

  const settled = (s?: PicnicCheckoutState) =>
    !!s && (s.placed || s.status === 'FINISHED' || s.status === 'CANCELLED');

  useEffect(() => {
    if (!orderId) return;
    let alive = true;
    const startedAt = Date.now();
    const poll = async () => {
      try {
        const next = await api.picnicCheckoutState(orderId);
        if (!alive) return;
        setState(next);
        if (settled(next)) return;
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Could not reach Picnic.');
      }
      if (Date.now() - startedAt > GIVE_UP_MS) return alive && setGaveUp(true);
      if (alive) setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
    };
  }, [orderId]);

  async function run(action: () => Promise<PicnicCheckoutState>) {
    setBusy(true);
    setError(null);
    try {
      setState(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const total = state?.total != null ? ` (${euros(state.total)})` : '';

  return (
    <div className="mx-4 pt-[env(safe-area-inset-top)] lg:mx-0">
      <h1 className="py-3 text-lg font-semibold lg:text-2xl lg:font-bold">Picnic order</h1>
      <div className="rounded-2xl border border-line bg-card p-4 shadow-sm">
        {!orderId ? (
          <p className="text-sm text-ink-muted">No order to show.</p>
        ) : !state ? (
          <p className="text-sm text-ink-muted">{error ?? 'Checking with Picnic…'}</p>
        ) : state.placed ? (
          <p className="text-sm">
            <span className="font-semibold">Order placed{total}.</span> It's in{' '}
            <Link to="/picnic" className="text-accent underline">
              Orders
            </Link>
            .
          </p>
        ) : state.status === 'CANCELLED' ? (
          <p className="text-sm">The payment was cancelled. Nothing was ordered.</p>
        ) : state.status === 'FINISHED' ? (
          <div className="space-y-3">
            <p className="text-sm">
              Picnic reports the payment as finished{total}, but the order isn't among your deliveries yet.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Ask Picnic to confirm this order?')) void run(() => api.picnicConfirmOrder(orderId));
              }}
              className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              Confirm order
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => api.picnicCheckoutState(orderId))}
              className="w-full rounded-xl py-2 text-sm font-semibold text-ink-secondary"
            >
              Check again
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              {gaveUp ? 'Picnic hasn’t reported the payment yet.' : 'Waiting for the payment to come through…'}
            </p>
            {gaveUp && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => api.picnicCheckoutState(orderId))}
                className="w-full rounded-xl border border-line py-2.5 text-sm font-semibold"
              >
                Check again
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Cancel this payment?')) void run(() => api.picnicCancelPayment(orderId));
              }}
              className="w-full rounded-xl py-2 text-sm font-semibold text-over"
            >
              Cancel payment
            </button>
          </div>
        )}
        {error && state && <p className="mt-2 text-sm text-over">{error}</p>}
      </div>
    </div>
  );
}
