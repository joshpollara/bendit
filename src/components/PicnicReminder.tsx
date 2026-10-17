import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { useUI } from '../store/ui';
import { ensurePushSubscription } from './ReminderSetting';

// A push before Picnic stops taking changes to the next delivery: what's in
// the cart, or that it's empty. Each person's own choice.

const OPTIONS: (number | null)[] = [null, 2, 6, 24];
const label = (h: number | null) => (h == null ? 'Off' : h === 24 ? 'A day' : `${h} h`);

export default function PicnicReminder() {
  const bump = useUI((s) => s.bump);
  const state = useData(() => api.picnicReminder(), []);
  const config = useData(() => api.pushConfig(), []);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
  if (!state?.push) return null;

  async function choose(hours: number | null) {
    setError(null);
    try {
      if (hours != null) await ensurePushSubscription(config?.publicKey);
      await api.setPicnicReminder(hours);
      bump();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the reminder.');
    }
  }

  return (
    <div className="border-b border-line px-4 py-3">
      <p className="text-sm font-medium">Remind me before ordering closes</p>
      {state.next && (
        <p className="text-xs text-ink-muted">
          {state.next.ordered
            ? 'This delivery is already ordered.'
            : `Changes for ${format(parseISO(state.next.windowStart), 'EEE d MMM')} close ${format(parseISO(state.next.cutOffTime), 'EEE HH:mm')}.`}
        </p>
      )}
      {supported ? (
        <div className="mt-2 grid grid-cols-4 gap-1 rounded-xl bg-surface p-1 text-center text-xs font-semibold">
          {OPTIONS.map((h) => (
            <button
              key={String(h)}
              type="button"
              onClick={() => void choose(h)}
              className={`rounded-lg py-1.5 ${state.hoursBefore === h ? 'bg-accent text-white' : 'text-ink-secondary'}`}
            >
              {label(h)}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-xs text-ink-muted">Add Bend It! to your home screen to get reminders on this device.</p>
      )}
      {error && <p className="mt-1 text-xs text-over">{error}</p>}
    </div>
  );
}
