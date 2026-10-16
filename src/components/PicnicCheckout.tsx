import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { api, ApiError, type PicnicCheckoutIssue, type PicnicCheckoutSummary } from '../lib/api';
import { euros } from './PicnicBits';
import Sheet from './Sheet';

// Checking out the Picnic cart. Opening the sheet starts checkout, which only
// says what would be paid for; nothing is ordered until "Pay" sends the person
// to their bank.

export default function CheckoutSheet({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<PicnicCheckoutSummary>();
  const [issue, setIssue] = useState<PicnicCheckoutIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(resolveKey?: string) {
    setBusy(true);
    setError(null);
    setIssue(null);
    try {
      setSummary(await api.picnicStartCheckout(resolveKey));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'checkout_issue' && err.details) {
        setIssue(err.details as unknown as PicnicCheckoutIssue);
      } else {
        setError(err instanceof Error ? err.message : 'Could not start checkout.');
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void start();
  }, []);

  async function payNow() {
    if (!summary) return;
    setBusy(true);
    setError(null);
    try {
      const { redirectUrl } = await api.picnicPay(summary.orderId);
      if (redirectUrl) window.location.href = redirectUrl;
      else navigate(`/picnic/checkout?order=${encodeURIComponent(summary.orderId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the payment.');
      setBusy(false);
    }
  }

  const belowMinimum = summary?.minimumOrder != null && summary.total < summary.minimumOrder;
  const address = summary?.address;

  return (
    <Sheet onClose={onClose}>
      <h2 className="mb-3 text-lg font-semibold">Check out</h2>
      {issue ? (
        <div className="space-y-3">
          <div className="rounded-xl bg-warn-soft p-3 text-sm text-warn-deep">
            <p className="font-semibold">{issue.title}</p>
            <p>{issue.message}</p>
          </div>
          {!issue.blocking && issue.resolveKey && (
            <button
              type="button"
              disabled={busy}
              onClick={() => start(issue.resolveKey ?? undefined)}
              className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              Continue
            </button>
          )}
        </div>
      ) : !summary ? (
        <p className="text-sm text-ink-muted">{error ?? 'Getting the total from Picnic…'}</p>
      ) : (
        <div className="space-y-4">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-muted">Items</dt>
              <dd className="tabular-nums">{summary.count}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-muted">Delivery</dt>
              <dd className="text-right">
                {summary.slot
                  ? `${format(parseISO(summary.slot.start), 'EEE d MMM HH:mm')}–${format(parseISO(summary.slot.end), 'HH:mm')}`
                  : '—'}
              </dd>
            </div>
            {address && (
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">Address</dt>
                <dd className="text-right">
                  {[address.street, address.house_number].filter(Boolean).join(' ')}
                  {address.city ? `, ${address.city}` : ''}
                </dd>
              </div>
            )}
            {summary.deposit > 0 && (
              <div className="flex justify-between">
                <dt className="text-ink-muted">Deposit</dt>
                <dd className="tabular-nums">{euros(summary.deposit)}</dd>
              </div>
            )}
            {summary.savings > 0 && (
              <div className="flex justify-between">
                <dt className="text-ink-muted">Savings</dt>
                <dd className="tabular-nums text-good">−{euros(summary.savings)}</dd>
              </div>
            )}
            <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{euros(summary.total)}</dd>
            </div>
          </dl>
          {belowMinimum && (
            <p className="text-sm text-over">Picnic's minimum order for this slot is {euros(summary.minimumOrder ?? 0)}.</p>
          )}
          {error && <p className="text-sm text-over">{error}</p>}
          <button
            type="button"
            disabled={busy || belowMinimum}
            onClick={payNow}
            className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            Pay {euros(summary.total)}
          </button>
        </div>
      )}
    </Sheet>
  );
}
