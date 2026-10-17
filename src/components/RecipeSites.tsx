import { useEffect, useState } from 'react';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import { api, type RecipeSite, type RecipeSitePost } from '../lib/api';
import { useData } from '../lib/useData';
import { SearchIcon, TrashIcon } from './Icons';

// What's new on the household's favourite recipe sites, and searching them.
// Importing a post is the same as pasting its link.

const SHOWN = 12;

function PostRow({ post, busy, onImport }: { post: RecipeSitePost; busy: boolean; onImport: () => void }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      {post.image ? (
        <img src={post.image} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-lg bg-surface object-cover" />
      ) : (
        <span className="h-12 w-12 shrink-0 rounded-lg bg-surface" />
      )}
      <a href={post.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm font-medium">{post.title}</span>
        <span className="block truncate text-xs text-ink-muted">
          {post.site}
          {post.date ? ` · ${formatDistanceToNowStrict(parseISO(post.date), { addSuffix: true })}` : ''}
        </span>
      </a>
      {post.imported ? (
        <span className="shrink-0 text-xs text-ink-muted">Saved</span>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={onImport}
          className="shrink-0 rounded-full bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent disabled:opacity-50"
        >
          Import
        </button>
      )}
    </li>
  );
}

export default function RecipeSites({
  busy,
  onImport,
}: {
  /** An import is under way. */
  busy: boolean;
  onImport: (url: string) => void;
}) {
  const [reload, setReload] = useState(0);
  const sites = useData(() => api.recipeSites(), [reload]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query]);

  const posts = useData(
    () => (sites?.length ? api.recipeSitePosts(search) : Promise.resolve([] as RecipeSitePost[])),
    [search, sites?.length],
  );

  async function add() {
    if (!adding.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.addRecipeSite(adding.trim());
      setAdding('');
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that site.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(site: RecipeSite) {
    if (!window.confirm(`Stop following ${site.name}?`)) return;
    await api.removeRecipeSite(site.id);
    setReload((n) => n + 1);
  }

  if (!sites) return null;
  const empty = sites.length === 0;
  const shown = all ? (posts ?? []) : (posts ?? []).slice(0, SHOWN);
  const searchable = sites.some((s) => s.kind === 'wordpress');

  const addForm = (
    <form
      className="mt-2 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <input
        className="min-w-0 flex-1 rounded-xl border border-line bg-card px-3 py-2 text-sm"
        placeholder="skinnytaste.com"
        inputMode="url"
        value={adding}
        onChange={(e) => setAdding(e.target.value)}
      />
      <button
        type="submit"
        disabled={!adding.trim() || saving}
        className="rounded-xl border border-line px-3 text-sm font-semibold text-ink-secondary disabled:opacity-40"
      >
        {saving ? 'Adding…' : 'Add site'}
      </button>
    </form>
  );

  return (
    <section className="rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">From your sites</h2>
        {!empty && (
          <button type="button" onClick={() => setEditing((v) => !v)} className="text-sm font-medium text-accent">
            {editing ? 'Done' : 'Sites'}
          </button>
        )}
      </div>

      {(empty || editing) && (
        <>
          {editing && (
            <ul className="mt-2 divide-y divide-line">
              {sites.map((site) => (
                <li key={site.id} className="flex items-center gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{site.name}</span>
                  <span className="text-xs text-ink-muted">{new URL(site.origin).hostname.replace(/^www\./, '')}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${site.name}`}
                    onClick={() => void remove(site)}
                    className="rounded-full p-1.5 text-ink-muted hover:bg-surface hover:text-over"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {addForm}
          {error && <p className="mt-2 text-xs text-over">{error}</p>}
        </>
      )}

      {!empty && !editing && (
        <>
          {searchable && (
            <div className="mt-2 flex items-center gap-2 rounded-xl border border-line bg-surface px-3">
              <SearchIcon className="h-4 w-4 shrink-0 text-ink-muted" />
              <input
                type="search"
                placeholder="Search your sites"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full bg-transparent py-2 text-sm outline-none"
              />
            </div>
          )}
          {posts === undefined ? (
            <p className="py-4 text-center text-sm text-ink-muted">Loading…</p>
          ) : posts.length === 0 ? (
            <p className="py-4 text-center text-sm text-ink-muted">{search ? 'Nothing found.' : 'Nothing new.'}</p>
          ) : (
            <ul className="mt-1 divide-y divide-line">
              {shown.map((post) => (
                <PostRow key={post.url} post={post} busy={busy} onImport={() => onImport(post.url)} />
              ))}
            </ul>
          )}
          {!all && (posts?.length ?? 0) > SHOWN && (
            <button type="button" onClick={() => setAll(true)} className="mt-1 text-sm font-medium text-accent">
              Show more
            </button>
          )}
        </>
      )}
    </section>
  );
}
