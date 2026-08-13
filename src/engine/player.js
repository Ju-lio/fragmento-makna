/**
 * Playback clock — deliberately OUTSIDE React.
 *
 * Performance contract:
 *  1. One single rAF loop for the whole app, never one per component.
 *  2. The playhead is NOT React state. Per-frame consumers (canvas, playhead
 *     bar, timecode) subscribe here and write straight to the DOM/canvas, so
 *     scrubbing and playback cause zero React re-renders.
 *  3. When paused and nothing changed, we skip the frame entirely — an idle
 *     editor burns no CPU instead of redrawing 60x a second forever.
 */
class Player {
  constructor() {
    this.t = 0;
    this.duration = 8;
    this.playing = false;
    this.loopPlayback = true;

    this._frameSubs = new Set();  // per-frame, hot path: (t) => void
    this._stateSubs = new Set();  // coarse (play/pause), safe for React
    this._dirty = true;
    this._last = 0;
    this._raf = null;
  }

  /** Per-frame subscription. Returns an unsubscribe fn. */
  onFrame(cb) {
    this._frameSubs.add(cb);
    this._dirty = true;
    return () => this._frameSubs.delete(cb);
  }

  /** Coarse state subscription (play/pause/duration) — safe to drive React. */
  onState(cb) {
    this._stateSubs.add(cb);
    return () => this._stateSubs.delete(cb);
  }

  /** Force a repaint on the next frame (call after editing the project). */
  invalidate() { this._dirty = true; }

  seek(t) {
    this.t = Math.max(0, Math.min(this.duration, t));
    this._dirty = true;
  }

  setDuration(d) {
    this.duration = Math.max(0.5, d);
    if (this.t > this.duration) this.t = this.duration;
    this._dirty = true;
    this._emitState();
  }

  play() {
    if (this.playing) return;
    if (this.t >= this.duration) this.t = 0;
    this.playing = true;
    this._last = performance.now();
    this._emitState();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._dirty = true;
    this._emitState();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  _emitState() { for (const cb of this._stateSubs) cb(this); }

  start() {
    if (this._raf !== null) return;
    const tick = now => {
      this._raf = requestAnimationFrame(tick);

      if (this.playing) {
        const dt = Math.min((now - this._last) / 1000, 0.25); // clamp tab-switch jumps
        this._last = now;
        this.t += dt;
        if (this.t >= this.duration) {
          if (this.loopPlayback) this.t = 0;
          else { this.t = this.duration; this.pause(); }
        }
        this._dirty = true;
      }

      if (!this._dirty) return;   // idle: nothing to paint, spend nothing
      this._dirty = false;
      for (const cb of this._frameSubs) cb(this.t);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf !== null) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
}

export const player = new Player();
