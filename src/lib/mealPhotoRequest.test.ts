import { beforeEach, describe, expect, it, vi } from 'vitest';

const vision = vi.hoisted(() => ({
  resizeForModel: vi.fn(),
  postToModel: vi.fn(),
}));

vi.mock('./vision', () => vision);

import { estimateMealFromPhoto, type MealPhotoStage } from './mealPhoto';

const response = {
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

describe('estimateMealFromPhoto progress', () => {
  it('reports the real client-side milestones in order', async () => {
    const stages: MealPhotoStage[] = [];
    const result = await estimateMealFromPhoto(new Blob(['photo']), {
      onStage: (stage) => stages.push(stage),
    });

    expect(stages).toEqual(['preparing', 'analyzing']);
    expect(vision.resizeForModel).toHaveBeenCalledOnce();
    expect(vision.postToModel).toHaveBeenCalledWith('/api/meals/estimate', {
      image: 'encoded-photo',
      mimeType: 'image/jpeg',
    });
    expect(result.items[0].seenAs).toBe('white rice');
  });

  it('does not claim analysis when image preparation fails', async () => {
    vision.resizeForModel.mockRejectedValueOnce(new Error('image preparation failed'));
    const stages: MealPhotoStage[] = [];

    await expect(
      estimateMealFromPhoto(new Blob(['photo']), {
        onStage: (stage) => stages.push(stage),
      }),
    ).rejects.toThrow('image preparation failed');
    expect(stages).toEqual(['preparing']);
    expect(vision.postToModel).not.toHaveBeenCalled();
  });
});
