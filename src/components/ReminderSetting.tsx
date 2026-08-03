import { useState } from 'react';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { useUI } from '../store/ui';
import type { Profile } from '../types';

// An evening nudge, and only when it's warranted: the server checks that the
// day has nothing logged and hasn't been closed before sending anything.

const HOURS = [17, 18, 19, 20, 21, 22];

function hourLabel(hour: number): string {
  const suffix = hour >= 12 ? 'pm' : 'am';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}${suffix}`;
}

/** Web push wants the VAPID key as bytes, not base64url text. */
function urlBase64ToUint8Array(base64: string): ArrayBuffer {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

export default function ReminderSetting({ profile }: { profile: Profile }) {
  const bump = useUI((s) => s.bump);
  const config = useData(() => api.pushConfig(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported =
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
  const hour = profile.reminderHour ?? null;

  async function enable(atHour: number) {
    setBusy(true);
    setError(null);
    try {
      if (!config?.publicKey) throw new Error('Reminders are not configured on the server.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error('Notifications are blocked for this app in your device settings.');
      }
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.publicKey),
        }));
      await api.pushSubscribe(subscription.toJSON());
      await api.putProfile({
        ...profile,
        reminderHour: atHour,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      bump();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn reminders on.');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api.pushUnsubscribe(subscription.endpoint);
        await subscription.unsubscribe();
      }
      await api.putProfile({ ...profile, reminderHour: null });
      bump();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="mb-1 font-semibold">Evening reminder</h2>
      <p className="mb-3 text-xs text-ink-muted">
        A nudge if the day is still empty by then. Nothing arrives on days you've logged or closed.
      </p>

      {!supported ? (
        <p className="text-sm text-ink-secondary">
          This browser can't do notifications. On iPhone, add Bend It! to your home screen first.
        </p>
      ) : config && !config.enabled ? (
        <p className="text-sm text-ink-secondary">
          Not set up on the server yet — it needs a VAPID key pair in{' '}
          <code className="text-xs">VAPID_PUBLIC_KEY</code> and{' '}
          <code className="text-xs">VAPID_PRIVATE_KEY</code>.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-6 gap-1 rounded-xl bg-surface p-1 text-center text-xs font-semibold">
            {HOURS.map((h) => (
              <button
                key={h}
                type="button"
                disabled={busy}
                onClick={() => enable(h)}
                className={`rounded-lg py-2 ${hour === h ? 'bg-accent text-white' : 'text-ink-secondary'}`}
              >
                {hourLabel(h)}
              </button>
            ))}
          </div>
          {hour != null && (
            <div className="mt-2 flex items-center gap-2">
              <p className="flex-1 text-xs text-ink-muted">
                Reminding you at {hourLabel(hour)}, your time.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => api.pushTest()}
                className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink-secondary"
              >
                Send a test
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={disable}
                className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-over"
              >
                Turn off
              </button>
            </div>
          )}
        </>
      )}
      {error && <p className="mt-2 rounded-xl bg-over-soft px-3 py-2 text-xs text-over">{error}</p>}
    </>
  );
}
