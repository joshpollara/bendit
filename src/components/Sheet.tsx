import type { ReactNode } from 'react';

// The app's modal surface. On a phone it's a bottom sheet — thumb-reachable,
// the fast-logging gesture. On a desktop a sheet stuck to the bottom of a 27"
// display is just wrong, so the same content becomes a centred dialog.
export default function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 md:flex md:items-center md:justify-center" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div
        className="absolute bottom-0 left-1/2 w-full max-w-md -translate-x-1/2 rounded-t-2xl bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl
                   md:relative md:bottom-auto md:left-auto md:max-h-[85vh] md:translate-x-0 md:overflow-y-auto md:rounded-2xl md:border md:border-line md:p-6 md:pb-6"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line md:hidden" />
        {children}
      </div>
    </div>
  );
}
