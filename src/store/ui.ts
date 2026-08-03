import { create } from 'zustand';
import { todayStr } from '../lib/dates';

interface UIState {
  date: string; // the day the Today screen is showing
  setDate: (date: string) => void;
  revision: number; // bumped after every mutation so views re-fetch
  bump: () => void;
}

export const useUI = create<UIState>()((set) => ({
  date: todayStr(),
  setDate: (date) => set({ date }),
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));
