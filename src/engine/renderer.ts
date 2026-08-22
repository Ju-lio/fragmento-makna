import { resolveState } from './effects.ts';
import { drawOrder } from './project.ts';
import { coversAt } from './timeSpan.ts';
import { displayText } from './countUp.ts';
import { composicaoDe } from '../criar/api.ts';
import type { ImageLayer, Layer, LayerState, OverlayLayer, Project, VideoLayer } from './types.ts';

/** Um quadro já decodificado. `VideoFrame` e `ImageBitmap` servem os dois. */
export type FrameSource = CanvasImageSource & {
  displayWidth?: number; displayHeight?: number;
  width?: number; height?: number;
};

/** De onde sai o quadro de uma layer de vídeo. Ver `videoFrames.ts`. */
export type FrameLookup = (layer: VideoLayer) => FrameSource | null;

/**
 * De onde sai o quadro de um overlay. Ver `overlayFrames.ts`.
 *
 * Recebe `t` porque, ao contrário do vídeo, o instante faz parte da consulta:
 * o armazém guarda o quadro de UM instante por layer e recusa entregar o de
 * outro — pintar o vizinho seria a mesma mentira que `drawVideo` se recusa a
 * contar.
 */
export type OverlayLookup = (layer: OverlayLayer, t: number) => CanvasImageSource | null;

export interface DrawOptions {
  /** Pula o desfoque (a conta mais cara do quadro). Ver `degraded` no retorno. */
  fastPreview?: boolean;
  /**
   * O quadro decodificado de cada layer de vídeo, neste instante.
   *
   * Entra por PARÂMETRO, e não por um registro global que o desenho
   * consultasse sozinho, porque é isso que mantém `drawFrame` função pura de
   * (projeto, tempo, quadros) — a propriedade da qual "preview = export"
   * depende. Sem ela, preview e exportador poderiam desenhar o mesmo instante
   * com quadros diferentes e nada no tipo denunciaria.
   *
   * Devolver `null` marca o quadro como degradado: significa que a imagem
   * daquela layer não pôde ser desenhada como o arquivo final a terá.
   */
  frameFor?: FrameLookup;
  /** O quadro já rasterizado de cada overlay. Ausente = nenhum desenha. */
  overlayFor?: OverlayLookup;
}

export interface DrawResult {
  /**
   * Este quadro saiu abaixo do que o export produziria.
   *
   * Três causas: desfoque pulado pelo modo rápido, layer de vídeo sem o quadro
   * decodificado em mãos, ou overlay ainda não rasterizado. Nos três casos o
   * frame pode ser reexibido, mas não pode ser tomado por definitivo — é o que
   * impede o cache de mentir.
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
  const { fastPreview = false, frameFor, overlayFor } = opts;
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
    /**
     * Meio-aberto — ver `timeSpan.ts`.
     *
     * Com `t > start + duration` como corte, dois clipes encostados desenhavam
     * os dois no quadro da fronteira, e quem ficava por cima era o último do
     * array. Em projeto reorganizado, esse podia ser o clipe que ESTÁ SAINDO.
     */
    if (!coversAt(layer, t)) continue;

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
    if (layer.type === 'text') drawText(ctx, layer, st, (ctx.canvas.width / W) * st.scale, t);
    else if (layer.type === 'image' && layer.img) drawSource(ctx, layer, layer.img, W, H);
    else if (layer.type === 'video') {
      if (!drawVideo(ctx, layer, W, H, frameFor?.(layer) ?? null)) degraded = true;
    }
    else if (layer.type === 'overlay') {
      // O overlay é rasterizado no tamanho da composição, então desenha
      // centrado e do tamanho dela — a transformação da layer (posição,
      // escala, rotação, opacidade dos efeitos) já foi aplicada acima, como
      // pra qualquer outra.
      const quadro = overlayFor?.(layer, t) ?? null;
      if (quadro) {
        // A mistura é do COMPOSITOR, não do CSS: `mix-blend-mode` dentro do
        // efeito só enxerga o próprio fundo (transparente), nunca o vídeo.
        // Sem esta linha, grão de filme é impossível — `feTurbulence` gera
        // ruído opaco e cobriria o quadro com uma chapa cinza.
        ctx.globalCompositeOperation = composicaoDe(layer.blend);
        ctx.drawImage(quadro, -W / 2, -H / 2, W, H);
        ctx.globalCompositeOperation = 'source-over';
      } else degraded = true;
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
  t: number,
) {
  ctx.font = `${layer.size}px ${layer.font || DISPLAY_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = layer.color;

  // `letterSpacing` no canvas 2D ainda não é universal; sem a guarda, um
  // navegador sem suporte quebraria o desenho do texto inteiro.
  const canSpace = 'letterSpacing' in ctx;
  if (canSpace) ctx.letterSpacing = `${st.letterSpacing.toFixed(2)}px`;

  // `displayText`, não `layer.text` direto: com um contador ligado, o
  // conteúdo muda a cada quadro. Ver `countUp.ts` — é o ÚNICO lugar que
  // decide isso, compartilhado com `layerBox` pra moldura de seleção nunca
  // divergir do que está desenhado.
  const lines = displayText(layer, t).split('\n');
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
 * Desenha a layer de vídeo a partir do quadro decodificado.
 *
 * Devolve `false` quando não havia quadro — e aí o desenho daquela layer
 * simplesmente não acontece. É deliberado: pintar o quadro vizinho porque o
 * certo não chegou é o defeito que tirar o `<video>` do caminho veio matar.
 * Quem chama segura a imagem anterior, que é honesto, em vez de mostrar um
 * instante que o arquivo final não tem.
 */
function drawVideo(
  ctx: CanvasRenderingContext2D,
  layer: VideoLayer,
  W: number,
  H: number,
  frame: FrameSource | null,
): boolean {
  if (!frame) return false;
  const srcW = frame.displayWidth ?? frame.width;
  const srcH = frame.displayHeight ?? frame.height;
  drawSource(ctx, layer, frame, W, H, srcW, srcH);
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
