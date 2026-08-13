import { PRESETS } from './presets.ts';
import { DISPLAY_FONT } from './renderer.ts';
import type {
  Effect, ImageLayer, LayerPatch, Project, TextLayer, VideoLayer,
} from './types.ts';

export type {
  Effect, ImageLayer, Layer, LayerPatch, Project, TextLayer, VideoLayer,
} from './types.ts';

export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

/** Um preset sempre existe — o índice literal já garante isso em tempo de tipo. */
const preset = (name: keyof typeof PRESETS): Effect => clone(PRESETS[name]);

/** Composition sizes. Layers are positioned from the centre, so most of a
 *  project survives a resolution swap without being rebuilt. */
export interface Resolution {
  id: string;
  label: string;
  w: number;
  h: number;
  note: string;
}

export const RESOLUTIONS: Resolution[] = [
  { id: '1080p',    label: '1920x1080', w: 1920, h: 1080, note: 'YouTube 16:9' },
  { id: 'vertical', label: '1080x1920', w: 1080, h: 1920, note: 'Reels / Shorts' },
  { id: 'square',   label: '1080x1080', w: 1080, h: 1080, note: 'Feed 1:1' },
  { id: '720p',     label: '1280x720',  w: 1280, h: 720,  note: 'Leve' },
];

let _id = 1;
export const nextId = () => _id++;

export function makeTextLayer(overrides: Partial<TextLayer> = {}): TextLayer {
  return {
    id: nextId(),
    type: 'text',
    name: 'Texto',
    start: 0,
    duration: 3,
    text: 'NOVO TEXTO',
    size: 110,
    color: '#f7efdc',
    font: DISPLAY_FONT,
    x: 0,
    y: 0,
    effects: [preset('fade-up')],
    ...overrides,
  };
}

/**
 * Longest a layer can run given how much source material is left after the trim.
 *
 * Recebe `TrimTarget`, não `VideoLayer`: texto não tem material de origem e o
 * limite dele é infinito, então a mesma conta serve pros três tipos de layer.
 */
export function maxDuration(layer: TrimTarget): number {
  if (!Number.isFinite(layer.sourceDuration)) return Infinity;
  return Math.max(MIN_CLIP, (layer.sourceDuration as number) - (layer.trimStart || 0));
}

export const MIN_CLIP = 0.1;

/**
 * Dragging a clip's right edge just changes how long it plays.
 * Returns a patch, or null when the drag is a no-op.
 */
export function trimRight(layer: TrimTarget, deltaSec: number): LayerPatch | null {
  const wanted = layer.duration + deltaSec;
  const duration = Math.max(MIN_CLIP, Math.min(wanted, maxDuration(layer)));
  return duration === layer.duration ? null : { duration: round(duration) };
}

/**
 * Dragging the left edge moves the clip AND the point it starts reading from,
 * so the footage under the cursor stays put instead of sliding.
 */
export function trimLeft(layer: TrimTarget, deltaSec: number): LayerPatch | null {
  const trimStart = layer.trimStart || 0;
  let d = deltaSec;

  // Can't read before the start of the source...
  if (Number.isFinite(layer.sourceDuration)) d = Math.max(d, -trimStart);
  // ...can't push the clip off the front of the timeline...
  d = Math.max(d, -layer.start);
  // ...and can't shrink past the minimum length.
  d = Math.min(d, layer.duration - MIN_CLIP);

  if (Math.abs(d) < 1e-4) return null;

  const patch: LayerPatch = {
    start: round(layer.start + d),
    duration: round(layer.duration - d),
  };
  if (Number.isFinite(layer.sourceDuration)) patch.trimStart = round(trimStart + d);
  return patch;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** O recorte de uma layer que o corte de bordas realmente lê. */
export interface TrimTarget {
  start: number;
  duration: number;
  trimStart?: number;
  sourceDuration?: number;
}

export function makeVideoLayer(
  video: HTMLVideoElement,
  mediaId: string,
  overrides: Partial<VideoLayer> = {},
): VideoLayer {
  const sourceDuration = video.duration;
  return {
    id: nextId(),
    type: 'video',
    name: 'Vídeo',
    start: 0,
    duration: Math.min(sourceDuration, 5),
    trimStart: 0,
    sourceDuration,
    video,
    mediaId,
    x: 0,
    y: 0,
    fit: 1,
    effects: [],
    ...overrides,
  };
}

export function makeImageLayer(
  img: HTMLImageElement,
  mediaId: string,
  overrides: Partial<ImageLayer> = {},
): ImageLayer {
  return {
    id: nextId(),
    type: 'image',
    name: 'Imagem',
    start: 0,
    duration: 3,
    x: 0,
    y: 0,
    fit: 0.8,
    img,
    mediaId,
    effects: [preset('blur-in')],
    ...overrides,
  };
}

export function defaultProject(): Project {
  return {
    width: 1920,
    height: 1080,
    /** Taxa de quadros da composição. Tudo se alinha nela: o preview, o cache
     *  e (futuramente) o export — assim um frame é sempre o mesmo frame. */
    fps: 30,
    background: '#151021',
    layers: [
      makeTextLayer({
        name: 'Título', start: 0.2, duration: 4.5,
        text: 'POWERED BY THE SUN', size: 150, y: -90,
        color: '#f7efdc',
        effects: [preset('zoom-punch'), preset('fade-out-down')],
      }),
      makeTextLayer({
        name: 'Subtítulo', start: 0.75, duration: 4.2,
        text: '559.872 km rodados', size: 64, y: 70,
        color: '#f0c04a',
        effects: [
          { ...preset('slide-track'), delay: 0.1 },
          preset('fade-out-down'),
        ],
      }),
      makeTextLayer({
        name: 'Selo', start: 5.0, duration: 3.0,
        text: '100% PIXEL PERFECT', size: 96, y: 0,
        color: '#64c48a',
        effects: [preset('spring-pop'), preset('float-loop')],
      }),
    ],
  };
}
