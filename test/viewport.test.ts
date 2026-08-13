import test from 'node:test';
import assert from 'node:assert/strict';
import { viewport, MIN_ZOOM, MAX_ZOOM, renderScale } from '../src/engine/viewport.ts';

const near = (a: number, b: number, msg: string, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${msg} (${a} vs ${b})`);

/** Largura e altura, na ordem — o formato compacto que os testes usam. */
type Size = readonly [number, number];

interface SetupOptions {
  content?: Size;
  container?: Size;
}

/** The viewport is a singleton, so every test starts from a known state. */
function setup({ content = [1920, 1080], container = [960, 540] }: SetupOptions = {}) {
  viewport.fitMode = true;
  viewport.zoom = 1;
  viewport.panX = 0;
  viewport.panY = 0;
  viewport.contentW = content[0];
  viewport.contentH = content[1];
  viewport.containerW = 0;
  viewport.containerH = 0;
  viewport.setContainer(container[0], container[1]);
  return viewport;
}

test('fit scales the composition down to the container', () => {
  const v = setup({ content: [1920, 1080], container: [960, 540] });
  v.fit();
  // Both are 16:9, but the fixed 24px padding eats proportionally more of the
  // shorter axis, so height ends up limiting.
  near(v.zoom, (540 - 24) / 1080, 'fit picks the limiting axis');
  assert.ok(v.zoom * 1920 <= 960 && v.zoom * 1080 <= 540, 'result really fits');
  assert.ok(v.fitMode, 'stays in fit mode');
});

test('content smaller than the container is centred', () => {
  const v = setup({ content: [400, 200], container: [1000, 600] });
  v.setZoom(1);
  near(v.panX, (1000 - 400) / 2, 'centred horizontally');
  near(v.panY, (600 - 200) / 2, 'centred vertically');
});

test('zoom keeps the anchored point pinned', () => {
  const v = setup({ content: [1000, 1000], container: [500, 500] });
  v.setZoom(1);

  const anchorX = 120;
  const anchorY = 300;
  const before = v.screenToContent(anchorX, anchorY);

  v.setZoom(2, anchorX, anchorY);
  const after = v.screenToContent(anchorX, anchorY);

  near(after.x, before.x, 'x under the cursor is unchanged', 1e-4);
  near(after.y, before.y, 'y under the cursor is unchanged', 1e-4);
});

test('zoom is clamped to the allowed range', () => {
  const v = setup();
  v.setZoom(9999);
  near(v.zoom, MAX_ZOOM, 'clamped at the top');
  v.setZoom(0.0001);
  near(v.zoom, MIN_ZOOM, 'clamped at the bottom');
});

test('zoom steps move through the preset ladder', () => {
  const v = setup();
  v.setZoom(1);
  v.zoomIn();
  near(v.zoom, 1.5, 'steps up to the next rung');
  v.zoomOut();
  near(v.zoom, 1, 'steps back down');
});

test('panning cannot drag the content off the viewport', () => {
  const v = setup({ content: [1000, 1000], container: [500, 500] });
  v.setZoom(1);   // content 1000px inside a 500px window -> pannable

  v.panBy(10_000, 10_000);
  near(v.panX, 0, 'cannot pull the left edge inward');
  near(v.panY, 0, 'cannot pull the top edge inward');

  v.panBy(-10_000, -10_000);
  near(v.panX, 500 - 1000, 'stops at the right edge');
  near(v.panY, 500 - 1000, 'stops at the bottom edge');
});

test('pannable reflects whether content overflows', () => {
  const v = setup({ content: [1000, 1000], container: [500, 500] });
  v.setZoom(1);
  assert.equal(v.pannable, true, 'overflowing content pans');
  v.setZoom(0.25);
  assert.equal(v.pannable, false, 'content that fits does not');
});

test('changing resolution refits while in fit mode', () => {
  const v = setup({ content: [1920, 1080], container: [960, 540] });
  v.fit();
  const wide = v.zoom;

  v.setContent(1080, 1920);   // switch to vertical
  assert.ok(v.fitMode, 'still fitting');
  assert.ok(v.zoom < wide, 'a taller composition must scale down further');
  near(v.zoom, (540 - 24) / 1920, 'height is now the limiting axis');
});

test('an explicit zoom leaves fit mode, and fit restores it', () => {
  const v = setup();
  v.fit();
  v.setZoom(2);
  assert.equal(v.fitMode, false, 'manual zoom exits fit');
  v.fit();
  assert.equal(v.fitMode, true, 'fit re-enters it');
});

test('renderScale tracks how big the preview actually looks', () => {
  near(renderScale(0.25, 1), 0.25, 'zoomed out to 25%: render at 25% resolution');
  near(renderScale(1, 1), 1, 'at 100% zoom, native resolution');
});

test('renderScale folds in devicePixelRatio, capped', () => {
  near(renderScale(0.5, 2), 1, '50% zoom on a 2x screen still needs full native pixels');
  near(renderScale(0.5, 4), 1, 'dpr beyond 2x buys nothing, so it is capped there');
});

test('renderScale never collapses to zero on tiny zoom', () => {
  const s = renderScale(0.05, 1);
  assert.ok(s >= 0.15, `stays above the floor, got ${s}`);
});

test('renderScale allows sharpening past 100% but not without bound', () => {
  near(renderScale(4, 1), 2, 'zooming in for inspection is capped at 2x native, not 4x');
});
