import { useCallback, useEffect, useRef, useState } from 'react';
import { XIcon } from './Icons';

// In-app camera for progress photos: live preview, front/back flip, capture,
// then a confirm step. The preview of the front camera is mirrored (that's
// what a mirror shows you); the saved photo is the true, un-mirrored image so
// photos stay comparable over time whichever camera took them.

type Facing = 'user' | 'environment';

export default function CameraCapture({
  onCapture,
  onClose,
  onPickFile,
  facing: initialFacing = 'user',
  title,
  hint,
}: {
  onCapture: (photo: Blob) => void;
  onClose: () => void;
  /** Fallback path: pick an existing photo instead of taking one. */
  onPickFile: () => void;
  /** Which camera to open with: yourself, or what you're looking at. */
  facing?: Facing;
  title?: string;
  hint?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<Facing>(initialFacing);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1920 } },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Couldn't open the camera. Check permissions, or pick a photo instead.");
        }
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [facing, stop]);

  // Clean up the preview object URL for whichever shot is discarded.
  useEffect(() => {
    return () => {
      if (shot) URL.revokeObjectURL(shot.url);
    };
  }, [shot]);

  function takePhoto() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) setShot({ blob, url: URL.createObjectURL(blob) });
      },
      'image/jpeg',
      0.92, // light touch here; the upload path compresses properly
    );
  }

  function confirm() {
    if (!shot) return;
    stop();
    onCapture(shot.blob);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between p-4 pt-[max(env(safe-area-inset-top),1rem)] text-white">
        <h2 className="font-semibold">{shot ? 'Use this photo?' : (title ?? 'Progress photo')}</h2>
        <button type="button" aria-label="Close camera" onClick={onClose} className="rounded-full p-2">
          <XIcon className="h-5 w-5" />
        </button>
      </div>

      <div className="relative mx-auto w-full max-w-md flex-1 overflow-hidden">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          playsInline
          muted
          className={`h-full w-full object-cover ${facing === 'user' ? '-scale-x-100' : ''} ${shot ? 'hidden' : ''}`}
        />
        {shot && (
          <img src={shot.url} alt="Captured preview" className="h-full w-full object-contain" />
        )}
        {error && !shot && (
          <p className="absolute inset-x-4 top-4 rounded-xl bg-black/70 p-3 text-center text-sm text-white">
            {error}
          </p>
        )}
        {hint && !shot && !error && (
          <p className="absolute inset-x-4 bottom-4 rounded-xl bg-black/50 p-2.5 text-center text-xs text-white">
            {hint}
          </p>
        )}
      </div>

      <div className="mx-auto flex w-full max-w-md items-center justify-around p-5 pb-[max(env(safe-area-inset-bottom),1.25rem)]">
        {shot ? (
          <>
            <button
              type="button"
              onClick={() => setShot(null)}
              className="rounded-full border border-white/40 px-5 py-2.5 text-sm font-semibold text-white"
            >
              Retake
            </button>
            <button
              type="button"
              onClick={confirm}
              className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white"
            >
              Use photo
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onPickFile}
              className="w-20 text-left text-xs font-medium text-white/70"
            >
              Pick from library
            </button>
            <button
              type="button"
              aria-label="Take photo"
              onClick={takePhoto}
              disabled={!!error}
              className="h-16 w-16 rounded-full border-4 border-white bg-white/30 disabled:opacity-40"
            />
            <button
              type="button"
              onClick={() => setFacing(facing === 'user' ? 'environment' : 'user')}
              className="w-20 text-right text-xs font-medium text-white/70"
            >
              Flip camera
            </button>
          </>
        )}
      </div>
    </div>
  );
}
