/**
 * Mixa as trilhas do projeto num único buffer, pro export.
 *
 * Usa `OfflineAudioContext`, que é exatamente a ferramenta certa: ele renderiza
 * mais rápido que tempo real e resolve sozinho a soma das fontes, o ganho de
 * cada uma e o alinhamento por instante. Somar `Float32Array` na mão daria o
 * mesmo resultado com muito mais chance de erro de um sample.
 *
 * A decodificação é o passo caro (um MP3 de 3 minutos vira ~30 MB de PCM), por
 * isso cada `mediaId` é decodificado UMA vez, mesmo que apareça em vários
 * clipes — cortar uma música em pedaços é o caso comum.
 */

import { mixPlan } from './audioMix.ts';
import type { MixClip } from './audioMix.ts';
import type { Layer } from './types.ts';

/** Taxa de amostragem da saída. 48kHz é o que AAC e o resto do mundo usam. */
export const SAMPLE_RATE = 48_000;

/** Estéreo. Mono viraria um canal só num arquivo que todo player espera em dois. */
export const CHANNELS = 2;

export interface RenderedAudio {
  buffer: AudioBuffer;
  /** Trilhas que não deram pra decodificar — quem chama avisa. */
  failed: string[];
}

/** De onde vêm os bytes de cada mídia. Injetado pra este módulo não conhecer o IndexedDB. */
export type BlobResolver = (mediaId: string) => Promise<Blob | null>;

/**
 * Decodifica cada mídia usada, uma vez só.
 *
 * `decodeAudioData` aceita MP4/WebM e extrai a trilha de áudio, então o mesmo
 * caminho serve pra música solta e pro som de um clipe de vídeo.
 */
async function decodeAll(
  clips: readonly MixClip[],
  getBlob: BlobResolver,
  ctx: BaseAudioContext,
): Promise<{ buffers: Map<string, AudioBuffer>; failed: string[] }> {
  const buffers = new Map<string, AudioBuffer>();
  const failed: string[] = [];

  for (const mediaId of new Set(clips.map(c => c.mediaId))) {
    try {
      const blob = await getBlob(mediaId);
      if (!blob) { failed.push(mediaId); continue; }
      buffers.set(mediaId, await ctx.decodeAudioData(await blob.arrayBuffer()));
    } catch {
      // Arquivo sem trilha de áudio (um vídeo mudo), ou codec que este
      // navegador não decodifica. Seguir sem ele é melhor que abortar o
      // export inteiro por causa de uma faixa.
      failed.push(mediaId);
    }
  }

  return { buffers, failed };
}

/**
 * Renderiza o trecho num buffer só.
 *
 * `null` quando não há som nenhum — quem chama pula a trilha de áudio no
 * arquivo em vez de gravar silêncio, que ocuparia espaço e faria alguns
 * players mostrarem uma faixa vazia.
 */
export async function renderAudio(
  layers: readonly Layer[],
  { from, to }: { from: number; to: number },
  getBlob: BlobResolver,
): Promise<RenderedAudio | null> {
  const clips = mixPlan(layers, { from, to });
  if (!clips.length) return null;

  const seconds = Math.max(0, to - from);
  if (seconds <= 0) return null;

  const frames = Math.ceil(seconds * SAMPLE_RATE);
  const ctx = new OfflineAudioContext(CHANNELS, frames, SAMPLE_RATE);

  const { buffers, failed } = await decodeAll(clips, getBlob, ctx);
  const usable = clips.filter(c => buffers.has(c.mediaId));
  if (!usable.length) return null;

  for (const clip of usable) {
    const buffer = buffers.get(clip.mediaId);
    if (!buffer) continue;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const gain = ctx.createGain();
    gain.gain.value = clip.gain;

    source.connect(gain).connect(ctx.destination);

    // O buffer decodificado pode ser mais curto que o `sourceDuration` que a
    // layer anunciou (o elemento arredonda). Pedir além do fim faz o
    // BufferSource lançar e derruba o export.
    const available = Math.max(0, buffer.duration - clip.offset);
    const duration = Math.min(clip.duration, available);
    if (duration <= 0) continue;

    source.start(clip.at, clip.offset, duration);
  }

  return { buffer: await ctx.startRendering(), failed };
}

/**
 * Fatia o buffer em `AudioData` pro encoder.
 *
 * Em fatias e não de uma vez porque um `AudioData` de três minutos é um
 * bloco contíguo enorme, e o encoder trabalha melhor com pedaços — do mesmo
 * jeito que o vídeo é entregue quadro a quadro.
 *
 * O formato é `f32-planar`: os canais vêm um depois do outro no mesmo array,
 * não intercalados. Trocar os dois formatos produz um arquivo que toca, com os
 * canais embaralhados — o tipo de erro que só se percebe ouvindo.
 */
export function* sliceAudio(buffer: AudioBuffer, framesPerChunk = 4096): Generator<AudioData> {
  const channels = Math.min(CHANNELS, buffer.numberOfChannels);

  for (let offset = 0; offset < buffer.length; offset += framesPerChunk) {
    const count = Math.min(framesPerChunk, buffer.length - offset);
    const data = new Float32Array(count * CHANNELS);

    for (let ch = 0; ch < CHANNELS; ch++) {
      // Fonte mono num arquivo estéreo: repete o canal 0 nos dois lados, em
      // vez de deixar o direito mudo.
      const from = buffer.getChannelData(ch < channels ? ch : 0);
      data.set(from.subarray(offset, offset + count), ch * count);
    }

    yield new AudioData({
      format: 'f32-planar',
      sampleRate: buffer.sampleRate,
      numberOfFrames: count,
      numberOfChannels: CHANNELS,
      timestamp: Math.round((offset / buffer.sampleRate) * 1_000_000),
      data,
    });
  }
}
