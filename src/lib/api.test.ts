import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

describe('recipe photo API', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('preserves a structured server error instead of showing [object Object]', async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: false,
        status: 504,
        statusText: 'Gateway Timeout',
        json: async () => ({
          error: {
            code: 'timeout',
            message: 'The AI provider took too long.',
          },
        }),
      }) as Response,
    );
    vi.stubGlobal('fetch', fetchImpl);

    await expect(api.recipeFromPhoto('AAAA')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'timeout',
      status: 504,
      message: 'The AI provider took too long.',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('stops a suspended request after the browser deadline', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const rejection = expect(api.recipeFromPhoto('AAAA')).rejects.toMatchObject({
      code: 'timeout',
      status: 504,
    });
    await vi.runAllTimersAsync();
    await rejection;
  });
});
