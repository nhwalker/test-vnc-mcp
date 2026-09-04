/**
 * Unit tests for analysing a supplied image: decoding, the optional bounding
 * box, the coordinate scale, and that the result matches what describe()
 * would say about the same pixels.
 *
 * Run with: node --test test/analyze.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

import { analyzeImage, decodeImage } from '../src/analyze.js';
import { Ocr } from '../src/ocr.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'desktop.png');
const pngBytes = fs.readFileSync(FIXTURE);
const png = PNG.sync.read(pngBytes);
const ocr = new Ocr();
after(() => ocr.terminate());

test('decodes PNG and JPEG, sniffing the type from the bytes', () => {
  const fromPng = decodeImage(pngBytes);
  assert.equal(fromPng.mimeType, 'image/png');
  assert.equal(fromPng.width, 1024);
  assert.equal(fromPng.rgba.length, 1024 * 768 * 4);

  const jpgBytes = jpeg.encode({ data: png.data, width: png.width, height: png.height }, 90).data;
  const fromJpg = decodeImage(jpgBytes);
  assert.equal(fromJpg.mimeType, 'image/jpeg');
  assert.equal(fromJpg.height, 768);

  assert.throws(() => decodeImage(Buffer.from('not an image at all')), /neither PNG nor JPEG/);
  assert.throws(() => decodeImage(pngBytes, 'image/jpeg'), /declared image\/jpeg but its bytes are image\/png/);
});

test('a whole image analyses exactly as the live desktop would', async () => {
  const result = await analyzeImage(ocr, { image: pngBytes.toString('base64') });
  assert.deepEqual(result.image, { width: 1024, height: 768, mimeType: 'image/png' });
  assert.deepEqual(Object.keys(result).sort(), ['elapsedMs', 'image', 'regions', 'text']);
  assert.equal(result.regions.length, 9);
  const save = result.regions.find((r) => r.text === 'Save');
  assert.deepEqual(save.bbox, [906, 298, 62, 30]);
  assert.equal(save.hint, 'button-like');
  assert.ok(result.text.some((l) => l.text === 'Save changes?'));
});

test('a data: URL prefix is accepted', async () => {
  const result = await analyzeImage(ocr, { image: `data:image/png;base64,${pngBytes.toString('base64')}`, text: false });
  assert.equal(result.regions.length, 9);
});

test('bbox restricts the analysis but leaves coordinates in whole-image space', async () => {
  // The dialog, with a little margin.
  const result = await analyzeImage(ocr, { image: pngBytes.toString('base64'), bbox: { x: 670, y: 110, width: 320, height: 240 } });
  assert.deepEqual(result.image.bbox, { x: 670, y: 110, width: 320, height: 240 });

  const colors = result.regions.map((r) => r.color).sort();
  assert.ok(!colors.includes('#000000'), 'the terminal is outside the box and must not appear');
  const title = result.regions.find((r) => r.color === '#d8dee9');
  assert.deepEqual(title.bbox, [681, 121, 300, 28], 'same place as in the whole image');
  const cancel = result.regions.find((r) => r.text === 'Cancel');
  assert.deepEqual(cancel.bbox, [714, 298, 74, 30]);

  const texts = result.text.map((l) => l.text);
  assert.ok(texts.includes('Save changes?'), texts);
  assert.ok(!texts.some((t) => t.includes('type here')), 'the terminal text is outside the box');
  const line = result.text.find((l) => l.text === 'Save changes?');
  assert.ok(line.bbox.x > 681 && line.bbox.x < 720, `title text starts inside the title bar, got x=${line.bbox.x}`);

  // The sliver of desktop around the dialog is a thin frame: a large bounding
  // box it barely fills, so it is correctly not a region.
  assert.ok(!result.regions.some((r) => r.color === '#2e3440'), 'a thin frame of desktop is not a region');
  assert.equal(result.regions.length, 5, 'title bar, body, three buttons');
});

test('a bbox partly outside the image is clipped; one wholly outside is an error', async () => {
  const result = await analyzeImage(ocr, { image: pngBytes.toString('base64'), bbox: { x: 900, y: 700, width: 500, height: 500 }, text: false });
  assert.deepEqual(result.image.bbox, { x: 900, y: 700, width: 124, height: 68 });
  await assert.rejects(
    analyzeImage(ocr, { image: pngBytes.toString('base64'), bbox: { x: 2000, y: 0, width: 10, height: 10 } }),
    /outside the 1024x768 image/,
  );
});

test('scale multiplies every coordinate, for screenshots that were shrunk', async () => {
  const result = await analyzeImage(ocr, { image: pngBytes.toString('base64'), scale: 1.5, words: true });
  assert.equal(result.image.scale, 1.5);
  const save = result.regions.find((r) => r.text === 'Save');
  assert.deepEqual(save.bbox, [1359, 447, 93, 45]);
  const line = result.text.find((l) => l.text === 'Save changes?');
  assert.ok(line.bbox.x >= 1030 && line.bbox.x <= 1060, `scaled x, got ${line.bbox.x}`);
  assert.ok(line.words[0].bbox.x >= line.bbox.x, 'word boxes are scaled too');
});

test('bbox and scale compose: the offset is applied before the scale', async () => {
  const result = await analyzeImage(ocr, {
    image: pngBytes.toString('base64'),
    bbox: { x: 700, y: 290, width: 280, height: 45 },
    scale: 2,
    text: false,
  });
  const cancel = result.regions.find((r) => r.color === '#efefef' && r.bbox[0] === 1428);
  assert.ok(cancel, `Cancel at (714*2, 298*2) expected in ${JSON.stringify(result.regions.map((r) => r.bbox))}`);
  assert.deepEqual(cancel.bbox, [1428, 596, 148, 60]);
});

test('a JPEG screenshot still reads', async () => {
  const jpgBytes = jpeg.encode({ data: png.data, width: png.width, height: png.height }, 85).data;
  const result = await analyzeImage(ocr, { image: jpgBytes.toString('base64'), mimeType: 'image/jpeg' });
  assert.equal(result.image.mimeType, 'image/jpeg');
  // JPEG ringing breaks flat colour into many components, so exact region
  // counts are not promised. Dark text on light backgrounds still reads; the
  // terminal's thin green-on-black text does not survive JPEG's colour
  // compression, and that is documented rather than promised.
  const texts = result.text.map((l) => l.text);
  assert.ok(texts.includes('Save changes?'), texts);
  assert.ok(texts.includes('Cancel'), texts);
  assert.ok(texts.some((t) => t.includes('Applications')), texts);
});

test('bad input is refused clearly', async () => {
  await assert.rejects(analyzeImage(ocr, { image: '' }), /base64 string/);
  await assert.rejects(analyzeImage(ocr, { image: '%%%%' }), /not valid base64|neither PNG nor JPEG/);
  await assert.rejects(analyzeImage(ocr, { image: Buffer.from('hello').toString('base64') }), /neither PNG nor JPEG/);
});
