/**
 * The "fast preview" toggle — outside React like player/viewport/timeline.
 *
 * Two things feed into whether a frame draws in fast mode (see Stage.jsx):
 *  - `fast`, the manual switch here, which sticks even while paused — for
 *    heavy projects on slow machines.
 *  - `player.playing` itself: blur is stripped automatically during active
 *    playback and restored the instant you pause, so scrubbing to inspect a
 *    frame always shows it in full quality without you having to remember to
 *    flip a switch back.
 */
export type PreviewModeListener = (fast: boolean) => void;

class PreviewMode {
  fast = false;
  private _subs = new Set<PreviewModeListener>();

  subscribe(cb: PreviewModeListener): () => void {
    this._subs.add(cb);
    return () => { this._subs.delete(cb); };
  }

  toggle(): void { this.set(!this.fast); }

  set(v: boolean): void {
    if (v === this.fast) return;
    this.fast = v;
    for (const cb of this._subs) cb(this.fast);
  }
}

export const previewMode = new PreviewMode();
