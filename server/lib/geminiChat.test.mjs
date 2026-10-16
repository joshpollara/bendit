import { describe, expect, it } from 'vitest';
import { createChatModel } from './geminiChat.mjs';

const ok = (parts) => ({
  ok: true,
  json: async () => ({
    candidates: [{ content: { role: 'model', parts } }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 65 },
  }),
});

describe('the chat model', () => {
  it('sends the conversation, the tools and the thinking level, and returns the next turn', async () => {
    const requests = [];
    const model = createChatModel({
      apiKey: 'k',
      model: 'gemini-test',
      thinkingLevel: 'low',
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body), key: init.headers['x-goog-api-key'] });
        return ok([{ text: 'hi' }]);
      },
    });
    const result = await model.generate({
      system: 'be brief',
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      tools: [{ name: 'get_day', description: 'd', parameters: { type: 'object', properties: {} } }],
    });
    expect(requests[0].url).toMatch(/gemini-test:generateContent$/);
    expect(requests[0].key).toBe('k');
    expect(requests[0].body).toMatchObject({
      systemInstruction: { parts: [{ text: 'be brief' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      tools: [{ functionDeclarations: [{ name: 'get_day' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
    });
    expect(result.content.parts).toEqual([{ text: 'hi' }]);
    // Thinking is billed as output.
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 15, totalTokens: 65 });
  });

  it('retries once on a passing failure', async () => {
    let calls = 0;
    const model = createChatModel({
      apiKey: 'k',
      sleep: async () => {},
      fetchImpl: async () => (++calls === 1 ? { ok: false, status: 503, text: async () => 'busy' } : ok([{ text: 'ok' }])),
    });
    expect((await model.generate({ system: '', contents: [], tools: [] })).content.parts[0].text).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does not retry a request the provider refused', async () => {
    let calls = 0;
    const model = createChatModel({
      apiKey: 'k',
      fetchImpl: async () => (calls++, { ok: false, status: 400, text: async () => 'bad' }),
    });
    await expect(model.generate({ system: '', contents: [], tools: [] })).rejects.toMatchObject({ code: 'provider_error' });
    expect(calls).toBe(1);
  });

  it('refuses without a key', async () => {
    await expect(createChatModel({ apiKey: '' }).generate({ system: '', contents: [], tools: [] })).rejects.toMatchObject({
      code: 'unconfigured',
    });
  });
});
