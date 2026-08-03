import { create } from 'zustand';
import { todayStr } from '../lib/dates';

interface UIState {
  date: string; // the day the Today screen is showing
  setDate: (date: string) => void;
}

export const useUI = create<UIState>()((set) => ({
  date: todayStr(),
  setDate: (date) => set({ date }),
}));
