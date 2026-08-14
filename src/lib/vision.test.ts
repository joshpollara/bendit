import { describe, expect, it, vi } from 'vitest';
import { requestExtraction, VisionRequestError, visionErrorMessage } from './vision';

// No real requests: what's tested here is how the client behaves when the
// server says no, which is the part a user actually meets.

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const err = (status: number, code: string) =>
  ({ ok: false, status, json: async () => ({ error: { code, message: 'nope' } }) }) as unknown as Response;

const online = { online: true };

describe('requestExtraction', () => {
  it('returns the data and what the call cost', async () => {
    const fetchImpl = vi.fn(async () => ok({ data: { calories: 210 }, meta: { model: 'x' } }));
    const result = await requestExtraction<{ calories: number }>('label', 'AAAA', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...online,
    });
    expect(result.data.calories).toBe(210);
    expect(result.meta.model).toBe('x');
  });

  it('sends the task name and never a prompt', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ok({ data: {}, meta: {} }));
    await requestExtraction('label', 'AAAA', { fetchImpl: fetchImpl as unknown as typeof fetch, ...online });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body).toEqual({ task: 'label', image: 'AAAA', mimeType: 'image/jpeg' });
  });

  it('does not even try when offline — the OCR path takes over instead', async () => {
    const fetchImpl = vi.fn();
    await expect(
      requestExtraction('label', 'AAAA', { fetchImpl: fetchImpl as unknown as typeof fetch, online: false }),
    ).rejects.toMatchObject({ code: 'offline' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('carries the server’s code through so the screen can react to it', async () => {
    for (const [status, code] of [
      [429, 'quota_exceeded'],
      [503, 'unconfigured'],
      [504, 'timeout'],
      [502, 'provider_error'],
    ] as const) {
      const fetchImpl = vi.fn(async () => err(status, code));
      await expect(
        requestExtraction('label', 'AAAA', { fetchImpl: fetchImpl as unknown as typeof fetch, ...online }),
      ).rejects.toMatchObject({ code });
    }
  });

  it('treats a dropped connection as a failure, not a hang', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = await requestExtraction('label', 'AAAA', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...online,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(VisionRequestError);
    expect(error.code).toBe('network_error');
  });

  it('gives up on a request that never comes back, instead of waiting forever', async () => {
    // A request the phone suspended when the app went into the background never
    // settles on its own, and the screen would wait for it until the app closed.
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    await expect(
      requestExtraction('label', 'AAAA', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...online,
        deadlineMs: 10,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('still fails cleanly when the error body is unreadable', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }) as unknown as Response,
    );
    await expect(
      requestExtraction('label', 'AAAA', { fetchImpl: fetchImpl as unknown as typeof fetch, ...online }),
    ).rejects.toMatchObject({ code: 'unknown' });
  });
});

describe('visionErrorMessage', () => {
  it('distinguishes situations a user would act on differently', () => {
    expect(visionErrorMessage('quota_exceeded')).not.toBe(visionErrorMessage('timeout'));
    expect(visionErrorMessage('unconfigured')).not.toBe(visionErrorMessage('provider_error'));
    expect(visionErrorMessage('offline')).toMatch(/offline/i);
  });

  it('never leaves a code without words', () => {
    expect(visionErrorMessage('unknown')).toBeTruthy();
  });
});
