import { useState } from 'react';
import { api } from '../lib/api';

// Changing your own password, without needing a shell.

const field = 'w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm';

export default function PasswordChange() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = again !== '' && next !== again;
  const valid = current !== '' && next.length >= 8 && next === again;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      setOpen(false);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change it.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setDone(false);
        }}
        className="mb-2 w-full rounded-xl border border-line py-2.5 text-sm font-semibold text-ink-secondary"
      >
        {done ? 'Password changed' : 'Change password'}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mb-2 flex flex-col gap-2">
      <input
        type="password"
        autoComplete="current-password"
        placeholder="Current password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        className={field}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="New password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        className={field}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="New password again"
        value={again}
        onChange={(e) => setAgain(e.target.value)}
        className={field}
      />
      {next !== '' && next.length < 8 && (
        <p className="text-xs text-ink-muted">At least 8 characters.</p>
      )}
      {mismatch && <p className="text-xs text-over">Those two don&apos;t match.</p>}
      {error && <p className="rounded-xl bg-over-soft px-3 py-2 text-xs text-over">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="flex-1 rounded-xl border border-line py-2.5 text-sm font-semibold text-ink-secondary"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!valid || busy}
          className="flex-1 rounded-xl bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy ? 'Changing…' : 'Change it'}
        </button>
      </div>
      {/* Other devices carry a stamp of the old password, so they stop working. */}
      <p className="text-xs text-ink-muted">Your other devices will need signing in again.</p>
    </form>
  );
}
