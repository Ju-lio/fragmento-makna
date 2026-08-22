import { drawFrame } from './renderer.ts';
import { overlayFrames } from './overlayFrames.ts';
import {
  frameCache, signatureOf, frameIndexAt, lastFrameIndex, timeAtFrameIndex, CACHE_FPS,
} from './frameCache.ts';
import { claimVideoElements, releaseVideoElements } from './videoSync.ts';
import type { FrameLookup } from './renderer.ts';
import type { Project } from './types.ts';
import type { Range } from './player.ts';
import { Progress } from './progress.ts';

/** Permite abortar um trabalho de fora — e identifica quem tem os `<video>`. */
export interface CancelToken { cancelled: boolean }

export interface PrerenderResult {
  rendered: number;
  cancelled: boolean;
}

export interface PrerenderOptions extends Range {
  /** Fração da resolução do projeto em que os quadros são gerados. */
  scale: number;
  onProgress?: (done: number, total: number) => void;
  token?: CancelToken;
  fps?: number;
  /** Obrigatório na prática; ausente, o trecho sai sem as layers de vídeo. */
  frames?: FrameProvider;
}

/** Quanto tempo trabalhar antes de devolver a vez ao navegador. */
const SLICE_MS = 12;

/**
 * Estado do pré-render, compartilhado entre quem dispara (o botão de play, o
 * botão de pré-render) e quem mostra progresso. Fora do React, como os demais.
 */
export const prerenderStatus = new Progress();

let activeToken: CancelToken | null = null;

export function cancelPrerender(): void {
  if (activeToken) activeToken.cancelled = true;
}

/** Todos os quadros do trecho já estão prontos em qualidade cheia? */
export function isRangeCached(project: Project, { from, to }: Range): boolean {
  const fps = project.fps;
  const sig = signatureOf(project);
  if (frameCache.signature !== sig) return false;

  const first = frameIndexAt(from, fps);
  // O mesmo intervalo meio-aberto que o export renderiza — ver `lastFrameIndex`.
  // Divergir aqui faria o pré-render declarar pronto um trecho com um quadro a
  // mais, ou nunca declarar pronto um que está.
  const last = lastFrameIndex(from, to, fps);
  for (let i = first; i <= last; i++) {
    if (!frameCache.has(sig, i)) return false;
  }
  return true;
}

/**
 * Garante o trecho no cache e devolve quando terminar. É o que transforma
 * "play com buraco" em "espera um pouco, depois roda liso".
 */
export async function ensureRangeCached(
  project: Project,
  opts: Omit<PrerenderOptions, 'token'>,
): Promise<PrerenderResult> {
  if (prerenderStatus.running) return { rendered: 0, cancelled: true };
  const token = { cancelled: false };
  activeToken = token;
  try {
    return await prerenderRange(project, { ...opts, token });
  } finally {
    activeToken = null;
    prerenderStatus.end();
  }
}

/**
 * De onde saem os quadros de vídeo — INJETADO, não importado.
 *
 * A implementação real vive em `videoFrames.ts`, que depende do `@elah/core`.
 * Esse pacote publica imports sem extensão, que o Node ESM recusa — e este
 * projeto roda os testes nos `.ts` direto, sem etapa de build. Importá-lo aqui
 * arrastaria o browser pra dentro do `node --test` e derrubaria a propriedade
 * que o README defende: a engine é testável sem framework e sem navegador.
 *
 * Injetar também é honesto quanto ao papel: preencher cache é decidir QUANDO
 * desenhar, não DE ONDE vem o pixel.
 */
export interface FrameProvider {
  /** Espera os quadros de `t`. `false` = estourou o limite. */
  stage(project: Project, t: number): Promise<boolean>;
  frameFor(project: Project, t: number): FrameLookup;
}

/**
 * Garante que todo quadro necessário pra desenhar `t` está decodificado.
 *
 * Exportado porque o pré-render e o export precisam **exatamente da mesma**
 * espera — duas implementações divergiriam e o arquivo deixaria de bater com o
 * preview.
 *
 * Ficou de três linhas. A versão anterior levava cada `<video>` ao instante e
 * esperava o `seeked` — com timeout, porque seek se perde, e com uma espera
 * extra por `loadeddata`, porque o `seeked` às vezes chega antes do quadro
 * existir. Nada disso existe quando se pede um quadro por número: ou ele está
 * decodificado, ou se espera ele ficar. Ver `videoFrames.ts`.
 *
 * Devolve `false` quando estourou a espera — e aí quem chama desenha com o que
 * tiver, marcando o quadro como degradado, em vez de travar pra sempre num
 * arquivo que este navegador não abre.
 */
export async function stageVideosAt(
  frames: FrameProvider, project: Project, t: number,
): Promise<boolean> {
  return frames.stage(project, t);
}

export async function prerenderRange(project: Project, {
  from, to, scale, onProgress, token = { cancelled: false }, fps = project.fps ?? CACHE_FPS, frames,
}: PrerenderOptions): Promise<PrerenderResult> {
  const sig = signatureOf(project);
  frameCache.useSignature(sig, scale);

  const first = frameIndexAt(from, fps);
  const last = lastFrameIndex(from, to, fps);
  const total = Math.max(0, last - first + 1);

  // Libera o orçamento pro trecho alvo antes de começar. Sem isso, quadros
  // de fora competem por memória e o descarte automático abre furos DENTRO
  // do trecho que acabou de ser preparado.
  frameCache.retainRange(first, last);

  const w = Math.max(1, Math.round(project.width * scale));
  const h = Math.max(1, Math.round(project.height * scale));
  const bytesPerFrame = w * h * 4;

  // Canvas próprio: o pré-render não pode ficar disputando (nem sujando) o
  // canvas que está na tela enquanto trabalha.
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d indisponível — não há como pré-renderizar');

  let rendered = 0;
  let sliceStart = performance.now();

  prerenderStatus.begin(total);
  // A partir daqui os <video> são nossos: o loop do preview para de mexer
  // neles até soltarmos, no finally lá embaixo.
  claimVideoElements(token);

  try {
    for (let i = first; i <= last; i++) {
      if (token.cancelled) return { rendered, cancelled: true };

      if (frameCache.has(sig, i)) {
        rendered++;
        onProgress?.(rendered, total);
        prerenderStatus.advance(rendered);
        continue;
      }

      const t = timeAtFrameIndex(i, fps);
      if (frames) await frames.stage(project, t);
      if (token.cancelled) return { rendered, cancelled: true };

      // Espera igual ao export: o pré-render guarda o quadro como DEFINITIVO
      // (`degraded: false`), então servir um sem o overlay envenenaria o cache
      // com uma composição incompleta.
      await overlayFrames.preparar(project, t, project.width, project.height);

      drawFrame(ctx, project, t, {
        fastPreview: false,
        frameFor: frames?.frameFor(project, t),
        overlayFor: (layer, quando) => overlayFrames.quadroDe(layer, quando),
      });

      const bitmap = await createImageBitmap(canvas);
      // Pré-render é sempre qualidade cheia — por isso `degraded: false`, e por
      // isso ele sobrepõe qualquer captura simplificada feita durante a reprodução.
      frameCache.set(sig, i, bitmap, bytesPerFrame, { degraded: false });

      rendered++;
      onProgress?.(rendered, total);
      prerenderStatus.advance(rendered);

      // Devolve a vez ao navegador em fatias de tempo, não a cada quadro: um
      // `setTimeout` por frame custa ~4ms de espera imposta pelo próprio
      // navegador, o que num projeto leve dominaria o trabalho de verdade.
      if (performance.now() - sliceStart >= SLICE_MS) {
        await new Promise(r => setTimeout(r, 0));
        sliceStart = performance.now();
      }
    }

    return { rendered, cancelled: false };
  } finally {
    releaseVideoElements(token);
  }
}
