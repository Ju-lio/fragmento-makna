/**
 * Envelopes prontos, um por arquivo. Fora do React como o resto da engine.
 *
 * O custo aqui é a **decodificação**, não o desenho: um MP3 de 3 minutos vira
 * ~30 MB de PCM e leva um tempo perceptível. Por isso cada `mediaId` é
 * decodificado uma vez e o resultado fica; o PCM é descartado logo em seguida e
 * só o envelope sobrevive (400x menor — ver `waveform.ts`).
 *
 * Não persiste em IndexedDB de propósito, por enquanto: recalcular na abertura
 * custa alguns décimos por arquivo e não bloqueia nada, enquanto um cache em
 * disco precisaria de invalidação própria. É otimização, e otimização depois.
 *
 * Quem observa recebe um aviso quando um envelope fica pronto — a timeline não
 * tem como saber sozinha, e sem isso a onda só apareceria no próximo render que
 * acontecesse por acaso.
 */

import { computePeaks, PEAKS_PER_SECOND } from './waveform.ts';
import type { Peaks } from './waveform.ts';

/** De onde vêm os bytes. Injetado pra este módulo não conhecer o IndexedDB. */
export type BlobResolver = (mediaId: string) => Promise<Blob | null>;

export type WaveformListener = (mediaId: string) => void;

const peaks = new Map<string, Peaks>();
/** Em voo: evita que três clipes do mesmo arquivo disparem três decodificações. */
const pending = new Map<string, Promise<void>>();
/** Quem falhou. Sem isto, um arquivo sem trilha seria tentado a cada render. */
const failed = new Set<string>();

const subs = new Set<WaveformListener>();

export function subscribe(cb: WaveformListener): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

/** O envelope já pronto, ou `null` — nunca espera. */
export function peaksFor(mediaId: string): Peaks | null {
  return peaks.get(mediaId) ?? null;
}

/**
 * Garante que o envelope deste arquivo esteja a caminho.
 *
 * Chamável a cada render sem medo: já pronto, em voo ou já falhado, sai na
 * hora. É o que permite o componente simplesmente pedir e desenhar quando
 * chegar, sem orquestrar nada.
 */
export function ensurePeaks(mediaId: string, getBlob: BlobResolver): Peaks | null {
  const ready = peaks.get(mediaId);
  if (ready) return ready;
  if (pending.has(mediaId) || failed.has(mediaId)) return null;

  pending.set(mediaId, decode(mediaId, getBlob));
  return null;
}

async function decode(mediaId: string, getBlob: BlobResolver): Promise<void> {
  try {
    const blob = await getBlob(mediaId);
    if (!blob) throw new Error('mídia ausente');

    /**
     * Um `OfflineAudioContext` mínimo só pra emprestar o `decodeAudioData`.
     *
     * Um `AudioContext` de verdade abriria o hardware de som e ficaria
     * suspenso esperando gesto do usuário — pra decodificar bytes, nada disso é
     * necessário. O tamanho declarado é irrelevante: só o decodificador é usado.
     */
    const ctx = new OfflineAudioContext(1, 1, 48_000);
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());

    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

    peaks.set(mediaId, computePeaks(channels, buffer.sampleRate, PEAKS_PER_SECOND));
    for (const cb of subs) cb(mediaId);
  } catch {
    // Arquivo sem trilha de áudio, ou codec que este navegador não abre. Marcar
    // é o que impede a tentativa de se repetir a cada quadro.
    failed.add(mediaId);
  } finally {
    pending.delete(mediaId);
  }
}

/** Esquece tudo — usado ao trocar de projeto, junto com as URLs. */
export function clearPeaks(): void {
  peaks.clear();
  failed.clear();
}
