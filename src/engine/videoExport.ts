/**
 * Export de vídeo via WebCodecs.
 *
 * Reaproveita o pré-render de propósito: `stageVideosAt` leva cada `<video>`
 * ao instante exato e espera o quadro existir de verdade, que é a parte
 * genuinamente difícil de compor quadro a quadro. Duas implementações disso
 * divergiriam, e o arquivo exportado deixaria de bater com o preview — que é a
 * promessa que o editor faz desde o começo ("Preview = Export").
 *
 * A diferença pro pré-render é só o destino: em vez de guardar o bitmap no
 * cache, o quadro vai pro encoder e do encoder pro muxer.
 *
 * Sempre em **qualidade cheia** (`fastPreview: false`), com as fontes já
 * carregadas. O preview pode simplificar o desfoque pra manter a fluidez; o
 * arquivo final, não.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { drawFrame } from './renderer.ts';
import { frameIndexAt, timeAtFrameIndex, CACHE_FPS } from './frameCache.ts';
import { claimVideoElements, releaseVideoElements, pauseAllVideo } from './videoSync.ts';
import { stageVideosAt } from './prerender.ts';
import type { CancelToken } from './prerender.ts';
import { ensureDisplayFont } from './fonts.ts';
import { Progress } from './progress.ts';
import {
  CODEC_CANDIDATES, evenDimensions, frameTimestamp, keyFrameInterval,
  chooseBitrate, frameCount, exportFileName,
} from './exportPlan.ts';
import { renderAudio, sliceAudio, SAMPLE_RATE, CHANNELS } from './audioRender.ts';
import type { BlobResolver } from './audioRender.ts';
import type { Project } from './types.ts';
import type { Range } from './player.ts';

/** Codec de áudio do MP4. AAC-LC é o que qualquer player abre. */
const AUDIO_CODEC = 'mp4a.40.2';
const AUDIO_BITRATE = 128_000;

export const exportStatus = new Progress();

let activeToken: CancelToken | null = null;

export function cancelExport(): void {
  if (activeToken) activeToken.cancelled = true;
}

/**
 * Quanto tempo codificar antes de devolver a vez ao navegador.
 *
 * Sem isso a aba congela pelo export inteiro — inclusive o botão de cancelar,
 * que é justamente o que a pessoa vai querer apertar quando perceber que vai
 * demorar.
 */
const SLICE_MS = 12;

/**
 * Quantos quadros deixar na fila do encoder antes de esperar.
 *
 * O `encode()` não bloqueia: enfileirar 4000 quadros de 1080p é enfileirar
 * gigabytes de bitmap cru na memória, e a aba morre antes de terminar. Este é
 * o freio.
 */
const MAX_QUEUE = 8;

export class ExportUnsupportedError extends Error {}

/** O navegador tem o que é preciso pra exportar? */
export function exportSupport(): { ok: boolean; reason: string | null } {
  if (typeof VideoEncoder === 'undefined') {
    return { ok: false, reason: 'Este navegador não tem WebCodecs. Tente Chrome ou Edge.' };
  }
  return { ok: true, reason: null };
}

interface ChosenCodec {
  codec: string;
  muxer: 'avc' | 'vp9';
  label: string;
  config: VideoEncoderConfig;
}

/**
 * Primeiro codec que o navegador aceita PARA ESTAS DIMENSÕES.
 *
 * O suporte não é uma propriedade do codec sozinho: o mesmo H.264 que aceita
 * 1080p pode recusar 4K, porque o nível declarado no nome do codec limita a
 * resolução. Por isso a pergunta vai com a configuração inteira.
 */
async function chooseCodec(
  width: number, height: number, fps: number, bitrate: number,
): Promise<ChosenCodec | null> {
  for (const candidate of CODEC_CANDIDATES) {
    const config: VideoEncoderConfig = {
      codec: candidate.codec,
      width,
      height,
      bitrate,
      framerate: fps,
    };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return { ...candidate, config };
    } catch {
      // Configuração malformada pra este navegador: tenta a próxima.
    }
  }
  return null;
}

export interface ExportOptions extends Range {
  fps?: number;
  /** Fração da resolução do projeto. 1 = cheia, que é o padrão pro arquivo final. */
  scale?: number;
  token?: CancelToken;
  onProgress?: (done: number, total: number) => void;
  /**
   * De onde ler os bytes de cada mídia, pra mixar o som. Sem isso o export sai
   * mudo — é o que mantém este módulo sem saber que IndexedDB existe.
   */
  getBlob?: BlobResolver;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  /** Qual codec acabou sendo usado — a interface avisa quando não foi H.264. */
  codec: string;
  frames: number;
  /** O arquivo saiu com trilha de áudio? */
  hasAudio: boolean;
}

/**
 * Compõe o trecho quadro a quadro e devolve o arquivo.
 *
 * `null` quando você cancelou. Erros de verdade (sem WebCodecs, nenhum codec
 * aceito) sobem como exceção, porque são coisas que o usuário precisa ler.
 */
export async function exportVideo(
  project: Project,
  {
    from, to, fps = project.fps ?? CACHE_FPS, scale = 1,
    token = { cancelled: false }, onProgress, getBlob,
  }: ExportOptions,
): Promise<ExportResult | null> {
  const support = exportSupport();
  if (!support.ok) throw new ExportUnsupportedError(support.reason ?? 'Export indisponível');

  const { width, height } = evenDimensions(project, scale);
  const bitrate = chooseBitrate({ width, height }, fps);

  const chosen = await chooseCodec(width, height, fps, bitrate);
  if (!chosen) {
    throw new ExportUnsupportedError(
      `Nenhum codec de vídeo disponível para ${width}×${height}. Tente uma resolução menor.`,
    );
  }

  const first = frameIndexAt(from, fps);
  const last = frameIndexAt(to, fps);
  const total = frameCount(first, last);
  if (total === 0) throw new ExportUnsupportedError('O trecho selecionado não tem quadros.');

  // A fonte do canvas precisa estar carregada ANTES do primeiro quadro, senão
  // o arquivo sai com a fonte de fallback — e o preview mostrando outra coisa.
  await ensureDisplayFont();
  await document.fonts.ready;

  /**
   * O som é mixado ANTES do primeiro quadro, e não em paralelo.
   *
   * A mixagem decodifica os arquivos inteiros, e fazer isso enquanto o
   * `<video>` está sendo levado quadro a quadro coloca os dois disputando o
   * mesmo decoder — o que atrasa os seeks e, pior, é a situação em que eles
   * começam a falhar por timeout.
   *
   * Também define se a trilha de áudio existe no muxer, que precisa ser
   * declarada na construção dele.
   */
  const audio = getBlob && typeof OfflineAudioContext !== 'undefined'
    ? await renderAudio(project.layers, { from, to }, getBlob).catch(() => null)
    : null;
  if (token.cancelled) return null;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: chosen.muxer, width, height, frameRate: fps },
    ...(audio
      ? { audio: { codec: 'aac' as const, numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE } }
      : {}),
    // Metadados no começo do arquivo: é o que faz o vídeo começar a tocar sem
    // baixar tudo, e o que players e redes sociais esperam encontrar.
    fastStart: 'in-memory',
  });

  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    // O erro chega por aqui, fora da pilha de quem chamou `encode()`. Guardar
    // e checar no laço é o que transforma isso numa exceção que você vê.
    error: err => { encodeError = err; },
  });
  encoder.configure(chosen.config);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ExportUnsupportedError('Canvas 2D indisponível.');

  /**
   * O áudio é codificado inteiro antes do vídeo começar.
   *
   * O muxer aceita as duas trilhas em qualquer ordem, e adiantar a de áudio
   * evita manter o buffer de PCM vivo durante todo o laço de vídeo — que é a
   * fase longa e a que já está no limite de memória.
   */
  let audioEncoder: AudioEncoder | null = null;
  if (audio) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: err => { encodeError = err; },
    });
    audioEncoder.configure({
      codec: AUDIO_CODEC,
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: AUDIO_BITRATE,
    });

    for (const chunk of sliceAudio(audio.buffer)) {
      try {
        audioEncoder.encode(chunk);
      } finally {
        chunk.close();
      }
    }
    await audioEncoder.flush();
  }

  const keyEvery = keyFrameInterval(fps);
  let sliceStart = performance.now();
  let encoded = 0;

  activeToken = token;
  exportStatus.begin(total);

  // Os `<video>` são nossos daqui até o `finally`: o loop do preview
  // continuaria empurrando cada um pra posição do cursor, e os quadros sairiam
  // com o vídeo no instante errado.
  pauseAllVideo(project);
  claimVideoElements(token);

  try {
    for (let i = first; i <= last; i++) {
      if (token.cancelled) return null;
      if (encodeError) throw encodeError;

      // Freio de fila: `encode()` não bloqueia, e sem isto os quadros crus se
      // acumulam na memória mais rápido do que o encoder os consome.
      while (encoder.encodeQueueSize > MAX_QUEUE && !token.cancelled) {
        await new Promise(r => setTimeout(r, 0));
      }
      if (token.cancelled) return null;

      const t = timeAtFrameIndex(i, fps);
      await stageVideosAt(project, t);
      if (token.cancelled) return null;

      drawFrame(ctx, project, t, { fastPreview: false });

      const frame = new VideoFrame(canvas, {
        timestamp: frameTimestamp(i, first, fps),
        duration: Math.round(1_000_000 / fps),
      });
      try {
        encoder.encode(frame, { keyFrame: (i - first) % keyEvery === 0 });
      } finally {
        // Sempre: um VideoFrame não liberado segura a memória do quadro inteiro
        // até o coletor passar, e o export estoura a aba muito antes disso.
        frame.close();
      }

      encoded++;
      onProgress?.(encoded, total);
      exportStatus.advance(encoded);

      // Fatias de tempo, não um `setTimeout` por quadro: o navegador impõe ~4ms
      // de espera em cada um, o que dominaria o trabalho de verdade.
      if (performance.now() - sliceStart >= SLICE_MS) {
        await new Promise(r => setTimeout(r, 0));
        sliceStart = performance.now();
      }
    }

    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();

    const { buffer } = muxer.target;
    const extension = chosen.muxer === 'avc' ? 'mp4' : 'webm';

    return {
      blob: new Blob([buffer], { type: 'video/mp4' }),
      fileName: exportFileName(from, to, extension),
      codec: chosen.label,
      frames: encoded,
      hasAudio: audio !== null,
    };
  } finally {
    releaseVideoElements(token);
    activeToken = null;
    exportStatus.end();
    // `close()` num encoder já fechado lança; o estado depende de ter dado
    // erro, cancelado ou terminado, então não vale confiar no caminho.
    try { encoder.close(); } catch { /* já estava fechado */ }
    try { audioEncoder?.close(); } catch { /* idem */ }
  }
}

/** Entrega o arquivo pro usuário. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // Revogar na hora cancela o download em alguns navegadores: a URL some antes
  // de eles terminarem de ler.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
