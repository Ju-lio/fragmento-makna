import { resolveState } from './effects.js';

/** Kept here, not in fonts.js, so this module stays free of browser-only asset
 *  imports and the data model above it can be tested in plain node. */
export const DISPLAY_FAMILY = 'InterBlack';
export const DISPLAY_FONT = `${DISPLAY_FAMILY}, "Arial Black", Impact, system-ui, sans-serif`;

/**
 * Draws one frame of the project onto a 2D context.
 * Pure function of (project, t) — no globals, no time reads. That determinism
 * is what lets the same code back both the live preview and the frame exporter.
 */
export function drawFrame(ctx, project, t) {
  const { width: W, height: H } = ctx.canvas;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = project.background || '#0b0c10';
  ctx.fillRect(0, 0, W, H);

  for (const layer of project.layers) {
    if (t < layer.start || t > layer.start + layer.duration) continue;

    const st = resolveState(layer, t);
    if (st.opacity <= 0.001 || st.scale === 0) continue;

    ctx.save();
    ctx.translate(W / 2 + st.x, H / 2 + st.y);
    ctx.rotate((st.rotate * Math.PI) / 180);
    ctx.scale(st.scale, st.scale);
    ctx.globalAlpha = Math.max(0, Math.min(1, st.opacity));

    const filters = [];
    if (st.blur > 0.01) filters.push(`blur(${st.blur.toFixed(2)}px)`);
    if (Math.abs(st.brightness - 1) > 0.001) filters.push(`brightness(${st.brightness.toFixed(3)})`);
    ctx.filter = filters.length ? filters.join(' ') : 'none';

    if (layer.type === 'text') drawText(ctx, layer, st);
    else if (layer.type === 'image' && layer.img) drawSource(ctx, layer, layer.img);
    else if (layer.type === 'video' && layer.video) drawVideo(ctx, layer);

    ctx.restore();
  }

  ctx.filter = 'none';
  ctx.globalAlpha = 1;
}

function drawText(ctx, layer, st) {
  ctx.font = `${layer.size}px ${layer.font || DISPLAY_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = layer.color;

  const canSpace = 'letterSpacing' in ctx;
  if (canSpace) ctx.letterSpacing = `${st.letterSpacing.toFixed(2)}px`;

  const lines = String(layer.text).split('\n');
  const lh = layer.size * 1.12;
  const y0 = -((lines.length - 1) * lh) / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, 0, y0 + i * lh));

  if (canSpace) ctx.letterSpacing = '0px';
}

function drawVideo(ctx, layer) {
  const v = layer.video;
  // HAVE_CURRENT_DATA: before this, drawImage would throw or paint nothing.
  if (v.readyState < 2) return;
  drawSource(ctx, layer, v, v.videoWidth, v.videoHeight);
}

/** Draws an image/video centred on the origin, scaled to fit the composition. */
function drawSource(ctx, layer, source, srcW = source.width, srcH = source.height) {
  if (!srcW || !srcH) return;
  const { width: W, height: H } = ctx.canvas;
  const s = Math.min(W / srcW, H / srcH) * (layer.fit ?? 0.8);
  const w = srcW * s;
  const h = srcH * s;
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
}
