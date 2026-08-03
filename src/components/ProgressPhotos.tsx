import { useRef, useState } from 'react';
import { api, type ProgressPhoto } from '../lib/api';
import { useData } from '../lib/useData';
import { compressPhoto } from '../lib/photo';
import { shortDate, todayStr } from '../lib/dates';
import { useUI } from '../store/ui';
import { CameraIcon, ChevronLeftIcon, ChevronRightIcon, TrashIcon, XIcon } from './Icons';
import CameraCapture from './CameraCapture';

// Progress photos: one strip of dated thumbnails, and a viewer that flips
// through time. Photos live on the app's own server behind its login —
// nowhere else.

function Viewer({
  photos,
  index,
  onIndex,
  onClose,
  onDelete,
  onRedate,
}: {
  photos: ProgressPhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDelete: (photo: ProgressPhoto) => void;
  onRedate: (photo: ProgressPhoto) => void;
}) {
  const photo = photos[index];
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black" onClick={onClose}>
      <div className="flex items-center justify-between p-3 pt-[max(env(safe-area-inset-top),0.75rem)]">
        <span className="text-sm font-medium text-white">
          {shortDate(photo.date)} · {index + 1} of {photos.length}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            aria-label="Delete this photo"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(photo);
            }}
            className="rounded-full p-2 text-white/70 hover:text-white"
          >
            <TrashIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label="Change the date"
            onClick={(e) => {
              e.stopPropagation();
              onRedate(photo);
            }}
            className="rounded-full px-2 py-2 text-xs font-medium text-white/70 hover:text-white"
          >
            Date
          </button>
          <button type="button" aria-label="Close" className="rounded-full p-2 text-white">
            <XIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="relative flex-1" onClick={(e) => e.stopPropagation()}>
        <img
          src={api.photoUrl(photo.id)}
          alt={`Progress photo from ${photo.date}`}
          className="absolute inset-0 h-full w-full object-contain"
        />
        {index > 0 && (
          <button
            type="button"
            aria-label="Earlier photo"
            onClick={() => onIndex(index - 1)}
            className="absolute left-0 top-0 h-full w-1/3"
          >
            <ChevronLeftIcon className="ml-2 h-8 w-8 text-white/60" />
          </button>
        )}
        {index < photos.length - 1 && (
          <button
            type="button"
            aria-label="Later photo"
            onClick={() => onIndex(index + 1)}
            className="absolute right-0 top-0 flex h-full w-1/3 items-center justify-end"
          >
            <ChevronRightIcon className="mr-2 h-8 w-8 text-white/60" />
          </button>
        )}
      </div>
      <p className="pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2 text-center text-xs text-white/50">
        Tap the edges to move through time.
      </p>
    </div>
  );
}

// Two photos of the user's choosing, side by side, earlier on the left.
function CompareView({ a, b, onClose }: { a: ProgressPhoto; b: ProgressPhoto; onClose: () => void }) {
  const [left, right] = a.date <= b.date ? [a, b] : [b, a];
  const days = Math.round(
    (Date.parse(`${right.date}T00:00:00Z`) - Date.parse(`${left.date}T00:00:00Z`)) / 86_400_000,
  );
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between p-3 pt-[max(env(safe-area-inset-top),0.75rem)]">
        <span className="text-sm font-medium text-white">
          {days > 0 ? `${days} days apart` : 'Same day'}
        </span>
        <button type="button" aria-label="Close comparison" onClick={onClose} className="rounded-full p-2 text-white">
          <XIcon className="h-5 w-5" />
        </button>
      </div>
      <div className="flex flex-1 gap-0.5">
        {[left, right].map((p) => (
          <figure key={p.id} className="relative min-w-0 flex-1">
            <img
              src={api.photoUrl(p.id)}
              alt={`Progress photo from ${p.date}`}
              className="h-full w-full object-cover"
            />
            <figcaption className="absolute bottom-0 inset-x-0 bg-black/50 py-1.5 text-center text-xs text-white">
              {shortDate(p.date)}
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="pb-[max(env(safe-area-inset-bottom),0.5rem)]" />
    </div>
  );
}

export default function ProgressPhotos() {
  const bump = useUI((s) => s.bump);
  const photos = useData(() => api.listPhotos(), []) ?? [];
  const [viewing, setViewing] = useState<number | null>(null);
  const [camera, setCamera] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function togglePick(id: string) {
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : prev.length < 2 ? [...prev, id] : prev,
    );
  }

  function stopPicking() {
    setPicking(false);
    setPicked([]);
  }

  const comparing =
    picked.length === 2
      ? { a: photos.find((p) => p.id === picked[0]), b: photos.find((p) => p.id === picked[1]) }
      : null;

  async function addPhoto(photo: Blob) {
    setCamera(false);
    setUploading(true);
    setError(null);
    try {
      const blob = await compressPhoto(photo);
      await api.uploadPhoto(todayStr(), blob);
      bump();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the photo.");
    } finally {
      setUploading(false);
    }
  }

  // A photo taken yesterday but added today should say yesterday.
  async function redate(photo: ProgressPhoto) {
    const next = window.prompt('Date for this photo (YYYY-MM-DD):', photo.date);
    if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
    await api.setPhotoDate(photo.id, next);
    bump();
  }

  async function remove(photo: ProgressPhoto) {
    if (!window.confirm(`Delete the photo from ${shortDate(photo.date)}?`)) return;
    await api.deletePhoto(photo.id);
    setViewing(null);
    bump();
  }

  return (
    <section className="mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm lg:mx-0 lg:mt-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="flex-1 font-semibold">Progress photos</h2>
        {photos.length >= 2 && (
          <button
            type="button"
            onClick={() => (picking ? stopPicking() : setPicking(true))}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
              picking ? 'bg-accent text-white' : 'border border-line text-ink-secondary'
            }`}
          >
            {picking ? 'Cancel' : 'Compare'}
          </button>
        )}
        <button
          type="button"
          disabled={uploading}
          onClick={() => setCamera(true)}
          className="flex items-center gap-1.5 rounded-full border border-accent px-3 py-1.5 text-xs font-semibold text-accent disabled:opacity-50"
        >
          <CameraIcon className="h-4 w-4" />
          {uploading ? 'Saving…' : 'Add photo'}
        </button>
      </div>
      <p className="mb-3 text-xs text-ink-muted">
        {picking
          ? `Pick two photos to compare${picked.length === 1 ? ' — one more' : ''}.`
          : 'Stored only on your own server. Tap one to browse through time.'}
      </p>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void addPhoto(file);
        }}
      />
      {error && <p className="mb-2 rounded-xl bg-over-soft px-3 py-2 text-xs text-over">{error}</p>}

      {photos.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-muted">
          A photo every week or two shows what the scale can't.
        </p>
      ) : (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {photos.map((p, i) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={picking ? picked.includes(p.id) : undefined}
              onClick={() => (picking ? togglePick(p.id) : setViewing(i))}
              className="shrink-0 text-center"
            >
              <img
                src={api.photoUrl(p.id)}
                alt={`Progress photo from ${p.date}`}
                loading="lazy"
                className={`h-24 w-20 rounded-lg border object-cover ${
                  picking && picked.includes(p.id)
                    ? 'border-2 border-accent'
                    : 'border-line'
                }`}
              />
              <span className="mt-1 block text-[11px] text-ink-muted">{shortDate(p.date)}</span>
            </button>
          ))}
        </div>
      )}

      {camera && (
        <CameraCapture
          onCapture={addPhoto}
          onClose={() => setCamera(false)}
          onPickFile={() => {
            setCamera(false);
            input.current?.click();
          }}
        />
      )}

      {comparing?.a && comparing.b && (
        <CompareView a={comparing.a} b={comparing.b} onClose={stopPicking} />
      )}

      {viewing != null && photos[viewing] && (
        <Viewer
          photos={photos}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
          onDelete={remove}
          onRedate={redate}
        />
      )}
    </section>
  );
}
