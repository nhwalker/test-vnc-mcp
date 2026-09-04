/**
 * Unit tests for surface detection: flat-colour regions found from pixels.
 *
 * The first half draws small synthetic screens so each rule (size, fill,
 * tolerance, nesting) is checked on its own. The second half runs the real
 * thing over test/fixtures/desktop.png, a rendered 1024x768 desktop, and
 * expects the regions a person would name.
 *
 * Run with: node --test test/regions.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { findSurfaces, contains } from '../src/regions.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'desktop.png');

/** A canvas filled with one colour, plus a `rect` helper to paint on it. */
function screen(width, height, color) {
  const rgba = Buffer.alloc(width * height * 4);
  const canvas = {
    width,
    height,
    rgba,
    rect(x, y, w, h, [r, g, b]) {
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) rgba.set([r, g, b, 255], (yy * width + xx) * 4);
      }
      return canvas;
    },
    find(options) {
      return findSurfaces(rgba, width, height, options);
    },
  };
  return canvas.rect(0, 0, width, height, color);
}

const box = ({ x, y, width, height }) => ({ x, y, width, height });

test('a plain screen is one surface covering everything', () => {
  const found = screen(100, 60, [40, 40, 40]).find();
  assert.equal(found.length, 1);
  assert.deepEqual(box(found[0]), { x: 0, y: 0, width: 100, height: 60 });
  assert.equal(found[0].color, '#282828');
  assert.equal(found[0].fill, 1);
  assert.equal(found[0].parent, null);
});

test('a panel with a button inside nests, in reading order', () => {
  const found = screen(200, 120, [30, 30, 30])
    .rect(20, 20, 120, 80, [230, 230, 230]) // panel
    .rect(30, 70, 50, 20, [200, 200, 200]) // button inside the panel
    .find();
  assert.deepEqual(
    found.map((s) => [s.id, box(s), s.parent, s.depth]),
    [
      [1, { x: 0, y: 0, width: 200, height: 120 }, null, 0],
      [2, { x: 20, y: 20, width: 120, height: 80 }, 1, 1],
      [3, { x: 30, y: 70, width: 50, height: 20 }, 2, 2],
    ],
  );
  assert.equal(found[1].fill, 0.9, 'the button is a hole in the panel: (120*80 - 50*20) / (120*80), to two places');
});

test('thin strokes, small blobs and half-empty boxes are not surfaces', () => {
  const found = screen(200, 100, [0, 0, 0])
    .rect(10, 10, 100, 2, [255, 255, 255]) // a rule: too thin
    .rect(10, 20, 10, 10, [255, 255, 255]) // an icon-sized blob: too small
    .rect(50, 30, 60, 3, [255, 0, 0]) // an L-shape: big bounding box, low fill
    .rect(50, 30, 3, 40, [255, 0, 0])
    .find();
  assert.equal(found.length, 1, `only the background should remain, got ${JSON.stringify(found)}`);
  assert.equal(found[0].color, '#000000');
});

test('tolerance decides whether two close colours are one surface', () => {
  const draw = () => screen(100, 100, [100, 100, 100]).rect(0, 50, 100, 50, [104, 104, 104]);
  assert.equal(draw().find({ tolerance: 12 }).length, 1, '12 apart in total: one surface');
  assert.equal(draw().find({ tolerance: 11 }).length, 2, 'just over the tolerance: two');
});

test('a gradient is not walked across one step at a time', () => {
  // Each column is one unit brighter than the last, so neighbours are always
  // "close" but the ends are 99 apart. Compared with the seed, that is many
  // narrow strips, none wide enough to be a surface.
  const canvas = screen(100, 40, [0, 0, 0]);
  for (let x = 0; x < 100; x++) canvas.rect(x, 0, 1, 40, [x, x, x]);
  assert.equal(canvas.find().length, 0);
});

test('random noise produces no surface', () => {
  const canvas = screen(64, 64, [0, 0, 0]);
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256;
  for (let i = 0; i < 64 * 64; i++) canvas.rgba.set([next(), next(), next(), 255], i * 4);
  assert.equal(canvas.find().length, 0);
});

test('a bar across the screen is hinted as one; a window is not', () => {
  const found = screen(400, 300, [50, 50, 50])
    .rect(0, 0, 400, 24, [80, 80, 80]) // menu bar
    .rect(50, 60, 300, 200, [255, 255, 255]) // window
    .find();
  const bar = found.find((s) => s.y === 0 && s.height === 24);
  const win = found.find((s) => s.width === 300);
  assert.equal(bar.hint, 'bar');
  assert.equal(win.hint, undefined);
});

test('contains() is inclusive of shared edges', () => {
  const outer = { x: 10, y: 10, width: 20, height: 20 };
  assert.equal(contains(outer, { x: 10, y: 10, width: 20, height: 20 }), true, 'identical');
  assert.equal(contains(outer, { x: 15, y: 15, width: 15, height: 15 }), true, 'flush with the far edge');
  assert.equal(contains(outer, { x: 15, y: 15, width: 16, height: 15 }), false, 'one pixel over');
});

test('the rendered desktop fixture yields the regions a person would name', () => {
  const png = PNG.sync.read(fs.readFileSync(FIXTURE));
  const found = findSurfaces(png.data, png.width, png.height);

  // Fonts may shift text by a pixel or two between renders, but these boxes are
  // CSS geometry, so they are exact.
  const expect = (color, x, y, width, height, what) => {
    const hit = found.find((s) => s.color === color && Math.abs(s.x - x) <= 1 && Math.abs(s.y - y) <= 1);
    assert.ok(hit, `${what} (${color} at ${x},${y}) not found in ${JSON.stringify(found.map(box))}`);
    assert.ok(Math.abs(hit.width - width) <= 2 && Math.abs(hit.height - height) <= 2, `${what} is ${hit.width}x${hit.height}, expected ${width}x${height}`);
    return hit;
  };

  const desktop = expect('#2e3440', 0, 28, 1024, 704, 'desktop background');
  const menuBar = expect('#3b4252', 0, 0, 1024, 28, 'menu bar');
  const taskbar = expect('#3b4252', 0, 732, 1024, 36, 'taskbar');
  const terminal = expect('#000000', 41, 61, 612, 432, 'terminal body');
  const dialogTitle = expect('#d8dee9', 681, 121, 300, 28, 'dialog title bar');
  const dialogBody = expect('#eceff4', 681, 149, 300, 192, 'dialog body');
  const cancel = expect('#efefef', 714, 298, 74, 30, 'Cancel button');
  const dontSave = expect('#efefef', 798, 298, 98, 30, "Don't Save button");
  const save = expect('#efefef', 906, 298, 62, 30, 'Save button');
  assert.equal(found.length, 9, `expected exactly these nine, got ${found.length}`);

  assert.equal(menuBar.hint, 'bar');
  assert.equal(taskbar.hint, 'bar');
  assert.equal(terminal.parent, desktop.id, 'the terminal sits on the desktop');
  assert.equal(dialogBody.parent, desktop.id);
  assert.equal(dialogTitle.parent, desktop.id, 'the title bar is beside the body, not inside it');
  for (const button of [cancel, dontSave, save]) assert.equal(button.parent, dialogBody.id, 'buttons are in the dialog');
  assert.equal(save.depth, 2);
  assert.ok(desktop.fill > 0.5 && desktop.fill < 0.6, `windows cover about half the desktop, fill=${desktop.fill}`);
  assert.ok(terminal.fill > 0.95, `green text covers little of the terminal, fill=${terminal.fill}`);
});
