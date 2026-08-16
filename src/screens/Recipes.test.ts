import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api';
import { canRetryRecipePhoto, recipePhotoErrorMessage } from './Recipes';

describe('recipe photo recovery', () => {
  it('offers another AI attempt after a transient failure', () => {
    const error = new ApiError('provider detail', { code: 'timeout', status: 504 });
    expect(canRetryRecipePhoto(error)).toBe(true);
    expect(recipePhotoErrorMessage(error)).toMatch(/AI took too long.*won.t need to retake/i);
  });

  it('asks for a new capture rather than retrying a photo with no readable recipe', () => {
    const error = new ApiError('No recipe was readable in that photo.', {
      code: 'no_recipe_found',
      status: 422,
    });
    expect(canRetryRecipePhoto(error)).toBe(false);
    expect(recipePhotoErrorMessage(error)).toMatch(/No recipe was readable/i);
  });

  it('does not encourage retries when AI photo reading is unavailable', () => {
    const error = new ApiError('not configured', { code: 'unconfigured', status: 503 });
    expect(canRetryRecipePhoto(error)).toBe(false);
    expect(recipePhotoErrorMessage(error)).toMatch(/not switched on/i);
  });
});
