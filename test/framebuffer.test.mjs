/**
 * Unit tests for the Framebuffer: the one piece of pixel code we own.
 *
 * The end-to-end test compares whole screens against the server, which is the
 * real check. These pin down the edge cases that a well-behaved server rarely
 * produces — overlapping copies in every direction, rectangles that hang off
 * the edge — so a wrong-way loop does not wait for a hostile server to show up.
 *
 * Run with: node --test test/framebuffer.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';

import { Framebuffer } from '../src/framebuffer.js';

/** A framebuffer whose pixel (x, y) is r=x, g=y, b=99, so positions are readable. */
function gradient(width, height) {
  const fb = new Framebuffer();
  fb.resize(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      fb.data.set([x, y, 99, 255], (y * width + x) * 4);
    }
  }
  return fb;
}

function pixel(fb, x, y) {
  const i = (y * fb.width + x) * 4;
  return [...fb.data.subarray(i, i + 3)];
}

/** RGBA block of `w` x `h` pixels all set to `color`. */
function block(w, h, color) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set([...color, 255], i * 4);
  return out;
}

test('resize keeps the overlapping content and zero-fills the rest', () => {
  const fb = gradient(4, 3);
  fb.resize(6, 2);
  assert.equal(fb.data.length, 6 * 2 * 4);
  assert.deepEqual(pixel(fb, 3, 1), [3, 1, 99], 'content inside both sizes survives');
  assert.deepEqual(pixel(fb, 5, 1), [0, 0, 0], 'new columns are black');
  fb.resize(2, 2);
  assert.deepEqual(pixel(fb, 1, 1), [1, 1, 99], 'shrinking keeps the top-left');
});

test('blitImage copies a block, honouring the byte offset', () => {
  const fb = gradient(5, 5);
  const bytes = new Uint8Array([9, 9, 9, 9, ...block(2, 2, [1, 2, 3])]); // 4 junk bytes first
  fb.blitImage(1, 2, 2, 2, bytes, 4);
  assert.deepEqual(pixel(fb, 1, 2), [1, 2, 3]);
  assert.deepEqual(pixel(fb, 2, 3), [1, 2, 3]);
  assert.deepEqual(pixel(fb, 0, 2), [0, 2, 99], 'left neighbour untouched');
  assert.deepEqual(pixel(fb, 3, 2), [3, 2, 99], 'right neighbour untouched');
  assert.deepEqual(pixel(fb, 1, 4), [1, 4, 99], 'row below untouched');
});

test('blitImage clips a block that hangs off every edge', () => {
  const fb = gradient(4, 4);
  // A 4x4 block placed at (-2, -2) only lands in the top-left 2x2, and the
  // pixels that land must be the block's bottom-right quarter.
  const src = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) src.set([10 + x, 10 + y, 0, 255], (y * 4 + x) * 4);
  fb.blitImage(-2, -2, 4, 4, src, 0);
  assert.deepEqual(pixel(fb, 0, 0), [12, 12, 0], 'block pixel (2,2) lands at (0,0)');
  assert.deepEqual(pixel(fb, 1, 1), [13, 13, 0]);
  assert.deepEqual(pixel(fb, 2, 2), [2, 2, 99], 'outside the block is untouched');

  // Off the bottom-right: the block's top-left quarter lands.
  fb.blitImage(3, 3, 4, 4, src, 0);
  assert.deepEqual(pixel(fb, 3, 3), [10, 10, 0]);
  assert.equal(fb.data.length, 4 * 4 * 4, 'the buffer did not grow');

  // Entirely outside: no effect, no throw.
  fb.blitImage(10, 10, 4, 4, src, 0);
  fb.blitImage(-10, 0, 4, 4, src, 0);
});

test('fillRect paints one colour and clips', () => {
  const fb = gradient(4, 4);
  fb.fillRect(2, 2, 10, 10, [7, 8, 9]);
  assert.deepEqual(pixel(fb, 2, 2), [7, 8, 9]);
  assert.deepEqual(pixel(fb, 3, 3), [7, 8, 9]);
  assert.deepEqual(pixel(fb, 1, 1), [1, 1, 99]);
  fb.fillRect(-1, -1, 2, 2, new Uint8Array([5, 5, 5])); // Tight passes a typed array
  assert.deepEqual(pixel(fb, 0, 0), [5, 5, 5]);
  assert.deepEqual(pixel(fb, 1, 1), [1, 1, 99]);
});

test('copyImage moves a region downwards without smearing (overlap, oldY < newY)', () => {
  const fb = gradient(3, 6);
  // Move rows 0-3 down by one to rows 1-4.
  fb.copyImage(0, 0, 0, 1, 3, 4);
  for (let y = 1; y <= 4; y++) {
    assert.deepEqual(pixel(fb, 1, y), [1, y - 1, 99], `row ${y} should hold old row ${y - 1}`);
  }
  assert.deepEqual(pixel(fb, 1, 0), [1, 0, 99], 'source row 0 is left as it was');
  assert.deepEqual(pixel(fb, 1, 5), [1, 5, 99], 'row 5 untouched');
});

test('copyImage moves a region upwards without smearing (overlap, oldY > newY)', () => {
  const fb = gradient(3, 6);
  // Move rows 2-5 up by one to rows 1-4: this is what a terminal scroll does.
  fb.copyImage(0, 2, 0, 1, 3, 4);
  for (let y = 1; y <= 4; y++) {
    assert.deepEqual(pixel(fb, 1, y), [1, y + 1, 99], `row ${y} should hold old row ${y + 1}`);
  }
  assert.deepEqual(pixel(fb, 1, 5), [1, 5, 99], 'last source row is left as it was');
});

test('copyImage handles horizontal overlap both ways', () => {
  let fb = gradient(6, 2);
  fb.copyImage(0, 0, 1, 0, 4, 2); // right by one
  for (let x = 1; x <= 4; x++) assert.deepEqual(pixel(fb, x, 1), [x - 1, 1, 99]);

  fb = gradient(6, 2);
  fb.copyImage(2, 0, 1, 0, 4, 2); // left by one
  for (let x = 1; x <= 4; x++) assert.deepEqual(pixel(fb, x, 1), [x + 1, 1, 99]);
});

test('copyImage clips when source or destination hangs off the edge', () => {
  const fb = gradient(4, 4);
  fb.copyImage(2, 2, 0, 0, 4, 4); // source is only 2x2 in bounds
  assert.deepEqual(pixel(fb, 0, 0), [2, 2, 99]);
  assert.deepEqual(pixel(fb, 1, 1), [3, 3, 99]);
  assert.deepEqual(pixel(fb, 2, 0), [2, 0, 99], 'beyond the in-bounds source, nothing moved');

  const fb2 = gradient(4, 4);
  fb2.copyImage(0, 0, 3, 3, 3, 3); // destination is only 1x1 in bounds
  assert.deepEqual(pixel(fb2, 3, 3), [0, 0, 99]);
  assert.deepEqual(pixel(fb2, 2, 2), [2, 2, 99]);

  fb2.copyImage(-5, -5, 10, 10, 2, 2); // nothing in bounds at all: no throw
});

test('imageRect decodes a JPEG into place and rejects a size mismatch', () => {
  const fb = gradient(8, 8);
  const encoded = jpeg.encode({ width: 4, height: 4, data: Buffer.from(block(4, 4, [200, 30, 30])) }, 100).data;
  fb.imageRect(2, 2, 4, 4, 'image/jpeg', encoded);
  const [r, g, b] = pixel(fb, 3, 3);
  assert.ok(r > 180 && g < 60 && b < 60, `expected a red pixel, got ${[r, g, b]}`);
  assert.deepEqual(pixel(fb, 1, 1), [1, 1, 99], 'outside the rect untouched');
  assert.equal(fb.imageRects, 1);

  assert.throws(() => fb.imageRect(0, 0, 2, 2, 'image/jpeg', encoded), /expected 2x2/);
  assert.throws(() => fb.imageRect(0, 0, 4, 4, 'image/webp', encoded), /cannot decode/);
});

test('snapshot is a copy with opaque alpha', () => {
  const fb = gradient(2, 2);
  fb.data[3] = 0; // a decoder that forgot alpha
  const copy = fb.snapshot();
  assert.equal(copy[3], 255);
  copy[0] = 42;
  assert.equal(fb.data[0], 0, 'mutating the snapshot leaves the framebuffer alone');
});
