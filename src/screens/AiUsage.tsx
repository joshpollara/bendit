import { useNavigate } from 'react-router-dom';
import { api, type UsageTally, type VisionUsage } from '../lib/api';
import { useData } from '../lib/useData';
import { ChevronLeftIcon } from '../components/Icons';

// What the model has been asked to do and what it came to. Every call is
// already logged by the server, successes and failures alike; this reads that
// log back.

const TASK_LABELS: Record<string, string> = {
  label: 'Nutrition labels',
  meal: 'Meal photos',
  recipe: 'Recipes',
};

const ERROR_LABELS: Record<string, string> = {
  timeout: 'Took too long',
  rate_limited: 'Rate limited',
  quota_exceeded: 'Daily limit reached',
  provider_error: 'Provider error',
  network_error: 'Could not connect',
  empty_response: 'Nothing readable came back',
  bad_json: 'Unreadable answer',
  unconfigured: 'No model configured',
  unknown: 'Unknown',
};

const card = 'mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm lg:mx-0';
const heading = 'text-sm font-semibold';

/** Fractions of a cent matter here: a whole day of reads is often under 5¢. */
function money(usd: number | null): string {
  if (usd == null) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Thousands throughout, so a column of them can be compared at a glance. */
function tokens(n: number | null): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000).toLocaleString()}k`;
}

function latency(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function when(iso: string): string {
  const at = new Date(iso);
  const today = new Date().toDateString() === at.toDateString();
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return today ? time : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function Row({ label, tally }: { label: string; tally: UsageTally }) {
  return (
    <tr className="border-t border-line">
      <td className="py-2 pr-2">{label}</td>
      <td className="py-2 pr-2 text-right tabular-nums">{tally.calls.toLocaleString()}</td>
      <td className="py-2 pr-2 text-right tabular-nums">
        {tally.errors > 0 ? <span className="text-over">{tally.errors}</span> : '—'}
      </td>
      <td className="py-2 pr-2 text-right tabular-nums">
        {tokens(tally.inputTokens + tally.outputTokens)}
      </td>
      <td className="py-2 text-right tabular-nums">{money(tally.costUsd)}</td>
    </tr>
  );
}

function Head() {
  return (
    <thead className="text-xs text-ink-muted">
      <tr>
        <th className="pb-1 text-left font-medium">&nbsp;</th>
        <th className="pb-1 pr-2 text-right font-medium">Calls</th>
        <th className="pb-1 pr-2 text-right font-medium">Failed</th>
        <th className="pb-1 pr-2 text-right font-medium">Tokens</th>
        <th className="pb-1 text-right font-medium">Cost</th>
      </tr>
    </thead>
  );
}

function Model({ usage }: { usage: VisionUsage }) {
  const price = usage.prices[usage.model];
  const used = Math.min(1, usage.dailyLimit ? usage.usedToday / usage.dailyLimit : 0);

  return (
    <section className={card}>
      <h2 className={heading}>{usage.model}</h2>
      <p className="mt-0.5 text-xs text-ink-muted">
        {usage.provider}
        {price
          ? ` · $${price.input.toFixed(2)} per million tokens in, $${price.output.toFixed(2)} out`
          : ' · no rate for this model here'}
      </p>
      {!usage.configured && (
        <p className="mt-2 text-xs text-warn-deep">No API key is set on this server.</p>
      )}

      <div className="mt-3 flex items-baseline justify-between text-sm">
        <span className="text-ink-secondary">Today</span>
        <span className="tabular-nums">
          {usage.usedToday} of {usage.dailyLimit} calls
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface">
        <div
          className={`h-full rounded-full ${used >= 1 ? 'bg-over' : 'bg-accent'}`}
          style={{ width: `${Math.max(used * 100, usage.usedToday > 0 ? 2 : 0)}%` }}
        />
      </div>
    </section>
  );
}

function Windows({ usage }: { usage: VisionUsage }) {
  const { today, week, month, all } = usage.windows;
  const unpriced = all.unpricedCalls;

  return (
    <section className={card}>
      <h2 className={heading}>Usage</h2>
      <table className="mt-2 w-full text-sm">
        <Head />
        <tbody>
          {[today, week, month, all].map((w) => (
            <Row key={w.label} label={w.label} tally={w} />
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-ink-muted">
        Cost is worked out from the tokens each call used, at this server's rates. It is an
        estimate, not the provider's invoice.
        {unpriced > 0 &&
          ` ${unpriced} ${unpriced === 1 ? 'call is' : 'calls are'} on a model with no rate here and left out of the totals.`}
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        Typical read {latency(month.medianLatencyMs)}, slowest 5% over{' '}
        {latency(month.p95LatencyMs)}.
      </p>
    </section>
  );
}

function ByTask({ usage }: { usage: VisionUsage }) {
  if (usage.byTask.length === 0) return null;
  return (
    <section className={card}>
      <h2 className={heading}>By feature</h2>
      <p className="text-xs text-ink-muted">Last {usage.breakdownDays} days</p>
      <table className="mt-2 w-full text-sm">
        <Head />
        <tbody>
          {usage.byTask.map((t) => (
            <Row key={t.task} label={TASK_LABELS[t.task] ?? t.task} tally={t} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Failures({ usage }: { usage: VisionUsage }) {
  if (usage.byError.length === 0) return null;
  return (
    <section className={card}>
      <h2 className={heading}>Failures</h2>
      <p className="text-xs text-ink-muted">Last {usage.breakdownDays} days</p>
      <ul className="mt-2 text-sm">
        {usage.byError.map((e) => (
          <li key={e.code} className="flex justify-between border-t border-line py-2">
            <span>{ERROR_LABELS[e.code] ?? e.code}</span>
            <span className="tabular-nums text-ink-secondary">{e.calls}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Recent({ usage }: { usage: VisionUsage }) {
  if (usage.recent.length === 0) return null;
  return (
    <section className={`${card} p-0`}>
      <h2 className={`${heading} px-4 pt-4`}>Recent calls</h2>
      <ul>
        {usage.recent.map((c) => (
          <li key={c.id} className="flex items-center gap-3 border-t border-line px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{TASK_LABELS[c.task] ?? c.task}</span>
              <span className="block text-xs text-ink-muted">
                {when(c.createdAt)}
                {c.status === 'ok'
                  ? ` · ${latency(c.latencyMs)}`
                  : ` · ${ERROR_LABELS[c.errorCode ?? 'unknown'] ?? c.errorCode}`}
              </span>
            </span>
            <span className="text-right text-xs text-ink-muted tabular-nums">
              {c.status === 'ok' ? tokens((c.inputTokens ?? 0) + (c.outputTokens ?? 0)) : ''}
            </span>
            <span
              className={`w-14 text-right text-sm tabular-nums ${
                c.status === 'ok' ? 'text-ink-secondary' : 'text-over'
              }`}
            >
              {c.status === 'ok' ? money(c.costUsd) : 'failed'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function AiUsage() {
  const navigate = useNavigate();
  const usage = useData(() => api.visionUsage(), []);

  return (
    <div className="pt-[env(safe-area-inset-top)] pb-4">
      <header className="flex items-center gap-1 px-2 py-3">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-ink-secondary hover:bg-card md:hidden"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold md:px-2 lg:text-2xl lg:font-bold lg:tracking-tight">
          AI usage
        </h1>
      </header>

      {usage === undefined ? (
        <p className="px-4 text-sm text-ink-muted">Loading…</p>
      ) : usage.windows.all.calls === 0 ? (
        <>
          <Model usage={usage} />
          <p className="mx-4 mt-3 text-sm text-ink-muted lg:mx-0">No calls yet.</p>
        </>
      ) : (
        <>
          <Model usage={usage} />
          <Windows usage={usage} />
          <ByTask usage={usage} />
          <Failures usage={usage} />
          <Recent usage={usage} />
        </>
      )}
    </div>
  );
}
