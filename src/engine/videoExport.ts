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
import { frameIndexAt, lastFrameIndex, timeAtFrameIndex, CACHE_FPS } from './frameCache.ts';
import { claimVideoElements, releaseVideoElements, pauseAllVideo } from './videoSync.ts';
import { stageVideosAt } from './prerender.ts';
import { frameProvider } from './videoFrames.ts';
import { overlayFrames } from './overlayFrames.ts';
import type { CancelToken } from './prerender.ts';
import { ensureDisplayFont } from './fonts.ts';
import { Progress } from './progress.ts';
import {
  CODEC_CANDIDATES, AUDIO_CODEC_CANDIDATES, evenDimensions, frameTimestamp,
  keyFrameInterval, chooseBitrate, frameCount, exportFileName,
} from './exportPlan.ts';
import type { Qualidade } from './exportPlan.ts';
import { renderAudio, sliceAudio, SAMPLE_RATE, CHANNELS } from './audioRender.ts';
import type { BlobResolver } from './audioRender.ts';
import type { Project } from './types.ts';
import type { Range } from './player.ts';

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

/**
 * O mesmo freio pro áudio, mais folgado porque um bloco de PCM é ordens de
 * grandeza menor que um quadro de 1080p.
 *
 * Sem freio nenhum, o laço enfileirava a faixa inteira de uma vez, síncrono:
 * três minutos viravam ~2100 blocos empilhados antes do encoder tocar no
 * primeiro, e a aba ficava travada o tempo todo.
 */
const AUDIO_MAX_QUEUE = 32;

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

/** Ids de mídia viram nomes de arquivo — é o que a pessoa reconhece num aviso. */
function mediaNames(project: Project, ids: readonly string[]): string[] {
  return ids.map(id => project.media.find(m => m.id === id)?.name ?? id);
}

interface ChosenAudioCodec {
  muxer: 'aac' | 'opus';
  label: string;
  config: AudioEncoderConfig;
}

/**
 * Primeiro codec de áudio que este navegador aceita, ou `null` se nenhum.
 *
 * Perguntar antes é o ponto: ver `AUDIO_CODEC_CANDIDATES` pra por que
 * `configure()` não serve como teste.
 */
async function chooseAudioCodec(): Promise<ChosenAudioCodec | null> {
  if (typeof AudioEncoder === 'undefined') return null;

  for (const candidate of AUDIO_CODEC_CANDIDATES) {
    const config: AudioEncoderConfig = {
      codec: candidate.codec,
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: AUDIO_BITRATE,
    };
    try {
      const { supported } = await AudioEncoder.isConfigSupported(config);
      if (supported) return { muxer: candidate.muxer, label: candidate.label, config };
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
  /**
   * Quanto bit gastar. Ver `BITS_POR_PIXEL` em `exportPlan.ts` pro porquê dos
   * números — em resumo, grão de filme e desfoque pesado precisam de `alta`.
   */
  qualidade?: Qualidade;
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
  /**
   * Mídias cujo som não entrou, pelo nome.
   *
   * Existe porque a alternativa era o que acontecia antes: uma faixa que o
   * navegador não decodifica sumia do arquivo sem nada avisar, e você só
   * descobria assistindo o resultado.
   */
  audioFailed: string[];
  /**
   * Por que a trilha inteira ficou de fora, ou `null` se não ficou.
   *
   * Separado de `audioFailed`: um arquivo que não decodifica e um navegador sem
   * encoder nenhum são problemas diferentes, e a saída pra cada um também.
   */
  audioSkipped: string | null;
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
    from, to, fps = project.fps ?? CACHE_FPS, scale = 1, qualidade = 'normal',
    token = { cancelled: false }, onProgress, getBlob,
  }: ExportOptions,
): Promise<ExportResult | null> {
  const support = exportSupport();
  if (!support.ok) throw new ExportUnsupportedError(support.reason ?? 'Export indisponível');

  const { width, height } = evenDimensions(project, scale);
  const bitrate = chooseBitrate({ width, height }, fps, qualidade);

  const chosen = await chooseCodec(width, height, fps, bitrate);
  if (!chosen) {
    throw new ExportUnsupportedError(
      `Nenhum codec de vídeo disponível para ${width}×${height}. Tente uma resolução menor.`,
    );
  }

  const first = frameIndexAt(from, fps);
  // Meio-aberto: o quadro que começa em `to` é o primeiro do que vem DEPOIS do
  // trecho. Ver `lastFrameIndex` — contá-lo gravava um quadro a mais em todo
  // export, e o arquivo saía 1/fps mais longo que o projeto.
  const last = lastFrameIndex(from, to, fps);
  const total = frameCount(first, last);
  if (total === 0) throw new ExportUnsupportedError('O trecho selecionado não tem quadros.');

  /**
   * O som cobre exatamente o mesmo intervalo que os quadros — e não `from..to`.
   *
   * O vídeo não começa em `from`: começa no quadro da grade mais próximo, e o
   * último quadro dura mais 1/fps depois de `to`. Mixar o som no intervalo cru
   * punha as duas trilhas em origens diferentes, e o desencontro chegava a meio
   * quadro sempre que o IN foi marcado no cursor — que quase nunca cai na
   * grade, porque `player.t` vem do rAF. O fim tinha o problema espelhado: o
   * último quadro saía sem som.
   */
  const audioRange = {
    from: timeAtFrameIndex(first, fps),
    to: timeAtFrameIndex(last + 1, fps),
  };

  // A fonte do canvas precisa estar carregada ANTES do primeiro quadro, senão
  // o arquivo sai com a fonte de fallback — e o preview mostrando outra coisa.
  await ensureDisplayFont();
  await document.fonts.ready;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ExportUnsupportedError('Canvas 2D indisponível.');

  const keyEvery = keyFrameInterval(fps);
  let encodeError: unknown = null;
  let encoded = 0;
  // Declarados fora do `try` só pro `finally` conseguir fechá-los: o momento em
  // que cada um nasce depende de decisões tomadas lá dentro.
  let encoder: VideoEncoder | null = null;
  let audioEncoder: AudioEncoder | null = null;
  let audioSkipped: string | null = null;

  /**
   * Progresso e cancelamento existem a partir DAQUI, antes da mixagem.
   *
   * Estavam depois dela, e a mixagem é justamente a fase que decodifica os
   * arquivos inteiros: pelo trecho mais demorado do export a aba ficava parada,
   * sem barra nenhuma e com o botão PARAR inerte, porque `activeToken` ainda
   * era nulo. Quem exporta uma música de três minutos passava esse tempo sem
   * saber se tinha travado.
   */
  activeToken = token;
  exportStatus.begin(total);

  // Os `<video>` são nossos daqui até o `finally`: o loop do preview
  // continuaria empurrando cada um pra posição do cursor, e os quadros sairiam
  // com o vídeo no instante errado. Reivindicar antes da mixagem também tira
  // os elementos de cima do decoder, que é o recurso que ela vai disputar.
  pauseAllVideo(project);
  claimVideoElements(token);

  try {
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
      ? await renderAudio(project.layers, audioRange, getBlob).catch(() => null)
      : null;
    if (token.cancelled) return null;

    /**
     * O codec é escolhido AQUI, antes do muxer, porque é ele que nomeia a
     * trilha de áudio na construção — e a trilha só pode ser declarada se
     * houver mesmo um encoder pra preenchê-la. Declarar e não preencher deixa
     * o arquivo com uma faixa vazia.
     */
    const audioCodec = audio ? await chooseAudioCodec() : null;
    if (audio && !audioCodec) {
      audioSkipped = 'Este navegador não tem encoder de áudio (nem AAC nem Opus).';
    }
    const withAudio = audio && audioCodec ? { buffer: audio.buffer, codec: audioCodec } : null;

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: chosen.muxer, width, height, frameRate: fps },
      ...(withAudio
        ? {
          audio: {
            codec: withAudio.codec.muxer,
            numberOfChannels: CHANNELS,
            sampleRate: SAMPLE_RATE,
          },
        }
        : {}),
      // Metadados no começo do arquivo: é o que faz o vídeo começar a tocar sem
      // baixar tudo, e o que players e redes sociais esperam encontrar.
      fastStart: 'in-memory',
    });

    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      // O erro chega por aqui, fora da pilha de quem chamou `encode()`. Guardar
      // e checar no laço é o que transforma isso numa exceção que você vê.
      error: err => { encodeError = err; },
    });
    encoder.configure(chosen.config);

    /**
     * O áudio é codificado inteiro antes do vídeo começar.
     *
     * O muxer aceita as duas trilhas em qualquer ordem, e adiantar a de áudio
     * evita manter o buffer de PCM vivo durante todo o laço de vídeo — que é a
     * fase longa e a que já está no limite de memória.
     */
    if (withAudio) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: err => { encodeError = err; },
      });
      audioEncoder.configure(withAudio.codec.config);

      let audioSlice = performance.now();
      for (const chunk of sliceAudio(withAudio.buffer)) {
        if (token.cancelled) { chunk.close(); return null; }
        try {
          audioEncoder.encode(chunk);
        } finally {
          chunk.close();
        }

        // Mesmo freio do laço de vídeo, pelo mesmo motivo: `encode()` não
        // bloqueia, então sem isto o PCM se acumula mais rápido do que o
        // encoder consome — e nada devolve a vez ao navegador no caminho.
        while (audioEncoder.encodeQueueSize > AUDIO_MAX_QUEUE && !token.cancelled) {
          await new Promise(r => setTimeout(r, 0));
        }
        if (performance.now() - audioSlice >= SLICE_MS) {
          await new Promise(r => setTimeout(r, 0));
          audioSlice = performance.now();
        }
      }

      if (token.cancelled) return null;
      await audioEncoder.flush();
      if (encodeError) throw encodeError;
    }

    let sliceStart = performance.now();

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
      await stageVideosAt(frameProvider, project, t);
      // Aqui se ESPERA, ao contrário do preview: o arquivo final não pode sair
      // com uma layer faltando porque a rasterização não tinha terminado.
      const overlays = await overlayFrames.quadrosEm(project, t, project.width, project.height);
      if (token.cancelled) return null;

      drawFrame(ctx, project, t, {
        fastPreview: false,
        frameFor: frameProvider.frameFor(project, t),
        // Do mapa que ACABOU de ser preparado, não do armazém: o preview
        // compartilha o armazém e pode trocar o quadro guardado no meio.
        overlayFor: layer => overlays.get(layer.id) ?? null,
      });

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
      // O rótulo leva os dois codecs: quando o áudio cai pro Opus, o arquivo
      // continua abrindo em todo lugar, mas é bom você saber que caiu.
      codec: withAudio ? `${chosen.label} + ${withAudio.codec.label}` : chosen.label,
      frames: encoded,
      hasAudio: withAudio !== null,
      audioFailed: mediaNames(project, audio?.failed ?? []),
      audioSkipped,
    };
  } finally {
    releaseVideoElements(token);
    activeToken = null;
    exportStatus.end();
    // `close()` num encoder já fechado lança; o estado depende de ter dado
    // erro, cancelado ou terminado, então não vale confiar no caminho.
    try { encoder?.close(); } catch { /* já estava fechado */ }
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
