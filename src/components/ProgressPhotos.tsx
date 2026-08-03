import { useRef, useState } from 'react';
import { api, type ProgressPhoto } from '../lib/api';
import { useData } from '../lib/useData';
import { compressPhoto } from '../lib/photo';
import { shortDate, todayStr } from '../lib/dates';
import { useUI } from '../store/ui';
import { CameraIcon, ChevronLeftIcon, ChevronRightIcon, TrashIcon, XIcon } from './Icons';

// Progress photos: one strip of dated thumbnails, and a viewer that flips
// through time. Photos live on the app's own server behind its login —
// nowhere else.

function Viewer({
  photos,
  index,
  onIndex,
  onClose,
  onDelete,
}: {
  photos: ProgressPhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDelete: (photo: ProgressPhoto) => void;
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

export default function ProgressPhotos() {
  const bump = useUI((s) => s.bump);
  const photos = useData(() => api.listPhotos(), []) ?? [];
  const [viewing, setViewing] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function addPhoto(file: File) {
    setUploading(true);
    setError(null);
    try {
      const blob = await compressPhoto(file);
      await api.uploadPhoto(todayStr(), blob);
      bump();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the photo.");
    } finally {
      setUploading(false);
    }
  }

  async function remove(photo: ProgressPhoto) {
    if (!window.confirm(`Delete the photo from ${shortDate(photo.date)}?`)) return;
    await api.deletePhoto(photo.id);
    setViewing(null);
    bump();
  }

  return (
    <section className="mx-4 mt-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold">Progress photos</h2>
        <button
          type="button"
          disabled={uploading}
          onClick={() => input.current?.click()}
          className="flex items-center gap-1.5 rounded-full border border-accent px-3 py-1.5 text-xs font-semibold text-accent disabled:opacity-50"
        >
          <CameraIcon className="h-4 w-4" />
          {uploading ? 'Saving…' : 'Add photo'}
        </button>
      </div>
      <p className="mb-3 text-xs text-ink-muted">
        Stored only on your own server. Tap one to browse through time.
      </p>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="user"
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
              onClick={() => setViewing(i)}
              className="shrink-0 text-center"
            >
              <img
                src={api.photoUrl(p.id)}
                alt={`Progress photo from ${p.date}`}
                loading="lazy"
                className="h-24 w-20 rounded-lg border border-line object-cover"
              />
              <span className="mt-1 block text-[11px] text-ink-muted">{shortDate(p.date)}</span>
            </button>
          ))}
        </div>
      )}

      {viewing != null && photos[viewing] && (
        <Viewer
          photos={photos}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
          onDelete={remove}
        />
      )}
    </section>
  );
}
