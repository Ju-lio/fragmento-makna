import { drawFrame } from './renderer.ts';
import {
  frameCache, signatureOf, frameIndexAt, timeAtFrameIndex, CACHE_FPS,
} from './frameCache.ts';
import {
  isLayerActive, videoOwners, claimVideoElements, releaseVideoElements,
} from './videoSync.ts';
import { canDecode, ensureFrame, framesAt, sourceTimeFor } from './videoDecode.ts';
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
}

/** Quanto tempo esperar um seek antes de desistir dele. */
const SEEK_TIMEOUT_MS = 3000;

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
  const last = frameIndexAt(to, fps);
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
 * Leva um <video> até `time` e resolve quando o frame estiver de fato pronto.
 *
 * O `seeked` sozinho não basta: em alguns casos ele dispara antes do
 * `readyState` subir, e desenhar nessa janela pinta o frame anterior. Por isso
 * a espera também exige HAVE_CURRENT_DATA.
 */
function seekVideoTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise<void>(resolve => {
    const alreadyThere = Math.abs(video.currentTime - time) < 0.001 && video.readyState >= 2;
    if (alreadyThere) return resolve();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };

    const onSeeked = () => {
      if (video.readyState >= 2) finish();
      // readyState ainda baixo: espera o decoder soltar o frame de verdade.
      else video.addEventListener('loadeddata', finish, { once: true });
    };

    // Sem timeout, um seek perdido (acontece) travaria o pré-render pra sempre.
    const timer = setTimeout(finish, SEEK_TIMEOUT_MS);
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}

/**
 * Põe todos os vídeos ativos em `t` na posição certa, em paralelo.
 *
 * Exportado porque é a parte genuinamente difícil de compor quadro a quadro —
 * levar cada `<video>` ao instante exato e esperar o frame existir de verdade
 * — e o exportador precisa dela idêntica. Duas implementações disso divergiriam
 * e o arquivo exportado deixaria de bater com o preview.
 */
export async function stageVideosAt(project: Project, t: number): Promise<void> {
  // Um clipe por arquivo, senão dois clipes sobrepostos do mesmo vídeo mandam
  // o mesmo elemento pra dois instantes e esperam os dois seeks — o que sempre
  // resolve com o quadro de um dos dois, sem dizer qual. Ver `ownersByElement`.
  const active = videoOwners(project, t).filter(l => isLayerActive(l, t));

  await Promise.all(active.map(async layer => {
    const want = sourceTimeFor(layer, t);

    /**
     * Caminho normal: pedir o quadro ao decodificador.
     *
     * Não há seek nenhum envolvido — pede-se o quadro que cobre `want` e ele
     * vem. É por isso que o pré-render ficou mais rápido e, principalmente,
     * mais confiável: o `seeked` de um `<video>` podia chegar antes do quadro
     * existir, e o `SEEK_TIMEOUT_MS` abaixo existe justamente porque seek se
     * perde. Um decodificador não tem nenhum dos dois problemas.
     */
    if (await canDecode(layer.mediaId)) {
      if (await ensureFrame(layer.mediaId, want)) return;
      // Disse que decodifica e mesmo assim não entregou o quadro. Não pode
      // parar aqui: sem posicionar o elemento, o desenho cai nele e pinta o
      // que quer que ele estivesse mostrando — foi assim que um export inteiro
      // saiu congelado numa imagem só. Uma reserva que não é exercitada não é
      // reserva, é decoração.
    }

    // Rede de segurança: arquivo que este navegador não decodifica ainda pode
    // tocar num `<video>`. Pior imagem, mas imagem.
    if (!layer.video.paused) layer.video.pause();
    // A reprodução deixa o elemento num rate corrigido; aqui queremos o quadro
    // exato, sem herdar nada do ajuste de deriva do preview.
    layer.video.playbackRate = 1;
    await seekVideoTo(layer.video, want);
  }));
}

export async function prerenderRange(project: Project, {
  from, to, scale, onProgress, token = { cancelled: false }, fps = project.fps ?? CACHE_FPS,
}: PrerenderOptions): Promise<PrerenderResult> {
  const sig = signatureOf(project);
  frameCache.useSignature(sig, scale);

  const first = frameIndexAt(from, fps);
  const last = frameIndexAt(to, fps);
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
      await stageVideosAt(project, t);
      if (token.cancelled) return { rendered, cancelled: true };

      drawFrame(ctx, project, t, { fastPreview: false, frameFor: framesAt(t) });

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
