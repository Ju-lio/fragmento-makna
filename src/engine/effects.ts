import { EASE, EASE_NAMES } from './easings.ts';
import type { AnimProp, Effect, LayerState, TimeSpan, TimeWindow, Track } from './types.ts';

/**
 * The effect runtime.
 *
 * An effect is DATA, never code:
 *   { name, duration, anchor?, delay?, loop?, tracks: [{ prop, keys, ease }] }
 * `keys` are [normalizedTime 0..1, value] pairs, so one effect works at any duration.
 *
 * Props combine onto a layer's base state by two rules:
 *   MULTIPLIED -> scale, opacity, brightness
 *   ADDED      -> x, y, rotate, blur, letterSpacing
 * This is what lets several effects stack on one layer without fighting.
 */

export const MULT_PROPS: ReadonlySet<AnimProp> = new Set<AnimProp>(['scale', 'opacity', 'brightness']);

export const BASE_STATE = (): LayerState => ({
  x: 0, y: 0, scale: 1, rotate: 0,
  opacity: 1, blur: 0, brightness: 1, letterSpacing: 0,
});

export const VALID_PROPS = Object.keys(BASE_STATE()) as AnimProp[];

/** Value of one track at normalized progress `p` (0..1), clamped at both ends. */
export function sampleTrack(track: Track, p: number): number | null {
  const k = track.keys;
  const first = k?.[0];
  const last = k?.[k.length - 1];
  if (!first || !last) return null;
  if (p <= first[0]) return first[1];
  if (p >= last[0]) return last[1];

  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (!a || !b) continue;
    const [t0, v0] = a;
    const [t1, v1] = b;
    if (p >= t0 && p <= t1) {
      const span = t1 - t0;
      const local = span ? (p - t0) / span : 0;
      const fn = (track.ease && EASE[track.ease]) || EASE.linear;
      return v0 + (v1 - v0) * fn(local);
    }
  }
  return last[1];
}

/**
 * Progress (0..1) of a time window at absolute time `t`, or null when inactive.
 *
 * Recebe `TimeWindow`, não `Effect`: esta conta só olha duration/delay/
 * anchor/loop, nunca `tracks`. `Effect` continua servindo aqui de graça (é um
 * `TimeWindow` mais `name`/`tracks`); `CountUp` também serve, sem precisar
 * fingir um `Effect` com `tracks: []` só pra emprestar a matemática.
 */
export function effectProgress(eff: TimeWindow, layer: TimeSpan, t: number): number | null {
  const dur = eff.duration ?? 1;
  const delay = eff.delay ?? 0;
  const start = eff.anchor === 'end'
    ? layer.start + layer.duration - dur - delay
    : layer.start + delay;

  let p = (t - start) / dur;

  if (eff.loop) {
    if (t < start) return null;
    return p % 1;
  }
  if (p < 0) return eff.anchor === 'end' ? null : 0;
  if (p > 1) return 1;
  return p;
}

/** Full animated state of a layer at time `t`. */
export function resolveState(
  layer: TimeSpan & { x?: number; y?: number; rotate?: number; effects?: Effect[] },
  t: number,
): LayerState {
  const st = BASE_STATE();
  st.x += layer.x || 0;
  st.y += layer.y || 0;
  st.rotate += layer.rotate || 0;

  for (const eff of layer.effects || []) {
    const p = effectProgress(eff, layer, t);
    if (p === null) continue;
    for (const track of eff.tracks || []) {
      const v = sampleTrack(track, p);
      if (v === null || !(track.prop in st)) continue;
      if (MULT_PROPS.has(track.prop)) st[track.prop] *= v;
      else st[track.prop] += v;
    }
  }
  return st;
}

/**
 * Returns a human-readable problem string, or null when the effect is valid.
 *
 * Recebe `unknown` de propósito: a entrada é JSON colado pelo usuário, então
 * o tipo não pode ser assumido — é justamente isto aqui que o estabelece.
 */
export function validateEffect(eff: unknown): string | null {
  if (typeof eff !== 'object' || !eff) return 'Precisa ser um objeto JSON.';
  const candidate = eff as Partial<Effect>;
  if (!Array.isArray(candidate.tracks) || !candidate.tracks.length) return "Faltou o array 'tracks'.";

  for (const tr of candidate.tracks) {
    if (!VALID_PROPS.includes(tr.prop)) {
      return `prop inválida: "${tr.prop}". Use: ${VALID_PROPS.join(', ')}`;
    }
    if (!Array.isArray(tr.keys) || !tr.keys.length) return `track "${tr.prop}" sem keys.`;
    for (const k of tr.keys) {
      if (!Array.isArray(k) || k.length !== 2 || typeof k[0] !== 'number' || typeof k[1] !== 'number') {
        return `key inválida em "${tr.prop}": use [tempo, valor] numéricos.`;
      }
    }
    if (tr.ease && !EASE_NAMES.includes(tr.ease)) return `ease desconhecido: "${tr.ease}"`;
  }
  return null;
}
