import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { XIcon } from './Icons';

export default function BarcodeScanner({
  onDetected,
  onClose,
}: {
  onDetected: (barcode: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    let controls: IScannerControls | null = null;
    let unmounted = false;
    let fired = false;

    reader
      .decodeFromVideoDevice(undefined, videoRef.current ?? undefined, (result) => {
        if (result && !fired) {
          fired = true;
          onDetected(result.getText());
        }
      })
      .then((c) => {
        controls = c;
        if (unmounted) c.stop();
      })
      .catch(() => {
        if (!unmounted) {
          setError('Camera unavailable. Check permissions, or enter the barcode below.');
        }
      });

    return () => {
      unmounted = true;
      controls?.stop();
    };
  }, [onDetected]);

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
        <video ref={videoRef} className="h-full w-full object-cover" />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-40 w-72 rounded-xl border-2 border-white/80" />
        </div>
        {error && (
          <p className="absolute inset-x-4 top-4 rounded-xl bg-black/70 p-3 text-center text-sm text-white">
            {error}
          </p>
        )}
      </div>

      <form
        className="mx-auto flex w-full max-w-md gap-2 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          const code = manual.trim();
          if (code) onDetected(code);
        }}
      >
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
      </form>
    </div>
  );
}
