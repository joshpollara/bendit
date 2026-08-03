import { useTheme } from '../store/theme';

// Charts can't use Tailwind classes for stroke and fill values, so they read
// the same CSS custom properties the rest of the app is styled with. Re-read
// whenever the theme changes, so a switch to dark repaints the charts too.

export interface ChartColors {
  accent: string;
  muted: string;
  grid: string;
  good: string;
  over: string;
  card: string;
}

function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function useChartColors(): ChartColors {
  // Subscribing to the revision is what makes this recompute on theme change.
  useTheme((s) => s.revision);
  return {
    accent: token('--color-accent', '#2a70a0'),
    muted: token('--color-ink-muted', '#8a939c'),
    grid: token('--color-line', '#e7e5e0'),
    good: token('--color-good', '#2e7d4f'),
    over: token('--color-over', '#c03b2d'),
    card: token('--color-card', '#ffffff'),
  };
}
