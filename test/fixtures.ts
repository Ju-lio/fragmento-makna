/**
 * Construtores de teste.
 *
 * Existem para que os testes descrevam só o que estão testando: um teste sobre
 * assinatura de cache não deveria precisar montar uma layer de vídeo inteira,
 * campo por campo, pra chegar no `trimStart`.
 *
 * Os elementos de mídia são falsos e propositalmente mínimos — a engine lê
 * `src`, `currentTime`, `seeking` e `readyState`, e nada mais. O cast pro tipo
 * do DOM fica concentrado aqui, num lugar só, em vez de espalhado por nove
 * arquivos de teste.
 */

import type {
  AudioLayer, Effect, ImageLayer, Layer, Project, TextLayer, VideoLayer,
} from '../src/engine/types.ts';

/** ImageBitmap falso: os testes só precisam saber se foi liberado. */
export interface FakeBitmap {
  closed: boolean;
  close(): void;
}

export function fakeBitmap(): ImageBitmap & FakeBitmap {
  const b: FakeBitmap = {
    closed: false,
    close() { b.closed = true; },
  };
  return b as ImageBitmap & FakeBitmap;
}

/** Só o que `previewBusyState` de fato lê de um `<video>`. */
export interface FakeVideoInit {
  src?: string;
  currentTime?: number;
  paused?: boolean;
  seeking?: boolean;
  readyState?: number;
}

export function fakeVideo(init: FakeVideoInit = {}): HTMLVideoElement {
  const v = {
    src: 'blob:fake',
    currentTime: 0,
    paused: true,
    seeking: false,
    readyState: 4,
    playbackRate: 1,
    play() { v.paused = false; return Promise.resolve(); },
    pause() { v.paused = true; },
    ...init,
  };
  return v as unknown as HTMLVideoElement;
}

export function fakeImage(src = 'blob:fake-img'): HTMLImageElement {
  return { src, width: 100, height: 100 } as unknown as HTMLImageElement;
}

/** Um efeito válido a partir só do que o teste se importa. */
export const effect = (over: Partial<Effect> = {}): Effect => ({ tracks: [], ...over });

export function textLayer(over: Partial<TextLayer> = {}): TextLayer {
  return {
    id: 1, type: 'text', name: 'Texto',
    start: 0, duration: 4, x: 0, y: 0, track: 0, effects: [],
    text: 'OI', size: 100, color: '#fff', font: 'X',
    ...over,
  };
}

export function videoLayer(over: Partial<VideoLayer> = {}): VideoLayer {
  return {
    id: 2, type: 'video', name: 'Vídeo',
    start: 0, duration: 4, x: 0, y: 0, track: 0, effects: [], fit: 1,
    trimStart: 0, sourceDuration: 10,
    video: fakeVideo(), mediaId: 'media-video',
    volume: 1, mute: false,
    ...over,
  };
}

export function fakeAudio(init: FakeVideoInit = {}): HTMLAudioElement {
  return fakeVideo(init) as unknown as HTMLAudioElement;
}

export function audioLayer(over: Partial<AudioLayer> = {}): AudioLayer {
  return {
    id: 4, type: 'audio', name: 'Áudio',
    start: 0, duration: 4, x: 0, y: 0, track: 0, effects: [],
    trimStart: 0, sourceDuration: 30,
    audio: fakeAudio(), mediaId: 'media-audio',
    volume: 1, mute: false,
    ...over,
  };
}

export function imageLayer(over: Partial<ImageLayer> = {}): ImageLayer {
  return {
    id: 3, type: 'image', name: 'Imagem',
    start: 0, duration: 4, x: 0, y: 0, track: 0, effects: [], fit: 0.8,
    img: fakeImage(), mediaId: 'media-img',
    ...over,
  };
}

export function project(layers: Layer[], over: Partial<Project> = {}): Project {
  return {
    width: 1920, height: 1080, fps: 30, background: '#000',
    layers,
    ...over,
  };
}
