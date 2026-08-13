/**
 * Preview viewport — zoom, fit and pan.
 *
 * Lives outside React for the same reason the player does: panning fires
 * pointer events at screen rate, and each one only needs to update a single
 * CSS transform. Subscribers get notified for the parts React does own
 * (the zoom readout), while the drag itself writes straight to the DOM.
 *
 * Coordinate model: `panX/panY` is the on-screen position of the content's
 * top-left corner, in container pixels, already multiplied by zoom.
 */

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

class Viewport {
  constructor() {
    this.contentW = 1920;
    this.contentH = 1080;
    this.containerW = 0;
    this.containerH = 0;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    /** When true, zoom follows the container size instead of the user. */
    this.fitMode = true;

    this._subs = new Set();
  }

  subscribe(cb) {
    this._subs.add(cb);
    return () => this._subs.delete(cb);
  }

  _emit() { for (const cb of this._subs) cb(this); }

  /** Zoom that makes the whole composition fit, with a little breathing room. */
  fitZoom() {
    if (!this.containerW || !this.containerH) return 1;
    const pad = 24;
    const z = Math.min(
      (this.containerW - pad) / this.contentW,
      (this.containerH - pad) / this.contentH,
    );
    return clamp(z, MIN_ZOOM, MAX_ZOOM);
  }

  setContent(w, h) {
    if (w === this.contentW && h === this.contentH) return;
    this.contentW = w;
    this.contentH = h;
    if (this.fitMode) this.zoom = this.fitZoom();
    this._clampPan();
    this._emit();
  }

  setContainer(w, h) {
    if (w === this.containerW && h === this.containerH) return;
    this.containerW = w;
    this.containerH = h;
    if (this.fitMode) this.zoom = this.fitZoom();
    this._clampPan();
    this._emit();
  }

  fit() {
    this.fitMode = true;
    this.zoom = this.fitZoom();
    this._clampPan();
    this._emit();
  }

  /** Set zoom, optionally keeping the point under (ax, ay) visually pinned. */
  setZoom(z, ax = this.containerW / 2, ay = this.containerH / 2) {
    const next = clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (next === this.zoom) return;

    // Content-space point currently under the anchor, kept fixed across the zoom.
    const cx = (ax - this.panX) / this.zoom;
    const cy = (ay - this.panY) / this.zoom;

    this.zoom = next;
    this.fitMode = false;
    this.panX = ax - cx * next;
    this.panY = ay - cy * next;

    this._clampPan();
    this._emit();
  }

  zoomIn(ax, ay) { this.setZoom(this._nextStep(1), ax, ay); }
  zoomOut(ax, ay) { this.setZoom(this._nextStep(-1), ax, ay); }

  _nextStep(dir) {
    if (dir > 0) return ZOOM_STEPS.find(z => z > this.zoom + 1e-6) ?? MAX_ZOOM;
    return [...ZOOM_STEPS].reverse().find(z => z < this.zoom - 1e-6) ?? MIN_ZOOM;
  }

  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.fitMode = false;
    this._clampPan();
    // No _emit: panning changes nothing React renders. The drag handler writes
    // the transform directly, which keeps a drag at zero re-renders.
  }

  /** True when the content is larger than the viewport on either axis. */
  get pannable() {
    return this.contentW * this.zoom > this.containerW + 1
        || this.contentH * this.zoom > this.containerH + 1;
  }

  /** Centres the content when it fits, clamps it to the edges when it doesn't. */
  _clampPan() {
    const w = this.contentW * this.zoom;
    const h = this.contentH * this.zoom;

    this.panX = w <= this.containerW
      ? (this.containerW - w) / 2
      : clamp(this.panX, this.containerW - w, 0);

    this.panY = h <= this.containerH
      ? (this.containerH - h) / 2
      : clamp(this.panY, this.containerH - h, 0);
  }

  transform() {
    return `translate(${this.panX.toFixed(2)}px, ${this.panY.toFixed(2)}px) scale(${this.zoom})`;
  }

  /** Container-relative screen point -> composition pixel. Needed by the
   *  eyedropper and the transform gizmo later on. */
  screenToContent(sx, sy) {
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom,
    };
  }
}

export const viewport = new Viewport();
