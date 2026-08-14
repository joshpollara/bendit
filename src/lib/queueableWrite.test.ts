import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, UNAUTHORIZED_EVENT } from './api';
import { useQueue } from './offlineQueue';

// What happens to a write when the server answers, and when it doesn't.
//
// These exist because the two were once handled by the same catch, which made a
// refused write indistinguishable from an unreachable one: it was parked in the
// offline queue, the caller was told it had saved, and the next flush discarded
// it for being a refusal. The workout showed up in the day, survived until the
// next sync, and then quietly wasn't there — with nothing on screen at any point
// to say so.

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
vi.stubGlobal('window', { dispatchEvent: vi.fn() });

const exercise = { date: '2026-08-13', name: 'Running', minutes: 30, caloriesBurned: 300 };

const respond = (status: number, body: unknown = {}) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );

beforeEach(() => {
  store.clear();
  useQueue.setState({ queue: [], flushing: false, online: true });
});

describe('a write that can be queued', () => {
  it('parks it when nothing reached the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('failed to fetch'))));
    await api.addExercise(exercise);
    expect(useQueue.getState().queue).toHaveLength(1);
  });

  it('parks it when the server is broken, because that is worth retrying', async () => {
    respond(500);
    await api.addExercise(exercise);
    expect(useQueue.getState().queue).toHaveLength(1);
  });

  it('refuses loudly when the server refuses, instead of pretending it saved', async () => {
    // The flush drops a 4xx to avoid retrying forever, so queueing one here is
    // a promise the app cannot keep.
    respond(400, { error: 'that will not do' });
    await expect(api.addExercise(exercise)).rejects.toThrow('that will not do');
    expect(useQueue.getState().queue).toHaveLength(0);
  });

  it('keeps a write made while signed out, since signing in replays it', async () => {
    respond(401, {});
    await expect(api.addExercise(exercise)).rejects.toThrow('Not signed in.');
    expect(useQueue.getState().queue).toHaveLength(1);
    expect(window.dispatchEvent).toHaveBeenCalled();
    expect(UNAUTHORIZED_EVENT).toBe('bendit:unauthorized');
  });

  it('treats a success with an unreadable body as the success it is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('not json');
        },
      })),
    );
    await api.addExercise(exercise);
    // Re-sending would be the only way to get a saved row wrong.
    expect(useQueue.getState().queue).toHaveLength(0);
  });
});
