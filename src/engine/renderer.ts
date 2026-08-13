import { resolveState } from './effects.ts';
import { drawOrder } from './project.ts';
import type { ImageLayer, Layer, LayerState, Project, VideoLayer } from './types.ts';

export interface DrawOptions {
  /** Pula o desfoque (a conta mais cara do quadro). Ver `degraded` no retorno. */
  fastPreview?: boolean;
}

export interface DrawResult {
  /** Algum desfoque foi de fato pulado neste quadro. Ver o comentário abaixo. */
  degraded: boolean;
}

/** Kept here, not in fonts.js, so this module stays free of browser-only asset
 *  imports and the data model above it can be tested in plain node. */
export const DISPLAY_FAMILY = 'InterBlack';
export const DISPLAY_FONT = `${DISPLAY_FAMILY}, "Arial Black", Impact, system-ui, sans-serif`;

/**
 * Draws one frame of the project onto a 2D context.
 *
 * Coordinates are always in the composition's LOGICAL size (`project.width` /
 * `project.height`), never the canvas element's physical pixel size. Those two
 * can now differ on purpose — see `renderScaleFor` in viewport.js — so this
 * function opens with a `ctx.scale()` that maps logical space onto however
 * many physical pixels the canvas actually has. A preview shrunk to a third
 * of its native resolution draws identically, just with less work per frame;
 * the export path passes a full-resolution canvas and gets a 1:1 scale.
 *
 * Otherwise still a pure function of (project, t, opts) — no globals, no time
 * reads — which is what keeps the preview and the exporter in agreement.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  t: number,
  opts: DrawOptions = {},
): DrawResult {
  const { fastPreview = false } = opts;
  const W = project.width;
  const H = project.height;

  /**
   * O modo rápido só é *visível* quando alguma layer realmente tinha desfoque
   * naquele instante — e a maioria dos frames não tem nenhum. Relatar isso
   * (em vez de assumir "reproduziu, logo é baixa qualidade") é o que permite
   * reaproveitar quase tudo que passa pela tela durante a reprodução: se nada
   * foi pulado, o frame é idêntico ao de qualidade cheia e vale pra sempre.
   */
  let degraded = false;

  ctx.save();
  ctx.scale(ctx.canvas.width / W, ctx.canvas.height / H);
  ctx.imageSmoothingQuality = 'high';

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = project.background || '#0b0c10';
  ctx.fillRect(0, 0, W, H);

  // Ordem de desenho por faixa, não a ordem do array: várias layers dividem
  // uma faixa agora, e é a faixa que decide quem fica por cima.
  for (const layer of drawOrder(project)) {
    if (t < layer.start || t > layer.start + layer.duration) continue;

    const st = resolveState(layer, t);
    if (st.opacity <= 0.001 || st.scale === 0) continue;

    ctx.save();
    ctx.translate(W / 2 + st.x, H / 2 + st.y);
    ctx.rotate((st.rotate * Math.PI) / 180);
    ctx.scale(st.scale, st.scale);
    ctx.globalAlpha = Math.max(0, Math.min(1, st.opacity));

    // Gaussian blur is a real per-pixel convolution — by far the costliest
    // thing a layer can ask for. Fast-preview mode drops it while scrubbing
    // or playing back; a paused frame always renders it in full.
    const filters = [];
    if (st.blur > 0.01) {
      if (fastPreview) degraded = true;
      else filters.push(`blur(${st.blur.toFixed(2)}px)`);
    }
    if (Math.abs(st.brightness - 1) > 0.001) filters.push(`brightness(${st.brightness.toFixed(3)})`);
    ctx.filter = filters.length ? filters.join(' ') : 'none';

    if (layer.type === 'text') drawText(ctx, layer, st);
    else if (layer.type === 'image' && layer.img) drawSource(ctx, layer, layer.img, W, H);
    else if (layer.type === 'video' && layer.video) drawVideo(ctx, layer, W, H);

    ctx.restore();
  }

  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.restore();

  return { degraded };
}

function drawText(ctx: CanvasRenderingContext2D, layer: Extract<Layer, { type: 'text' }>, st: LayerState) {
  ctx.font = `${layer.size}px ${layer.font || DISPLAY_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = layer.color;

  // `letterSpacing` no canvas 2D ainda não é universal; sem a guarda, um
  // navegador sem suporte quebraria o desenho do texto inteiro.
  const canSpace = 'letterSpacing' in ctx;
  if (canSpace) ctx.letterSpacing = `${st.letterSpacing.toFixed(2)}px`;

  const lines = String(layer.text).split('\n');
  const lh = layer.size * 1.12;
  const y0 = -((lines.length - 1) * lh) / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, 0, y0 + i * lh));

  if (canSpace) ctx.letterSpacing = '0px';
}

function drawVideo(ctx: CanvasRenderingContext2D, layer: VideoLayer, W: number, H: number) {
  const v = layer.video;
  // HAVE_CURRENT_DATA: before this, drawImage would throw or paint nothing.
  if (v.readyState < 2) return;
  drawSource(ctx, layer, v, W, H, v.videoWidth, v.videoHeight);
}

/** Draws an image/video centred on the origin, scaled to fit the composition. */
function drawSource(
  ctx: CanvasRenderingContext2D,
  layer: ImageLayer | VideoLayer,
  source: CanvasImageSource & { width?: number; height?: number },
  W: number,
  H: number,
  srcW: number | undefined = (source as HTMLImageElement).width,
  srcH: number | undefined = (source as HTMLImageElement).height,
) {
  if (!srcW || !srcH) return;
  const s = Math.min(W / srcW, H / srcH) * (layer.fit ?? 0.8);
  const w = srcW * s;
  const h = srcH * s;
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
}
