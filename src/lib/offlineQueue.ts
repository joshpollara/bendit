import { create } from 'zustand';

// Logging that survives a dead connection.
//
// Supermarket basements, planes, the back of a gym: the moments you most want
// to log are the ones with no signal. Writes that fail for want of a network
// are parked here and replayed when it comes back.
//
// Two rules keep this honest:
//   • Only appends are queued. A queued "add" is safe to replay because the
//     client generates its id and the server ignores a repeat. Edits and
//     deletes of rows that may not exist yet are not, so they still need a
//     connection.
//   • A request that reached the server and was refused (a 4xx) is a real
//     failure, not a network problem, and is never queued — otherwise a bad
//     request would retry forever.

export interface QueuedWrite {
  /** The entry's own id, so replaying can't duplicate it. */
  id: string;
  path: string;
  /** Appends use POST; idempotent terminal updates such as feedback use PUT. */
  method?: 'POST' | 'PUT';
  body: unknown;
  /** Which day this write belongs to, for showing pending items in context. */
  date?: string;
  queuedAt: number;
}

const STORAGE_KEY = 'bendit-queue';

function load(): QueuedWrite[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as QueuedWrite[]) : [];
  } catch {
    return [];
  }
}

function save(queue: QueuedWrite[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // A full or unavailable store shouldn't break logging.
  }
}

interface QueueState {
  queue: QueuedWrite[];
  online: boolean;
  flushing: boolean;
  enqueue: (write: QueuedWrite) => void;
  flush: () => Promise<number>;
  setOnline: (online: boolean) => void;
}

export const useQueue = create<QueueState>((set, get) => ({
  queue: load(),
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  flushing: false,

  enqueue: (write) =>
    set((s) => {
      const queue = [...s.queue, write];
      save(queue);
      return { queue };
    }),

  setOnline: (online) => set({ online }),

  /** Sends everything in order, keeping anything that still won't go through. */
  flush: async () => {
    const { queue, flushing } = get();
    if (flushing || queue.length === 0) return 0;
    set({ flushing: true });

    const remaining: QueuedWrite[] = [];
    let sent = 0;
    for (const write of queue) {
      try {
        const res = await fetch(write.path, {
          method: write.method ?? 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(write.body),
        });
        if (res.ok) {
          sent++;
        } else if (res.status >= 500 || res.status === 401) {
          remaining.push(write); // server trouble or signed out — worth retrying
        }
        // Anything else the server actively refused; dropping it stops a loop.
      } catch {
        remaining.push(write); // still offline
      }
    }

    save(remaining);
    set({ queue: remaining, flushing: false });
    return sent;
  },
}));

/** Watches the connection and drains the queue whenever it comes back. */
export function initQueue() {
  const sync = () => {
    useQueue.getState().setOnline(navigator.onLine);
    if (navigator.onLine) void useQueue.getState().flush();
  };
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  // Returning to the app is also a good moment to try again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });
  sync();
}

/** Pending writes for one day, so the log can show them before they sync. */
export function pendingForDate(queue: QueuedWrite[], date: string): QueuedWrite[] {
  return queue.filter((w) => w.date === date);
}
