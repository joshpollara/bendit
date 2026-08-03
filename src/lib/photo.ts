// Downscales a camera photo to an upload-friendly JPEG. Progress photos are
// for eyeballing change over months, not pixel-peeping — 1280px is plenty and
// keeps years of photos comfortably inside the server's 1GB volume.

const MAX_EDGE = 1280;
const QUALITY = 0.82;

export function compressPhoto(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Could not process the photo.'));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not process the photo.'))),
        'image/jpeg',
        QUALITY,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file doesn't look like a photo."));
    };
    img.src = url;
  });
}
