import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jpegSize } from './jpeg.mjs';

// Real files, written by an encoder rather than hand-assembled: a header parser
// is only worth anything against bytes something else produced. Kept small and
// checked in, so this runs everywhere rather than only where photos happen to
// be lying around.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const read = (name) => fs.readFileSync(path.join(dir, name));

describe('jpegSize', () => {
  it('reads the dimensions of a baseline JPEG', () => {
    expect(jpegSize(read('baseline-64x48.jpg'))).toEqual({ width: 64, height: 48 });
  });

  it('reads a progressive one, whose frame header is a different marker', () => {
    // SOF2, not SOF0 — a parser that only looks for one of them silently
    // reports nothing for half the photos a phone produces.
    expect(jpegSize(read('progressive-200x150.jpg'))).toEqual({ width: 200, height: 150 });
  });
});

describe('jpegSize on things that are not JPEGs', () => {
  it('returns null rather than a number for a PNG', () => {
    expect(jpegSize(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))).toBeNull();
  });

  it('returns null for a truncated file', () => {
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('returns null for nothing at all', () => {
    expect(jpegSize(Buffer.alloc(0))).toBeNull();
    expect(jpegSize(null)).toBeNull();
  });
});
