/**
 * Unit tests for the OCR layer, over test/fixtures/desktop.png.
 *
 * These read real rendered text with the real engine, so they take a few
 * seconds and their assertions allow for OCR being OCR: a string must be
 * found, in the right region, with decent confidence — not every character
 * on the screen must be perfect.
 *
 * Run with: node --test test/ocr.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { findSurfaces, contains } from '../src/regions.js';
import { Ocr, readSurfaces, DEFAULT_LANG_PATH } from '../src/ocr.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'desktop.png');
const png = PNG.sync.read(fs.readFileSync(FIXTURE));
const surfaces = findSurfaces(png.data, png.width, png.height);
const ocr = new Ocr();

after(() => ocr.terminate());

const surfaceAt = (x, y) => surfaces.find((s) => Math.abs(s.x - x) <= 1 && Math.abs(s.y - y) <= 1);

test('the language data is bundled, not downloaded', () => {
  assert.ok(fs.existsSync(path.join(DEFAULT_LANG_PATH, 'eng.traineddata.gz')), DEFAULT_LANG_PATH);
  assert.ok(DEFAULT_LANG_PATH.includes(`${path.sep}node_modules${path.sep}`), 'it comes from a dependency');
});

test('reads the whole desktop, region by region', async () => {
  const lines = await readSurfaces(ocr, png.data, png.width, png.height, surfaces);
  const texts = lines.map((l) => l.text);

  /** A line containing `needle` must have been read from `surface`, lie inside it, and be confident. */
  function expectLine(needle, surface, what) {
    const candidates = lines.filter((l) => l.text.includes(needle));
    assert.ok(candidates.length > 0, `${what}: no line contains ${JSON.stringify(needle)} in ${JSON.stringify(texts)}`);
    const line = candidates.find((l) => l.region === surface.id);
    assert.ok(
      line,
      `${what}: ${JSON.stringify(needle)} was read from surface(s) ${candidates.map((l) => l.region)}, expected ${surface.id} (${surface.color} at ${surface.x},${surface.y})`,
    );
    assert.ok(contains(surface, line.bbox), `${what}: box ${JSON.stringify(line.bbox)} is outside its surface`);
    assert.ok(line.confidence >= 80, `${what}: confidence ${line.confidence}`);
    return line;
  }

  const menuBar = surfaceAt(0, 0);
  const terminal = surfaceAt(41, 61);
  const dialogTitle = surfaceAt(681, 121);
  const dialogBody = surfaceAt(681, 149);
  const taskbar = surfaceAt(0, 732);

  expectLine('Applications', menuBar, 'menu bar');
  expectLine('14:32', menuBar, 'clock');
  expectLine('type here: hello vnc', terminal, 'terminal prompt');
  expectLine('notes.txt', terminal, 'a directory listing line');
  expectLine('Save changes?', dialogTitle, 'dialog title');
  expectLine('unsaved changes', dialogBody, 'dialog message');
  expectLine('Terminal', taskbar, 'taskbar');

  // The three buttons are their own surfaces and read as exactly their labels.
  for (const [x, label] of [
    [714, 'Cancel'],
    [798, "Don't Save"],
    [906, 'Save'],
  ]) {
    const button = surfaceAt(x, 298);
    const line = expectLine(label, button, `${label} button`);
    assert.equal(line.text, label, 'the label alone, no border read as punctuation');
  }

  // The failure mode this design exists to prevent: text from two side-by-side
  // windows read as one line.
  for (const text of texts) {
    assert.ok(!(text.includes('notes.txt') && text.includes('Save')), `bled across windows: ${JSON.stringify(text)}`);
  }

  // Each surface's text is read once: masking children means no duplicates.
  const prompts = lines.filter((l) => l.text.includes('type here'));
  assert.equal(prompts.length, 1, `the prompt was read ${prompts.length} times`);

  // Boxes are in full-image pixels, and tight: a line is the height of its text.
  const prompt = prompts[0];
  assert.ok(prompt.bbox.x > 41 && prompt.bbox.x < 60, `prompt starts near the terminal's left edge, got x=${prompt.bbox.x}`);
  assert.ok(prompt.bbox.height >= 8 && prompt.bbox.height <= 20, `14px text should be about that tall, got ${prompt.bbox.height}`);
});

test('word boxes are optional and nest inside their line', async () => {
  const dialogTitle = surfaceAt(681, 121);
  const [line] = await ocr.recognize(png.data, png.width, png.height, dialogTitle, { words: true, singleLine: true, region: dialogTitle.id });
  assert.equal(line.text, 'Save changes?');
  assert.deepEqual(line.words.map((w) => w.text), ['Save', 'changes?']);
  for (const word of line.words) assert.ok(contains(line.bbox, word.bbox), `word ${JSON.stringify(word)} outside line ${JSON.stringify(line.bbox)}`);
  assert.ok(line.words[0].bbox.x < line.words[1].bbox.x, 'words are in reading order');
});

test('a blank region has no text', async () => {
  const lines = await ocr.recognize(png.data, png.width, png.height, { x: 300, y: 550, width: 200, height: 100 });
  assert.deepEqual(lines, []);
});

test('a region too small to hold text is skipped without asking Tesseract', async () => {
  assert.deepEqual(await ocr.recognize(png.data, png.width, png.height, { x: 0, y: 0, width: 3, height: 3 }), []);
});

test('a missing language fails with a message that says what to install', async () => {
  const broken = new Ocr({ langs: 'xyz' });
  await assert.rejects(
    broken.recognize(png.data, png.width, png.height, { x: 0, y: 0, width: 50, height: 20 }),
    /"xyz".*xyz\.traineddata\.gz.*@tesseract\.js-data\/<lang>.*VNC_OCR_LANG_PATH/s,
  );
  await broken.terminate();
});
