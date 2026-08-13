import { EASE, EASE_NAMES } from './easings.js';

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

export const MULT_PROPS = new Set(['scale', 'opacity', 'brightness']);

export const BASE_STATE = () => ({
  x: 0, y: 0, scale: 1, rotate: 0,
  opacity: 1, blur: 0, brightness: 1, letterSpacing: 0,
});

export const VALID_PROPS = Object.keys(BASE_STATE());

/** Value of one track at normalized progress `p` (0..1), clamped at both ends. */
export function sampleTrack(track, p) {
  const k = track.keys;
  if (!k || !k.length) return null;
  if (p <= k[0][0]) return k[0][1];
  if (p >= k[k.length - 1][0]) return k[k.length - 1][1];

  for (let i = 0; i < k.length - 1; i++) {
    const [t0, v0] = k[i];
    const [t1, v1] = k[i + 1];
    if (p >= t0 && p <= t1) {
      const span = t1 - t0;
      const local = span ? (p - t0) / span : 0;
      const fn = EASE[track.ease] || EASE.linear;
      return v0 + (v1 - v0) * fn(local);
    }
  }
  return k[k.length - 1][1];
}

/** Progress (0..1) of an effect at absolute time `t`, or null when inactive. */
export function effectProgress(eff, layer, t) {
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
export function resolveState(layer, t) {
  const st = BASE_STATE();
  st.x += layer.x || 0;
  st.y += layer.y || 0;

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

/** Returns a human-readable problem string, or null when the effect is valid. */
export function validateEffect(eff) {
  if (typeof eff !== 'object' || !eff) return 'Precisa ser um objeto JSON.';
  if (!Array.isArray(eff.tracks) || !eff.tracks.length) return "Faltou o array 'tracks'.";

  for (const tr of eff.tracks) {
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
