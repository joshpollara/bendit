import { useEffect, useRef, useState } from 'react';
import { startScanning, type Scanner } from '../lib/barcodeScan';
import { isValidBarcode, normalizeBarcode } from '../lib/barcode';
import { XIcon } from './Icons';

export default function BarcodeScanner({
  onDetected,
  onNoBarcode,
  onClose,
}: {
  onDetected: (barcode: string) => void;
  /** Loose produce and anything foreign-labelled has no code to scan. */
  onNoBarcode: () => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [struggling, setStruggling] = useState<'slow' | 'rejected' | null>(null);
  const [manual, setManual] = useState('');

  // The callback is read through a ref rather than depended on. A parent that
  // declares it inline hands over a new function on every one of its renders,
  // and this effect opens a camera: as a dependency it tore the stream down and
  // opened another one mid-scan, for no change anybody asked for.
  const detected = useRef(onDetected);
  detected.current = onDetected;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let scanner: Scanner | null = null;
    let unmounted = false;

    // Nothing has been read yet. Said out loud after a while, because a preview
    // that decodes nothing looks exactly like a preview that is about to.
    const slow = setTimeout(() => {
      if (!unmounted) setStruggling((current) => current ?? 'slow');
    }, 12_000);

    // The camera is opened here rather than by the decoder, so both engines get
    // the same stream and the back camera is asked for explicitly — a phone
    // defaults to the front one, which never sees the packet.
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
      .then(async (opened) => {
        stream = opened;
        // Closed while the permission prompt was up. The stream still has to be
        // handed back: a track left running holds the camera against the next
        // attempt, and the indicator light stays on to say so.
        if (unmounted || !videoRef.current) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        videoRef.current.srcObject = opened;
        await videoRef.current.play().catch(() => {});
        try {
          scanner = await startScanning(videoRef.current, (code) => detected.current(code), {
            onReject: () => {
              if (!unmounted) setStruggling('rejected');
            },
          });
          if (unmounted) scanner.stop();
        } catch {
          // The camera is fine; the decoder isn't. Saying "check permissions"
          // here would send someone into Settings for no reason.
          if (!unmounted) setError('Barcode reading failed. Enter the number below instead.');
        }
      })
      .catch(() => {
        if (!unmounted) {
          setError('Camera unavailable. Check permissions, or enter the barcode below.');
        }
      });

    return () => {
      unmounted = true;
      clearTimeout(slow);
      scanner?.stop();
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const typed = normalizeBarcode(manual);
  const typedLooksWrong = typed.length >= 8 && !isValidBarcode(typed);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between p-4 text-white">
        <h2 className="font-semibold">Scan a barcode</h2>
        <button type="button" aria-label="Close scanner" onClick={onClose} className="rounded-full p-2">
          <XIcon className="h-5 w-5" />
        </button>
      </div>

      <div className="relative mx-auto w-full max-w-md flex-1">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-40 w-72 rounded-xl border-2 border-white/80" />
        </div>
        {(error || struggling) && (
          <p className="absolute inset-x-4 top-4 rounded-xl bg-black/70 p-3 text-center text-sm text-white">
            {error ??
              (struggling === 'rejected'
                ? "That code didn't come through cleanly. Hold steady, or type the number below."
                : 'Still looking. Fill the box with the barcode — or type the number below.')}
          </p>
        )}
      </div>

      <form
        className="mx-auto w-full max-w-md p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed) onDetected(typed);
        }}
      >
        <div className="flex gap-2">
          <input
            type="text"
            inputMode="numeric"
            placeholder="Or type the barcode number"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            className="flex-1 rounded-xl border border-line bg-card px-3 py-2.5 text-sm"
          />
          <button
            type="submit"
            className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white"
          >
            Look up
          </button>
        </div>
        {/* A warning, not a block: the number may be right and the check digit
            simply mistyped, and looking it up costs nothing. */}
        {typedLooksWrong && (
          <p className="mt-2 text-center text-xs text-white/70">
            That doesn&apos;t look like a complete barcode — check the digits.
          </p>
        )}
        <button
          type="button"
          onClick={onNoBarcode}
          className="mt-3 w-full py-2 text-center text-sm font-medium text-white/80"
        >
          No barcode — photograph the label
        </button>
      </form>
    </div>
  );
}
