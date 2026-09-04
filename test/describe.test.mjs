/**
 * Unit tests for VncSession.describe(): how regions, text and the change
 * report are put together. The VNC client is a stand-in whose framebuffer is
 * test/fixtures/desktop.png, so this runs without a server; the end-to-end
 * test covers the real connection.
 *
 * Run with: node --test test/describe.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { VncSession } from '../src/session.js';
import { DamageLog } from '../src/damage.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'desktop.png');
const png = PNG.sync.read(fs.readFileSync(FIXTURE));

/** Enough of RfbClient for describe(): a framebuffer, an update counter, a damage log. */
function fakeClient() {
  const damage = new DamageLog();
  return {
    closed: false,
    width: png.width,
    height: png.height,
    updateCount: 1,
    fb: { snapshot: () => Buffer.from(png.data) },
    waitForQuiet: async () => true,
    damageSince: (since) => damage.since(since),
    close() {
      this.closed = true;
    },
    /** Pretend the server redrew a rectangle. */
    update(x, y, width, height) {
      damage.add(x, y, width, height);
      this.updateCount += 1;
      damage.commit(this.updateCount);
    },
  };
}

const session = new VncSession({});
session.client = fakeClient();
session.target = { host: 'fixture', port: 0 };
after(() => session.close());

test('describes regions with their text, and hints at buttons', async () => {
  const d = await session.describe();

  assert.deepEqual(Object.keys(d).sort(), ['cached', 'changedSince', 'desktop', 'elapsedMs', 'quiet', 'regions', 'text']);
  assert.deepEqual(d.desktop, { width: 1024, height: 768, update: 1 });
  assert.equal(d.cached, false);
  assert.equal(d.quiet, true);
  assert.equal(d.changedSince, null, 'nothing to compare with on the first look');
  assert.equal(d.regions.length, 9);

  const byText = (needle) => d.regions.find((r) => r.text?.includes(needle));
  const title = byText('Save changes?');
  assert.deepEqual(title.bbox, [681, 121, 300, 28]);
  assert.equal(title.textLines, 1);
  assert.equal(title.hint, undefined, 'a title bar has one line too, but left-aligned: not button-like');

  const save = d.regions.find((r) => r.text === 'Save');
  assert.ok(save, 'the Save button is a region whose text is exactly its label');
  assert.equal(save.hint, 'button-like');
  assert.equal(save.parent, byText('unsaved changes').id, 'inside the dialog body');
  assert.deepEqual(save.bbox, [906, 298, 62, 30]);

  const menu = byText('Applications');
  assert.equal(menu.hint, 'bar');

  const terminal = byText('type here');
  assert.ok(terminal.textLines >= 5, `the terminal has several lines, got ${terminal.textLines}`);
  assert.ok(terminal.text.split('\n').length === terminal.textLines, 'text is the lines joined');

  const empty = d.regions.find((r) => r.color === '#2e3440');
  assert.equal(empty.textLines, 0, 'the bare desktop has no text');
  assert.equal(empty.text, undefined);

  // The flat list has every line with a box in desktop pixels and its region.
  const line = d.text.find((l) => l.text === "Don't Save");
  assert.ok(line);
  assert.equal(line.region, d.regions.find((r) => r.text === "Don't Save").id);
  assert.ok(line.bbox.x > 798 && line.bbox.x + line.bbox.width < 798 + 98, 'inside the button');
  assert.equal(line.words, undefined, 'no word boxes unless asked');
});

test('a second look at the same screen is served from the cache and reports no change', async () => {
  const first = await session.describe();
  const second = await session.describe();
  assert.equal(second.cached, true);
  assert.equal(second.regions, first.regions, 'the very same objects');
  assert.deepEqual(second.changedSince, { update: 1, complete: true, rects: [] });
});

test('after the server redraws something, the change report says where', async () => {
  session.client.update(680, 120, 302, 222); // the dialog repainted
  const d = await session.describe();
  assert.equal(d.cached, false, 'a new update means a fresh description');
  assert.equal(d.desktop.update, 2);
  assert.deepEqual(d.changedSince, { update: 1, complete: true, rects: [{ x: 680, y: 120, width: 302, height: 222 }] });
});

test('since selects the baseline, and a screenshot counts as a look', async () => {
  session.client.update(0, 0, 10, 10);
  session.client.update(500, 500, 10, 10);
  const d = await session.describe({ since: 2, text: false });
  assert.deepEqual(d.changedSince.rects, [{ x: 0, y: 0, width: 10, height: 10 }, { x: 500, y: 500, width: 10, height: 10 }]);
  assert.equal(d.changedSince.update, 2);

  await session.screenshot({ quietMs: 0 });
  session.client.update(100, 100, 5, 5);
  const after = await session.describe({ text: false });
  assert.deepEqual(after.changedSince, { update: 4, complete: true, rects: [{ x: 100, y: 100, width: 5, height: 5 }] });
});

test('a baseline older than the history is reported as everything changed', async () => {
  for (let i = 0; i < 70; i++) session.client.update(i, 0, 1, 1);
  const d = await session.describe({ since: 3, text: false });
  assert.equal(d.changedSince.complete, false);
  assert.deepEqual(d.changedSince.rects, [{ x: 0, y: 0, width: 1024, height: 768 }]);
});

test('regions without text are quick and carry no text fields', async () => {
  const d = await session.describe({ text: false });
  assert.equal(d.text.length, 0);
  assert.equal(d.regions.length, 9);
  assert.equal(d.regions[0].textLines, undefined);
  assert.ok(d.elapsedMs < 1000, `regions alone took ${d.elapsedMs}ms`);
});

test('word boxes come through when asked', async () => {
  const d = await session.describe({ words: true });
  const line = d.text.find((l) => l.text === 'Save changes?');
  assert.deepEqual(line.words.map((w) => w.text), ['Save', 'changes?']);
});
