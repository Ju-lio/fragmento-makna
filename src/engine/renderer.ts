import { resolveState } from './effects.ts';
import { drawOrder } from './project.ts';
import type { DecodedFrame, ImageLayer, Layer, LayerState, Project, VideoLayer } from './types.ts';

/** De onde sai o quadro de uma layer de vídeo. Ver `videoDecode.ts`. */
export type FrameLookup = (layer: VideoLayer) => DecodedFrame | null;

export interface DrawOptions {
  /** Pula o desfoque (a conta mais cara do quadro). Ver `degraded` no retorno. */
  fastPreview?: boolean;
  /**
   * O quadro decodificado de cada layer de vídeo, neste instante.
   *
   * Entra por parâmetro, e não por um registro global que o desenho consultasse
   * sozinho, porque é isso que mantém `drawFrame` **função pura de (projeto,
   * tempo, quadros)** — a propriedade da qual o "Preview = Export" depende.
   * Sem ela, preview e exportador poderiam desenhar o mesmo instante com
   * quadros diferentes e nada no tipo denunciaria.
   *
   * Devolver `null` faz o desenho cair no `<video>`, e marca o quadro como
   * degradado: o elemento mostra o que ele tiver, não o instante pedido.
   */
  frameFor?: FrameLookup;
}

export interface DrawResult {
  /**
   * Este quadro saiu abaixo do que o export produziria.
   *
   * Duas causas: um desfoque pulado pelo modo rápido, ou uma layer de vídeo
   * desenhada a partir do `<video>` por falta do quadro decodificado. Nos dois
   * casos o frame pode ser reexibido, mas não pode ser tomado por definitivo —
   * é o que impede o cache de mentir.
   */
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
  const { fastPreview = false, frameFor } = opts;
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

    // Escala total até o pixel físico: a do canvas vezes a da própria layer.
    // Só a sombra precisa disto — ver `drawText`.
    if (layer.type === 'text') drawText(ctx, layer, st, (ctx.canvas.width / W) * st.scale);
    else if (layer.type === 'image' && layer.img) drawSource(ctx, layer, layer.img, W, H);
    else if (layer.type === 'video') {
      const caiuNoElemento = drawVideo(ctx, layer, W, H, frameFor?.(layer) ?? null);
      if (caiuNoElemento) degraded = true;
    }

    ctx.restore();
  }

  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.restore();

  return { degraded };
}

/**
 * Desenha o texto, com contorno e sombra quando pedidos.
 *
 * Três passadas, nesta ordem, e a ordem é o que faz o resultado ficar legível:
 *
 *  1. **Sombra**, atrás de tudo. Desenhada sobre a silhueta mais externa (o
 *     contorno, se houver; senão o preenchimento), então a sombra segue o
 *     contorno da forma final em vez de escapar por baixo dele.
 *  2. **Contorno**, sem sombra — senão cada passada projetaria a sua e as duas
 *     se sobreporiam, engrossando a sombra num borrão.
 *  3. **Preenchimento**, por cima.
 *
 * `shadowScale` existe por um detalhe do canvas que quebraria a promessa
 * "preview = export": **sombra não é afetada pela transformação**. `lineWidth`
 * é, então o contorno acompanha o zoom sozinho; já `shadowBlur` e
 * `shadowOffsetY` estão em pixels de tela, e o preview desenha numa fração da
 * resolução do export. Sem multiplicar aqui, a mesma sombra sairia várias vezes
 * maior no preview do que no arquivo final.
 */
function drawText(
  ctx: CanvasRenderingContext2D,
  layer: Extract<Layer, { type: 'text' }>,
  st: LayerState,
  shadowScale: number,
) {
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
  const eachLine = (draw: (line: string, y: number) => void) =>
    lines.forEach((ln, i) => draw(ln, y0 + i * lh));

  const outlined = layer.strokeWidth > 0 && Boolean(layer.stroke);
  const shaded = Boolean(layer.shadow) && (layer.shadowBlur > 0 || layer.shadowOffset !== 0);

  if (outlined) {
    ctx.strokeStyle = layer.stroke;
    // Dobrado porque `strokeText` centra o traço na borda do glifo: metade cai
    // pra dentro da letra. Sem isto, um contorno de 8px aparece com 4.
    ctx.lineWidth = layer.strokeWidth * 2;
    // Cantos arredondados: em ponta, os vértices agudos de uma fonte pesada
    // disparam farpas bem mais longas que a espessura pedida.
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
  }

  if (shaded) {
    ctx.save();
    ctx.shadowColor = layer.shadow;
    ctx.shadowBlur = layer.shadowBlur * shadowScale;
    ctx.shadowOffsetY = layer.shadowOffset * shadowScale;
    eachLine((ln, y) => (outlined ? ctx.strokeText(ln, 0, y) : ctx.fillText(ln, 0, y)));
    ctx.restore();
  }

  if (outlined) eachLine((ln, y) => ctx.strokeText(ln, 0, y));
  eachLine((ln, y) => ctx.fillText(ln, 0, y));

  if (canSpace) ctx.letterSpacing = '0px';
}

/**
 * Desenha a layer de vídeo. Devolve `true` quando teve que cair no `<video>`.
 *
 * O quadro decodificado é o caminho certo: ele **é** o quadro daquele instante,
 * pedido por número e não por posição aproximada. O `<video>` fica como rede de
 * segurança pra arquivo que este navegador não decodifica — melhor uma imagem
 * aproximada que nenhuma imagem — e por isso o retorno é usado pra marcar o
 * quadro como degradado.
 */
function drawVideo(
  ctx: CanvasRenderingContext2D,
  layer: VideoLayer,
  W: number,
  H: number,
  frame: DecodedFrame | null,
): boolean {
  if (frame) {
    const s = Math.min(W / frame.displayWidth, H / frame.displayHeight) * (layer.fit ?? 0.8);
    const w = frame.displayWidth * s;
    const h = frame.displayHeight * s;
    frame.draw(ctx, -w / 2, -h / 2, w, h);
    return false;
  }

  const v = layer.video;
  // HAVE_CURRENT_DATA: before this, drawImage would throw or paint nothing.
  if (!v || v.readyState < 2) return true;
  drawSource(ctx, layer, v, W, H, v.videoWidth, v.videoHeight);
  return true;
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
