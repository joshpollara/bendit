import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { api, type PicnicStatus } from '../lib/api';
import { useData } from '../lib/useData';
import { useUI } from '../store/ui';

// Connecting the installation's Picnic account. The account itself comes from
// the server's environment; this only completes the sign-in, including the SMS
// code Picnic asks for the first time. A sign-in lasts about six months; in
// its last week it can be done again here before it runs out.

const button = 'w-full rounded-xl py-2.5 text-sm font-semibold disabled:opacity-50';

/** Within a week of the sign-in ending. */
export const endsSoon = (status: PicnicStatus | undefined, now = Date.now()) =>
  Boolean(status?.connected && status.expiresAt && Date.parse(status.expiresAt) - now < 7 * 24 * 60 * 60 * 1000);

export default function PicnicSetting({ heading = true }: { heading?: boolean }) {
  const bump = useUI((s) => s.bump);
  const loaded = useData(() => api.picnicStatus(), []);
  const [changed, setChanged] = useState<PicnicStatus | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = changed ?? loaded;

  async function run(action: () => Promise<PicnicStatus>) {
    setBusy(true);
    setError(null);
    try {
      setChanged(await action());
      setCode('');
      bump();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {heading && <h2 className="mb-1 font-semibold">Picnic</h2>}
      {!status ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : !status.configured ? (
        <p className="text-sm text-ink-muted">
          Not set up on this server. Set <code className="text-xs">PICNIC_USERNAME</code> and{' '}
          <code className="text-xs">PICNIC_PASSWORD</code> to use it.
        </p>
      ) : status.awaitingCode ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) run(() => api.picnicVerify(code));
          }}
          className="flex flex-col gap-2"
        >
          <p className="text-sm text-ink-secondary">Enter the code Picnic sent by SMS.</p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm"
          />
          <button type="submit" disabled={busy || !code.trim()} className={`${button} bg-accent text-white`}>
            Verify
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(api.picnicConnect)}
            className={`${button} text-ink-secondary`}
          >
            Send a new code
          </button>
        </form>
      ) : status.connected ? (
        <>
          {endsSoon(status) ? (
            <>
              <p className="mb-3 text-sm text-ink-secondary">
                Sign-in ends {format(parseISO(status.expiresAt!), 'EEE d MMM, HH:mm')}.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(api.picnicConnect)}
                className={`${button} ${heading ? 'mb-2' : ''} bg-accent text-white`}
              >
                Sign in again
              </button>
            </>
          ) : (
            <p className="mb-3 text-sm text-ink-secondary">
              Connected ({status.countryCode})
              {status.expiresAt && `, signed in until ${format(parseISO(status.expiresAt), 'd MMM yyyy')}`}.
            </p>
          )}
          {heading && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(api.picnicDisconnect)}
              className={`${button} border border-line text-ink-secondary`}
            >
              Disconnect
            </button>
          )}
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-ink-secondary">Not connected.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(api.picnicConnect)}
            className={`${button} bg-accent text-white`}
          >
            Connect
          </button>
        </>
      )}
      {error && <p className="mt-2 text-sm text-over">{error}</p>}
    </div>
  );
}
