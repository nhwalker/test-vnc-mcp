/**
 * Framebuffer (RGBA) -> PNG, with optional downscaling.
 *
 * PNG rather than JPEG because it is lossless, and screenshots are mostly read
 * for their text. `pngjs` rather than `sharp` because it is pure JavaScript, so
 * installing this server never needs a native toolchain (DECISIONS.md #5).
 */

import { PNG } from 'pngjs';

/**
 * Box-filter an RGBA image down to `width` x `height`.
 *
 * Averaging rather than nearest-neighbour: nearest-neighbour drops whole rows
 * of pixels, which is what turns small text into noise.
 */
function downscale(rgba, srcWidth, srcHeight, width, height) {
  const out = Buffer.alloc(width * height * 4);
  const xRatio = srcWidth / width;
  const yRatio = srcHeight / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(srcHeight, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(srcWidth, Math.ceil((x + 1) * xRatio)));

      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let src = (sy * srcWidth + x0) * 4;
        for (let sx = x0; sx < x1; sx++, src += 4) {
          r += rgba[src];
          g += rgba[src + 1];
          b += rgba[src + 2];
          n++;
        }
      }

      const dst = (y * width + x) * 4;
      out[dst] = Math.round(r / n);
      out[dst + 1] = Math.round(g / n);
      out[dst + 2] = Math.round(b / n);
      out[dst + 3] = 255;
    }
  }
  return out;
}

/**
 * Encode an RGBA framebuffer as a PNG.
 *
 * @param {Buffer} rgba caller-owned copy with opaque alpha (see Framebuffer.snapshot)
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {object} [options]
 * @param {number} [options.scale] 0 < scale <= 1
 * @param {number} [options.maxWidth] shrink further so the result is no wider than this
 * @returns {{ png: Buffer, width: number, height: number }}
 */
export function encodePng(rgba, srcWidth, srcHeight, { scale = 1, maxWidth } = {}) {
  if (srcWidth === 0 || srcHeight === 0) {
    throw new Error('the desktop has no size yet; nothing to capture');
  }

  let factor = Math.min(1, Math.max(0.01, scale));
  if (maxWidth && srcWidth * factor > maxWidth) factor = maxWidth / srcWidth;

  const width = Math.max(1, Math.round(srcWidth * factor));
  const height = Math.max(1, Math.round(srcHeight * factor));

  const png = new PNG({ width, height });
  png.data =
    width === srcWidth && height === srcHeight ? rgba : downscale(rgba, srcWidth, srcHeight, width, height);

  return { png: PNG.sync.write(png), width, height };
}
