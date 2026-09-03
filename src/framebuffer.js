/**
 * The in-memory framebuffer, shaped like the part of noVNC's `Display` that its
 * rectangle decoders draw into.
 *
 * noVNC's decoders paint through exactly five methods — `blitImage`,
 * `fillRect`, `copyImage`, `imageRect` and `videoFrame` — and never touch the
 * canvas themselves. That is what makes them usable here: this class offers the
 * same five methods over a plain RGBA buffer instead of a 2D canvas context.
 *
 * Pixels are R, G, B, A in memory, which is also the wire order we ask the
 * server for, so `blitImage` is a memcpy.
 */

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export class Framebuffer {
  constructor() {
    this.width = 0;
    this.height = 0;
    /** RGBA, `width * height * 4` bytes. @type {Buffer} */
    this.data = Buffer.alloc(0);
    /** How many JPEG/PNG rectangles have been decoded: whether lossy mode is in use. */
    this.imageRects = 0;
  }

  /** Change size, keeping whatever content still fits. */
  resize(width, height) {
    if (width === this.width && height === this.height) return;
    const next = Buffer.alloc(width * height * 4);
    const rows = Math.min(height, this.height);
    const rowBytes = Math.min(width, this.width) * 4;
    for (let row = 0; row < rows; row++) {
      this.data.copy(next, row * width * 4, row * this.width * 4, row * this.width * 4 + rowBytes);
    }
    this.width = width;
    this.height = height;
    this.data = next;
  }

  /**
   * Copy a block of RGBA pixels in. `arr` is any typed array; the block starts
   * `offset` bytes into it — the same contract as noVNC's Display.
   */
  blitImage(x, y, width, height, arr, offset = 0) {
    const src = Buffer.from(arr.buffer, arr.byteOffset + offset, width * height * 4);
    const clip = this._clip(x, y, width, height);
    if (!clip) return;
    for (let row = 0; row < clip.height; row++) {
      const from = ((clip.y - y + row) * width + (clip.x - x)) * 4;
      src.copy(this.data, this._offset(clip.x, clip.y + row), from, from + clip.width * 4);
    }
  }

  /** Fill a rectangle with one colour; `color` is indexable as [r, g, b]. */
  fillRect(x, y, width, height, color) {
    const clip = this._clip(x, y, width, height);
    if (!clip) return;
    const rowBytes = clip.width * 4;
    const row = Buffer.allocUnsafe(rowBytes);
    for (let i = 0; i < rowBytes; i += 4) {
      row[i] = color[0];
      row[i + 1] = color[1];
      row[i + 2] = color[2];
      row[i + 3] = 255;
    }
    for (let r = 0; r < clip.height; r++) {
      row.copy(this.data, this._offset(clip.x, clip.y + r));
    }
  }

  /** Move a rectangle within the framebuffer (CopyRect). Overlap-safe. */
  copyImage(oldX, oldY, newX, newY, width, height) {
    const src = this._clip(oldX, oldY, width, height);
    const dst = this._clip(newX, newY, width, height);
    if (!src || !dst) return;
    // Only the part that is in bounds at both ends can move.
    const w = Math.min(src.width, dst.width);
    const h = Math.min(src.height, dst.height);
    const rows = [...Array(h).keys()];
    if (oldY < newY) rows.reverse(); // walk away from the overlap
    for (const row of rows) {
      const from = this._offset(src.x, src.y + row);
      this.data.copy(this.data, this._offset(dst.x, dst.y + row), from, from + w * 4);
    }
  }

  /**
   * Draw an encoded image (Tight's JPEG sub-encoding, TightPNG, JPEG). noVNC
   * hands this to the browser's image decoder; we use pure-JS ones.
   */
  imageRect(x, y, width, height, mime, arr) {
    const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    let image;
    if (mime === 'image/jpeg') {
      image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    } else if (mime === 'image/png') {
      image = PNG.sync.read(bytes);
    } else {
      throw new Error(`the server sent an image rectangle of type ${mime}, which this client cannot decode`);
    }
    if (image.width !== width || image.height !== height) {
      throw new Error(`image rectangle is ${image.width}x${image.height}, expected ${width}x${height}`);
    }
    this.imageRects += 1;
    this.blitImage(x, y, width, height, image.data, 0);
  }

  videoFrame() {
    throw new Error('H.264 rectangles are not supported (and were not requested)');
  }

  /** A copy of the pixels, with alpha forced opaque. */
  snapshot() {
    const copy = Buffer.from(this.data);
    for (let i = 3; i < copy.length; i += 4) copy[i] = 255;
    return copy;
  }

  _offset(x, y) {
    return (y * this.width + x) * 4;
  }

  /** Intersect a rectangle with the framebuffer; null if nothing is left. */
  _clip(x, y, width, height) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + width);
    const y1 = Math.min(this.height, y + height);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
}
