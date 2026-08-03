import { create } from 'zustand';

// Light, dark, or whatever the phone is set to. The choice lives in
// localStorage and is applied as data-theme on <html>, which the token
// overrides in index.css key off.

export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'bendit-theme';

function apply(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

function stored(): ThemeMode {
  const saved = localStorage.getItem(KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

interface ThemeState {
  mode: ThemeMode;
  /** Bumped whenever the effective theme changes, so charts re-read tokens. */
  revision: number;
  setMode: (mode: ThemeMode) => void;
}

export const useTheme = create<ThemeState>((set) => ({
  mode: stored(),
  revision: 0,
  setMode: (mode) => {
    localStorage.setItem(KEY, mode);
    apply(mode);
    set((s) => ({ mode, revision: s.revision + 1 }));
  },
}));

/** Applies the saved choice before first paint and follows the OS afterwards. */
export function initTheme() {
  apply(stored());
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () =>
      useTheme.setState((s) => ({ revision: s.revision + 1 })),
    );
}
