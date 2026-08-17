import { beforeEach, describe, expect, it, vi } from 'vitest';

const vision = vi.hoisted(() => ({
  resizeForModel: vi.fn(),
  postToModel: vi.fn(),
}));

vi.mock('./vision', () => vision);

import { prepareMealPhoto, requestMealEstimate } from './mealPhoto';

const response = {
  estimateId: 'run-1',
  items: [
    {
      name: 'white rice',
      grams: 100,
      confidence: 'medium',
      food: null,
      nutrition: null,
      range: null,
      error: 0.25,
    },
  ],
  total: { calories: 0, protein: 0, carbs: 0, fat: 0, low: 0, high: 0 },
  unmatched: 1,
  meta: {
    model: 'test-model',
    promptVersion: 'test',
    latencyMs: 10,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    callsRemainingToday: 10,
  },
};

beforeEach(() => {
  vision.resizeForModel.mockReset().mockResolvedValue('encoded-photo');
  vision.postToModel.mockReset().mockResolvedValue(response);
});

describe('reading a meal photo', () => {
  it('prepares the photo once, for however many reads it takes', async () => {
    const image = await prepareMealPhoto(new Blob(['photo']));
    await requestMealEstimate(image);
    const result = await requestMealEstimate(image, { hint: 'witte rijst' });

    expect(vision.resizeForModel).toHaveBeenCalledOnce();
    expect(vision.postToModel).toHaveBeenNthCalledWith(1, '/api/meals/estimate', {
      image: 'encoded-photo',
      mimeType: 'image/jpeg',
    });
    expect(result.items[0].seenAs).toBe('white rice');
  });

  it('sends what the person said the meal was, flattened to one short line', async () => {
    await requestMealEstimate('encoded-photo', { hint: `  kip\n shoarma  ${'x'.repeat(200)}` });

    const { hint } = vision.postToModel.mock.calls[0][1];
    expect(hint.startsWith('kip shoarma x')).toBe(true);
    expect(hint).toHaveLength(120);
  });

  it('sends no description when the box was left empty', async () => {
    await requestMealEstimate('encoded-photo', { hint: '   ' });
    expect(vision.postToModel.mock.calls[0][1]).not.toHaveProperty('hint');
  });

  it('names the estimate a second reading replaces', async () => {
    await requestMealEstimate('encoded-photo', { hint: 'kalfsvlees', previousEstimateId: 'run-1' });
    expect(vision.postToModel.mock.calls[0][1]).toMatchObject({
      hint: 'kalfsvlees',
      previousEstimateId: 'run-1',
    });
  });
});
