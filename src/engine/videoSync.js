import { player } from './player.js';

/**
 * Keeps every <video> element aligned with the player's clock.
 *
 * Two regimes, because they have opposite requirements:
 *
 *  - PLAYING: let the element run on its own clock. Writing `currentTime`
 *    every frame would stutter and thrash the decoder, so we only step in
 *    when it has drifted past DRIFT_TOLERANCE and then let it run again.
 *
 *  - PAUSED / SCRUBBING: write `currentTime` directly. Seeking is async, so
 *    the element fires 'seeked' later — that listener repaints the canvas,
 *    otherwise a scrub would leave the previous frame on screen.
 */

const DRIFT_TOLERANCE = 0.08;   // seconds of drift tolerated while playing
const SEEK_EPSILON = 0.01;      // below this, a seek costs more than it fixes

/** Timeline time -> position inside the source file. */
export function sourceTimeAt(layer, t) {
  return (layer.trimStart || 0) + (t - layer.start);
}

export function isLayerActive(layer, t) {
  return t >= layer.start && t <= layer.start + layer.duration;
}

/** Wires an element up so async seeks repaint the preview when parked. */
export function attachVideoElement(video) {
  video.muted = true;          // audio arrives in its own phase; also dodges autoplay blocking
  video.playsInline = true;
  video.preload = 'auto';
  video.addEventListener('seeked', () => {
    if (!player.playing) player.invalidate();
  });
  return video;
}

/**
 * Decides what a single video element should do — pure, so it can be tested
 * without a DOM. `syncVideoLayers` below is the thin part that carries it out.
 *
 * Returns { seekTo: number|null, play: boolean }.
 */
export function videoSyncPlan(layer, t, { playing, currentTime, paused }) {
  if (!isLayerActive(layer, t)) return { seekTo: null, play: false };

  const want = clampToSource(layer, sourceTimeAt(layer, t));
  const drift = Math.abs(currentTime - want);

  if (playing) {
    // Let the element run on its own clock; only step in once it has slipped.
    return { seekTo: drift > DRIFT_TOLERANCE ? want : null, play: true };
  }

  // Parked: land exactly on the frame, but ignore differences too small to see.
  return { seekTo: drift > SEEK_EPSILON ? want : null, play: false };
}

export function syncVideoLayers(project, t) {
  for (const layer of project.layers) {
    if (layer.type !== 'video' || !layer.video) continue;

    const video = layer.video;
    const plan = videoSyncPlan(layer, t, {
      playing: player.playing,
      currentTime: video.currentTime,
      paused: video.paused,
    });

    if (plan.seekTo !== null) video.currentTime = plan.seekTo;

    if (plan.play && video.paused) {
      video.play().catch(() => { /* autoplay blocked; preview keeps stepping frames */ });
    } else if (!plan.play && !video.paused) {
      video.pause();
    }
  }
}

/** Pauses everything — used when the whole project stops. */
export function pauseAllVideo(project) {
  for (const layer of project.layers) {
    if (layer.type === 'video' && layer.video && !layer.video.paused) layer.video.pause();
  }
}

function clampToSource(layer, time) {
  const max = Number.isFinite(layer.sourceDuration) ? layer.sourceDuration : time;
  return Math.max(0, Math.min(time, max));
}
