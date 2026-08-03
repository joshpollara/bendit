import { describe, expect, it } from 'vitest';
import { canonicalize } from './barcodeScan';

// What the decoder hands over, and what it should turn into before anything is
// looked up. The camera part isn't tested here — this is the decision layer.

describe('canonicalize', () => {
  it('passes a clean EAN-13 through', () => {
    expect(canonicalize('8712345678906', 'ean_13')).toBe('8712345678906');
  });

  it('expands a UPC-E, because no database stores the short form', () => {
    expect(canonicalize('04963406', 'upc_e')).toBe('049000006346');
  });

  it('leaves an eight-digit EAN-8 alone', () => {
    // Same length as a UPC-E and a completely different number — the format the
    // scanner reported is what tells them apart.
    expect(canonicalize('96385074', 'ean_8')).toBe('96385074');
  });

  it('refuses a misread rather than looking up a number that cannot exist', () => {
    expect(canonicalize('8712345678905', 'ean_13')).toBeNull();
    expect(canonicalize('871234567', 'code_128')).toBeNull();
    expect(canonicalize('', 'ean_13')).toBeNull();
  });

  it('handles a code with no format reported', () => {
    expect(canonicalize('8712345678906')).toBe('8712345678906');
  });
});
