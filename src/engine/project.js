import { PRESETS } from './presets.js';
import { DISPLAY_FONT } from './renderer.js';

export const clone = o => JSON.parse(JSON.stringify(o));

/** Composition sizes. Layers are positioned from the centre, so most of a
 *  project survives a resolution swap without being rebuilt. */
export const RESOLUTIONS = [
  { id: '1080p',    label: '1920x1080', w: 1920, h: 1080, note: 'YouTube 16:9' },
  { id: 'vertical', label: '1080x1920', w: 1080, h: 1920, note: 'Reels / Shorts' },
  { id: 'square',   label: '1080x1080', w: 1080, h: 1080, note: 'Feed 1:1' },
  { id: '720p',     label: '1280x720',  w: 1280, h: 720,  note: 'Leve' },
];

let _id = 1;
export const nextId = () => _id++;

export function makeTextLayer(overrides = {}) {
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
    effects: [clone(PRESETS['fade-up'])],
    ...overrides,
  };
}

export function makeImageLayer(img, overrides = {}) {
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
    effects: [clone(PRESETS['blur-in'])],
    ...overrides,
  };
}

export function defaultProject() {
  return {
    width: 1920,
    height: 1080,
    background: '#151021',
    layers: [
      makeTextLayer({
        name: 'Título', start: 0.2, duration: 4.5,
        text: 'POWERED BY THE SUN', size: 150, y: -90,
        color: '#f7efdc',
        effects: [clone(PRESETS['zoom-punch']), clone(PRESETS['fade-out-down'])],
      }),
      makeTextLayer({
        name: 'Subtítulo', start: 0.75, duration: 4.2,
        text: '559.872 km rodados', size: 64, y: 70,
        color: '#f0c04a',
        effects: [
          { ...clone(PRESETS['slide-track']), delay: 0.1 },
          clone(PRESETS['fade-out-down']),
        ],
      }),
      makeTextLayer({
        name: 'Selo', start: 5.0, duration: 3.0,
        text: '100% PIXEL PERFECT', size: 96, y: 0,
        color: '#64c48a',
        effects: [clone(PRESETS['spring-pop']), clone(PRESETS['float-loop'])],
      }),
    ],
  };
}
