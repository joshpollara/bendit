import { describe, expect, it } from 'vitest';
import { unavailableOf } from './picnicUnavailable';

const REPLACEMENT = { type: 'REPLACEMENT', id: 's2', name: 'Picnic halfvolle melk', unit_quantity: '1 liter', display_price: 99, image_id: 'img', max_count: 50, price: 99 };

describe('sold-out items', () => {
  it("reads Picnic's reason, explanation and replacements", () => {
    const article = {
      decorators: [
        { type: 'QUANTITY', quantity: 2 },
        { type: 'UNAVAILABLE', reason: 'OUT_OF_ASSORTMENT', explanation: { short_explanation: 'Uitverkocht', long_explanation: '…' }, replacements: [REPLACEMENT], deeplink: '' },
      ],
    };
    expect(unavailableOf(article)).toEqual({ reason: 'OUT_OF_ASSORTMENT', explanation: 'Uitverkocht', replacements: [REPLACEMENT] });
  });

  it('finds it on the line when the article has none, and is null otherwise', () => {
    const line = { decorators: [{ type: 'UNAVAILABLE', reason: 'SOLD_OUT', deeplink: '' }] };
    expect(unavailableOf({ decorators: [] }, line)).toEqual({ reason: 'SOLD_OUT', explanation: null, replacements: [] });
    expect(unavailableOf({ decorators: [{ type: 'QUANTITY', quantity: 1 }] }, { decorators: [] })).toBeNull();
  });
});
