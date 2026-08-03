// A JPEG's dimensions, read from its own header.
//
// Only needed to tell whether a photo is larger than the app would ever send,
// which is worth knowing when measuring what a scan costs. Reading four bytes
// out of a header the file already contains is a smaller thing than an image
// library, and this never decodes a pixel.

/** Frame-header markers. Not every 0xCn marker is one: C4, C8 and CC aren't. */
const isFrameHeader = (marker) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/**
 * `{ width, height }`, or null if the buffer isn't a JPEG or is truncated
 * before its frame header.
 */
export function jpegSize(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2; // past the start-of-image marker
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null; // not where a segment should start
    const marker = buffer[offset + 1];
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (isFrameHeader(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}
