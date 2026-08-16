import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingForDate, useQueue, type QueuedWrite } from './offlineQueue';

// A minimal localStorage so the store can persist in a Node test run.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const write = (id: string, date = '2026-08-03'): QueuedWrite => ({
  id,
  path: '/api/food-log',
  body: { id, date, meal: 'lunch', caloriesCached: 500, servings: 1 },
  date,
  queuedAt: 1,
});

beforeEach(() => {
  store.clear();
  useQueue.setState({ queue: [], flushing: false, online: true });
});

describe('the offline queue', () => {
  it('keeps writes in the order they were made', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        seen.push(JSON.parse(init.body as string).id);
        return { ok: true, status: 200 } as Response;
      }),
    );

    useQueue.getState().enqueue(write('a'));
    useQueue.getState().enqueue(write('b'));
    useQueue.getState().enqueue(write('c'));

    expect(await useQueue.getState().flush()).toBe(3);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(useQueue.getState().queue).toEqual([]);
  });

  it('replays an idempotent feedback update with its original method', async () => {
    let method = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        method = init.method ?? '';
        return { ok: true, status: 200 } as Response;
      }),
    );
    useQueue.getState().enqueue({
      id: 'meal-feedback:run-1',
      path: '/api/meals/estimate/run-1/feedback',
      method: 'PUT',
      body: { outcome: 'dismissed' },
      queuedAt: 1,
    });

    expect(await useQueue.getState().flush()).toBe(1);
    expect(method).toBe('PUT');
  });

  it('keeps everything queued while the network is still down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    useQueue.getState().enqueue(write('a'));
    useQueue.getState().enqueue(write('b'));

    expect(await useQueue.getState().flush()).toBe(0);
    expect(useQueue.getState().queue).toHaveLength(2);
  });

  it('retries server errors but drops what the server refused', async () => {
    // A 500 is worth another go; a 400 would retry forever.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_p: string, init: RequestInit) => {
        const id = JSON.parse(init.body as string).id;
        return { ok: false, status: id === 'keep' ? 503 : 400 } as Response;
      }),
    );
    useQueue.getState().enqueue(write('keep'));
    useQueue.getState().enqueue(write('drop'));

    await useQueue.getState().flush();
    expect(useQueue.getState().queue.map((w) => w.id)).toEqual(['keep']);
  });

  it('survives a reload — the queue is persisted, not held in memory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    useQueue.getState().enqueue(write('a'));
    await useQueue.getState().flush();

    const persisted = JSON.parse(store.get('bendit-queue') ?? '[]') as QueuedWrite[];
    expect(persisted.map((w) => w.id)).toEqual(['a']);
  });

  it('will not flush twice at once', async () => {
    let inFlight = 0;
    let overlapped = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight++;
        if (inFlight > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { ok: true, status: 200 } as Response;
      }),
    );
    useQueue.getState().enqueue(write('a'));
    useQueue.getState().enqueue(write('b'));

    const [first, second] = await Promise.all([
      useQueue.getState().flush(),
      useQueue.getState().flush(),
    ]);
    expect(overlapped).toBe(false);
    expect(first + second).toBe(2); // sent once in total, not twice
  });

  it('picks out the writes belonging to one day', () => {
    const queue = [write('a', '2026-08-03'), write('b', '2026-08-04'), write('c', '2026-08-03')];
    expect(pendingForDate(queue, '2026-08-03').map((w) => w.id)).toEqual(['a', 'c']);
  });
});
