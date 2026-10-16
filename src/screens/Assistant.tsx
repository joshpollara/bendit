import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type AssistantEntry, type AssistantState } from '../lib/api';
import { useData } from '../lib/useData';
import { computeBudget } from '../lib/budget';
import { todayStr } from '../lib/dates';
import { macroTargets } from '../lib/macros';
import { useUI } from '../store/ui';
import type { Profile } from '../types';
import { ChevronLeftIcon } from '../components/Icons';

const STARTERS = [
  'Plan dinners for next week within my calories',
  'What could I eat for the rest of today?',
  "Add this week's shopping list to the Picnic cart",
  "Is anything planned today that I haven't logged?",
];

const STATUS_TEXT: Record<string, string> = { done: 'Done', skipped: 'Skipped', failed: 'Failed' };

function ActionCard({
  entry,
  decision,
  onDecide,
}: {
  entry: Extract<AssistantEntry, { role: 'action' }>;
  decision: 'approve' | 'skip' | undefined;
  onDecide: (d: 'approve' | 'skip') => void;
}) {
  return (
    <div className="rounded-xl border border-line bg-card p-3">
      <p className="text-sm">{entry.text}</p>
      {entry.status === 'pending' ? (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => onDecide('approve')}
            className={`flex-1 rounded-lg py-1.5 text-xs font-semibold ${
              decision === 'approve' ? 'bg-accent text-white' : 'bg-accent-soft text-accent'
            }`}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onDecide('skip')}
            className={`flex-1 rounded-lg py-1.5 text-xs font-semibold ${
              decision === 'skip' ? 'bg-ink-secondary text-white' : 'bg-surface text-ink-secondary'
            }`}
          >
            Skip
          </button>
        </div>
      ) : (
        <p className={`mt-1 text-xs font-medium ${entry.status === 'failed' ? 'text-over' : entry.status === 'done' ? 'text-good' : 'text-ink-muted'}`}>
          {STATUS_TEXT[entry.status]}
          {entry.error ? ` — ${entry.error}` : ''}
        </p>
      )}
    </div>
  );
}

export default function Assistant({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const bump = useUI((s) => s.bump);
  const loaded = useData(() => api.assistant(), []);
  const weights = useData(() => api.getWeights(), []);
  const [state, setState] = useState<AssistantState>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, 'approve' | 'skip'>>({});
  const bottom = useRef<HTMLDivElement>(null);

  const current = state ?? loaded;
  const log = current?.log ?? [];
  const pending = log.filter((e): e is Extract<AssistantEntry, { role: 'action' }> => e.role === 'action' && e.status === 'pending');

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [log.length, busy]);

  async function run(action: () => Promise<AssistantState>) {
    setBusy(true);
    setError(null);
    try {
      setState(await action());
      setDecisions({});
      // Approved changes touch the log, the plan and the cart; let other screens see them.
      bump();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function send(message: string) {
    const trimmed = message.trim();
    if (!trimmed || busy) return;
    const today = todayStr();
    const latest = weights?.length ? [...weights].sort((a, b) => b.date.localeCompare(a.date))[0].weightKg : undefined;
    setText('');
    // Shown straight away; the server's copy replaces it when the answer comes.
    setState({ ...(current ?? { waiting: false }), log: [...log, { role: 'user', text: trimmed }] });
    void run(() =>
      api.assistantSend(trimmed, {
        today,
        budget: computeBudget(profile, today, latest).budget,
        targets: macroTargets(profile),
      }),
    );
  }

  function decide(id: string, d: 'approve' | 'skip') {
    const next = { ...decisions, [id]: d };
    setDecisions(next);
    // Once every proposal has an answer, the assistant carries on.
    if (pending.every((p) => next[p.id])) void run(() => api.assistantDecide(next));
  }

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col pt-[env(safe-area-inset-top)] md:min-h-[calc(100dvh-4rem)]">
      <header className="flex items-center gap-1 px-2 py-3">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-ink-secondary hover:bg-card md:hidden"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <h1 className="flex-1 text-lg font-semibold md:px-2 lg:text-2xl lg:font-bold lg:tracking-tight">Assistant</h1>
        {log.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(api.assistantReset)}
            className="rounded-full px-3 py-1.5 text-sm font-medium text-accent hover:bg-card"
          >
            New chat
          </button>
        )}
      </header>

      <div className="flex-1 space-y-3 px-4 lg:px-0">
        {current?.configured === false && (
          <p className="text-sm text-ink-muted">
            Not set up on this server. Set <code className="text-xs">GEMINI_API_KEY</code> to use it.
          </p>
        )}
        {log.length === 0 && current?.configured !== false && (
          <div className="flex flex-col gap-2">
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="rounded-xl border border-line bg-card px-3 py-2.5 text-left text-sm text-ink-secondary hover:bg-surface"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {log.map((entry, i) =>
          entry.role === 'action' ? (
            <ActionCard
              key={entry.id}
              entry={entry}
              decision={decisions[entry.id]}
              onDecide={(d) => decide(entry.id, d)}
            />
          ) : (
            <div key={i} className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <p
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm ${
                  entry.role === 'user' ? 'bg-accent text-white' : 'border border-line bg-card'
                }`}
              >
                {entry.text}
              </p>
            </div>
          ),
        )}
        {busy && <p className="text-sm text-ink-muted">…</p>}
        {error && <p className="text-sm text-over">{error}</p>}
        <div ref={bottom} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
        className="sticky bottom-24 mx-4 mt-3 mb-2 flex items-end gap-2 rounded-2xl border border-line bg-card p-2 shadow-sm md:bottom-4 lg:mx-0"
      >
        <textarea
          rows={1}
          value={text}
          placeholder={pending.length ? 'Approve or skip first' : 'Ask about meals, plans or groceries'}
          disabled={pending.length > 0 || current?.configured === false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          className="max-h-32 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
        />
        <button
          type="submit"
          disabled={busy || !text.trim() || pending.length > 0}
          className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
