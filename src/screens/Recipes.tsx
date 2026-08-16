import { lazy, Suspense, useRef, useState } from 'react';
import { ApiError, api, type Recipe, type RecipeDraft } from '../lib/api';
import { useData } from '../lib/useData';
import { resizeForModel } from '../lib/vision';
import { formatCalories } from '../lib/units';
import { CameraIcon, ChipIcon, SparkleIcon, TrashIcon } from '../components/Icons';
import RecipeEditor from '../components/RecipeEditor';

const CameraCapture = lazy(() => import('../components/CameraCapture'));

// Recipes, and what one serving of each comes to.
//
// Everything here is shared: a recipe anyone adds is a recipe everyone can see
// and log. Editing stays with whoever added it.

const card = 'rounded-2xl border border-line bg-card p-4 shadow-sm';

const retryablePhotoCodes = new Set(['timeout', 'network_error', 'provider_error']);

export function canRetryRecipePhoto(error: unknown) {
  return !(error instanceof ApiError) || retryablePhotoCodes.has(error.code ?? '');
}

export function recipePhotoErrorMessage(error: unknown) {
  if (!(error instanceof ApiError)) return "AI couldn't finish reading that photo. Try again.";
  switch (error.code) {
    case 'timeout':
      return 'AI took too long to read that photo. Try again — you won’t need to retake it.';
    case 'network_error':
    case 'provider_error':
      return "AI couldn't finish reading that photo. Try again — you won’t need to retake it.";
    case 'quota_exceeded':
      return "That’s today’s limit on AI photo reads.";
    case 'rate_limited':
      return 'AI photo reading is busy right now. Try again later.';
    case 'unconfigured':
      return 'AI photo reading is not switched on for this server.';
    default:
      return error.message || "Couldn't read that photo.";
  }
}

export default function Recipes() {
  const [reload, setReload] = useState(0);
  const recipes = useData(() => api.recipes(), [reload]);
  const [draft, setDraft] = useState<{ draft: RecipeDraft; id?: string } | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'url' | 'photo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photoToRetry, setPhotoToRetry] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function fromUrl() {
    if (!url.trim() || busy !== null) return;
    setBusy('url');
    setError(null);
    setPhotoToRetry(null);
    try {
      setDraft({ draft: await api.recipeFromUrl(url.trim()) });
      setUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that page.");
    } finally {
      setBusy(null);
    }
  }

  async function pasteUrl() {
    try {
      const pasted = await navigator.clipboard.readText();
      if (pasted.trim()) setUrl(pasted.trim());
    } catch {
      // Clipboard access is optional; the input remains the reliable path.
    }
  }

  async function fromPhoto(photo: Blob | string) {
    if (busy !== null) return;
    setShooting(false);
    setBusy('photo');
    setError(null);
    setPhotoToRetry(null);
    let image: string | null = typeof photo === 'string' ? photo : null;
    if (!image) {
      try {
        image = await resizeForModel(photo as Blob);
      } catch {
        setError("That image couldn't be prepared. Choose another photo.");
        setBusy(null);
        return;
      }
    }
    try {
      setDraft({ draft: await api.recipeFromPhoto(image) });
    } catch (e) {
      setError(recipePhotoErrorMessage(e));
      if (image && canRetryRecipePhoto(e)) setPhotoToRetry(image);
    } finally {
      setBusy(null);
    }
  }

  function blank() {
    if (busy !== null) return;
    setDraft({
      draft: {
        name: '',
        servings: 4,
        servingsStated: true,
        ingredients: [],
        total: { grams: null, calories: null },
        perServing: { grams: null, calories: null, protein: null, carbs: null, fat: null },
        unresolved: [],
        approximate: [],
        sourceType: 'manual',
      },
    });
  }

  async function edit(recipe: Recipe) {
    if (busy !== null) return;
    setDraft({
      id: recipe.id,
      draft: {
        name: recipe.name,
        servings: recipe.servings,
        servingsStated: recipe.servingsStated,
        ingredients: recipe.ingredients,
        instructions: recipe.instructions,
        notes: recipe.notes,
        sourceType: (recipe.sourceType as 'url' | 'photo' | 'manual') ?? 'manual',
        sourceUrl: recipe.sourceUrl,
        total: { grams: recipe.total.grams, calories: recipe.total.calories },
        perServing: {
          grams: recipe.perServing.grams,
          calories: recipe.perServing.calories,
          protein: null,
          carbs: null,
          fat: null,
        },
        unresolved: [],
        approximate: [],
      },
    });
  }

  async function remove(recipe: Recipe) {
    if (!window.confirm(`Delete "${recipe.name}"?`)) return;
    await api.deleteRecipe(recipe.id);
    setReload((n) => n + 1);
  }

  if (draft) {
    return (
      <RecipeEditor
        initial={draft.draft}
        recipeId={draft.id}
        onClose={() => setDraft(null)}
        onSaved={() => {
          setDraft(null);
          setReload((n) => n + 1);
        }}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
      <h1 className="text-xl font-semibold">Recipes</h1>

      <section className="overflow-hidden rounded-2xl border border-accent/30 bg-card shadow-sm">
        <div className="flex items-start gap-3 border-b border-line bg-surface/60 px-4 py-4">
          <span className="rounded-xl bg-accent p-2 text-white">
            <SparkleIcon className="h-5 w-5" />
          </span>
          <div>
            <h2 className="font-semibold">Import a recipe with AI</h2>
            <p className="mt-0.5 text-sm text-ink-secondary">
              Paste a link or photograph a cookbook page. AI will pull out the full recipe for you to check.
            </p>
          </div>
        </div>

        <form
          className="p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void fromUrl();
          }}
        >
          <label className="text-xs font-medium text-ink-secondary" htmlFor="recipe-url">
            Recipe link
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="recipe-url"
              className="min-w-0 flex-1 rounded-xl border border-line bg-card px-3 py-2.5 text-sm"
              placeholder="https://…"
              inputMode="url"
              autoComplete="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {!url && typeof navigator.clipboard?.readText === 'function' && (
              <button
                type="button"
                onClick={() => void pasteUrl()}
                className="rounded-xl border border-line px-3 text-sm font-semibold text-ink-secondary hover:bg-surface"
              >
                Paste
              </button>
            )}
            <button
              type="submit"
              disabled={!url.trim() || busy !== null}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              <SparkleIcon className="h-4 w-4" />
              {busy === 'url' ? 'Importing…' : 'Import'}
            </button>
          </div>

          {busy === 'url' ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-ink-secondary" role="status">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              Reading the page and organizing the recipe…
            </p>
          ) : (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-muted">
              <ChipIcon className="h-3.5 w-3.5" />
              AI checks the page and maps each ingredient to the food database.
            </p>
          )}
        </form>

        <div className="flex gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setError(null);
              setPhotoToRetry(null);
              setShooting(true);
            }}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-accent py-2.5 text-sm font-semibold text-accent disabled:opacity-50"
          >
            <CameraIcon className="h-4 w-4" />
            {busy === 'photo' ? 'AI is reading…' : 'Photograph a page'}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={blank}
            className="rounded-xl border border-line px-4 py-2.5 text-sm font-semibold text-ink-secondary disabled:opacity-50"
          >
            Type it in
          </button>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void fromPhoto(file);
          }}
        />

        {error && (
          <div
            className="mx-4 mb-4 flex items-center gap-3 rounded-xl bg-over-soft px-3 py-2 text-xs text-over"
            role="alert"
          >
            <p className="min-w-0 flex-1">{error}</p>
            {photoToRetry && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void fromPhoto(photoToRetry)}
                className="shrink-0 rounded-lg border border-over/30 px-2.5 py-1.5 font-semibold disabled:opacity-50"
              >
                Try AI again
              </button>
            )}
          </div>
        )}
      </section>

      {recipes?.length === 0 && (
        <p className="px-1 py-6 text-center text-sm text-ink-muted">No recipes yet.</p>
      )}

      <ul className="flex flex-col gap-2">
        {recipes?.map((recipe) => (
          <li key={recipe.id} className={card}>
            <div className="flex items-start gap-3">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void edit(recipe)}
                className="min-w-0 flex-1 text-left disabled:opacity-50"
              >
                <p className="truncate font-medium">{recipe.name}</p>
                <p className="truncate text-xs text-ink-muted">
                  {recipe.servings} servings · {recipe.ingredients.length} ingredients
                  {recipe.author ? ` · ${recipe.author}` : ''}
                </p>
              </button>
              <div className="text-right">
                <p className="text-sm font-semibold tabular-nums">
                  {recipe.perServing.calories == null
                    ? '—'
                    : `${formatCalories(recipe.perServing.calories)} cal`}
                </p>
                <p className="text-[11px] text-ink-muted">per serving</p>
              </div>
              <button
                type="button"
                aria-label={`Delete ${recipe.name}`}
                onClick={() => void remove(recipe)}
                className="rounded-full p-1.5 text-ink-muted hover:bg-surface hover:text-over"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          </li>
        ))}
      </ul>

      {shooting && (
        <Suspense fallback={null}>
          <CameraCapture
            facing="environment"
            title="Photograph the recipe"
            hint="Keep the entire readable recipe page in frame, straight and close."
            onCapture={(photo) => void fromPhoto(photo)}
            onClose={() => setShooting(false)}
            onPickFile={() => {
              setShooting(false);
              fileInput.current?.click();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
