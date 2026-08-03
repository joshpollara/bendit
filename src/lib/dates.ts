import { addDays, format, isToday, isYesterday, parseISO } from 'date-fns';

export const DAY = 'yyyy-MM-dd';

export const todayStr = (): string => format(new Date(), DAY);

export const shiftDay = (date: string, days: number): string =>
  format(addDays(parseISO(date), days), DAY);

export function dayLabel(date: string): string {
  const d = parseISO(date);
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'EEE, MMM d');
}

export const shortDate = (date: string): string => format(parseISO(date), 'MMM d');
