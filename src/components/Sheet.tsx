import type { ReactNode } from 'react';

// Bottom sheet used for serving sizes, exercise details, quick-add, and weight
// logging — the fast-logging surface of the app.
export default function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div className="absolute bottom-0 left-1/2 w-full max-w-md -translate-x-1/2 rounded-t-2xl bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
        {children}
      </div>
    </div>
  );
}
