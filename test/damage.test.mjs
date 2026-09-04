/**
 * Unit tests for the damage log: the record of which rectangles each
 * framebuffer update touched.
 *
 * Run with: node --test test/damage.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DamageLog, mergeRects } from '../src/damage.js';

const r = (x, y, width, height) => ({ x, y, width, height });

test('mergeRects unions overlapping rectangles', () => {
  assert.deepEqual(mergeRects([r(0, 0, 10, 10), r(5, 5, 10, 10)]), [r(0, 0, 15, 15)]);
});

test('mergeRects unions touching rectangles but not separated ones', () => {
  assert.deepEqual(mergeRects([r(0, 0, 10, 10), r(10, 0, 10, 10)]), [r(0, 0, 20, 10)], 'edge to edge');
  assert.deepEqual(mergeRects([r(0, 0, 10, 10), r(11, 0, 10, 10)]), [r(0, 0, 10, 10), r(11, 0, 10, 10)], 'one pixel gap');
});

test('mergeRects chains: a merge can make two more rectangles touch', () => {
  // A and C do not touch; B bridges them.
  assert.deepEqual(mergeRects([r(0, 0, 5, 5), r(10, 0, 5, 5), r(5, 0, 5, 5)]), [r(0, 0, 15, 5)]);
});

test('mergeRects drops empty rectangles and sorts top-to-bottom, left-to-right', () => {
  assert.deepEqual(mergeRects([r(50, 50, 1, 1), r(0, 0, 0, 5), r(0, 10, 1, 1), r(0, 50, 1, 1)]), [
    r(0, 10, 1, 1),
    r(0, 50, 1, 1),
    r(50, 50, 1, 1),
  ]);
});

test('mergeRects collapses a scattering of many rectangles into their bounding box', () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push(r(i * 3, i * 3, 1, 1)); // 40 disjoint single pixels
  assert.deepEqual(mergeRects(many), [r(0, 0, 118, 118)]);
});

test('a scroll of many one-line CopyRects reads as one region', () => {
  const log = new DamageLog();
  for (let line = 0; line < 300; line++) log.add(0, 20 + line, 640, 1);
  log.commit(1);
  assert.deepEqual(log.since(0), { complete: true, rects: [r(0, 20, 640, 300)] });
});

test('since() reports only updates after the given number', () => {
  const log = new DamageLog();
  log.add(0, 0, 10, 10);
  log.commit(1);
  log.add(100, 100, 10, 10);
  log.commit(2);
  log.add(200, 200, 10, 10);
  log.commit(3);
  assert.deepEqual(log.since(1).rects, [r(100, 100, 10, 10), r(200, 200, 10, 10)]);
  assert.deepEqual(log.since(3), { complete: true, rects: [] }, 'nothing after the latest update');
  assert.equal(log.since(0).complete, true, 'the very first update is still remembered');
});

test('since() says so when the history no longer reaches back far enough', () => {
  const log = new DamageLog(3);
  for (let update = 1; update <= 5; update++) {
    log.add(update, 0, 1, 1);
    log.commit(update);
  }
  assert.equal(log.since(1).complete, false, 'update 2 has been forgotten');
  assert.equal(log.since(2).complete, true, 'updates 3-5 are all still here');
  assert.deepEqual(log.since(2).rects, [r(3, 0, 3, 1)], 'three adjacent pixels, merged');
});

test('an update with no decoded rectangles commits as empty', () => {
  const log = new DamageLog();
  log.commit(1);
  assert.deepEqual(log.since(0), { complete: true, rects: [] });
});
