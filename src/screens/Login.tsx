import { useState } from 'react';
import { api } from '../lib/api';
import { STRINGS } from '../lib/strings';

// Signing in inside the app, rather than through the browser's own dialog.
// The session lasts a year, so on a phone this should be a once-a-year screen.

export default function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-5 px-8">
      <h1 className="text-4xl font-bold tracking-tight">
        Bend It<span className="text-amber">!</span>
      </h1>
      <p className="text-center text-sm text-ink-muted">{STRINGS.splash}</p>

      <form onSubmit={submit} className="flex w-full flex-col gap-3">
        <input
          type="text"
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full rounded-xl border border-line bg-card px-4 py-3 text-center text-base"
        />
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl border border-line bg-card px-4 py-3 text-center text-base"
        />
        {error && (
          <p className="rounded-xl bg-over-soft px-3 py-2 text-center text-sm text-over">{error}</p>
        )}
        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full rounded-xl bg-accent py-3.5 font-semibold text-white disabled:opacity-40"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

    </div>
  );
}
