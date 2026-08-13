import test from 'node:test';
import assert from 'node:assert/strict';
import { trimLeft, trimRight, maxDuration, MIN_CLIP } from '../src/engine/project.js';
import { sourceTimeAt, isLayerActive } from '../src/engine/videoSync.js';

/** A 10s source, placed at t=2, showing seconds 1..5 of the file. */
const clip = () => ({
  type: 'video',
  start: 2,
  duration: 4,
  trimStart: 1,
  sourceDuration: 10,
});

/** Text/image layers have no source material to run out of. */
const textLayer = () => ({ type: 'text', start: 2, duration: 4, sourceDuration: Infinity });

test('sourceTimeAt maps timeline position onto the file', () => {
  const c = clip();
  assert.equal(sourceTimeAt(c, 2), 1, 'clip start reads from the trim point');
  assert.equal(sourceTimeAt(c, 4), 3, 'two seconds in reads two seconds further');
  assert.equal(sourceTimeAt(c, 6), 5, 'clip end reads the trimmed-out point');
});

test('isLayerActive covers exactly the clip span', () => {
  const c = clip();
  assert.equal(isLayerActive(c, 1.9), false);
  assert.equal(isLayerActive(c, 2), true);
  assert.equal(isLayerActive(c, 6), true);
  assert.equal(isLayerActive(c, 6.1), false);
});

test('maxDuration is whatever is left of the source after the trim', () => {
  assert.equal(maxDuration(clip()), 9, '10s file trimmed 1s in leaves 9s');
  assert.equal(maxDuration(textLayer()), Infinity, 'text has no limit');
});

test('trimRight cannot read past the end of the file', () => {
  const c = clip();
  assert.deepEqual(trimRight(c, 1), { duration: 5 }, 'grows freely inside the source');
  assert.deepEqual(trimRight(c, 100), { duration: 9 }, 'clamped to the remaining footage');
});

test('trimRight cannot shrink below the minimum clip length', () => {
  assert.deepEqual(trimRight(clip(), -100), { duration: MIN_CLIP });
});

test('trimLeft moves start and trim together so footage stays put', () => {
  const c = clip();
  const patch = trimLeft(c, 1);
  assert.deepEqual(patch, { start: 3, duration: 3, trimStart: 2 });

  // The frame shown at the new left edge is the one that was already there.
  assert.equal(sourceTimeAt({ ...c, ...patch }, 3), 2);
});

test('trimLeft cannot read before the start of the file', () => {
  const c = clip();               // trimStart is 1, so only 1s of headroom
  const patch = trimLeft(c, -5);
  assert.equal(patch.trimStart, 0, 'stops at the head of the source');
  assert.equal(patch.start, 1, 'start moves by the same amount it could rewind');
  assert.equal(patch.duration, 5, 'and the clip grows by exactly that much');
});

test('trimLeft cannot push a clip off the front of the timeline', () => {
  const c = { ...clip(), start: 0.5, trimStart: 100, sourceDuration: 200 };
  const patch = trimLeft(c, -5);
  assert.equal(patch.start, 0, 'clamped at zero');
  assert.equal(patch.duration, 4.5, 'grows only by the distance actually travelled');
});

test('trimLeft respects the minimum clip length', () => {
  const patch = trimLeft(clip(), 100);
  assert.equal(patch.duration, MIN_CLIP);
});

test('trimLeft on a text layer moves it without inventing a trim', () => {
  const patch = trimLeft(textLayer(), 1);
  assert.deepEqual(patch, { start: 3, duration: 3 }, 'no trimStart key for sourceless layers');
});

test('a no-op drag returns null instead of a redundant patch', () => {
  assert.equal(trimLeft(clip(), 0), null);
  assert.equal(trimRight(clip(), 0), null);
});
