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
export const MIN_ZOOM = ZOOM_STEPS[0] as number;
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Quanto do contêiner o canvas ocupa no fit. O resto é margem — ver `fitZoom`. */
export const FIT_MARGIN = 0.88;

/**
 * How many physical pixels the canvas backing store should actually have,
 * relative to the composition's native resolution — the fix for "video only
 * lags when it's tiny on a laptop screen". A CSS `transform: scale()` shrinks
 * what you SEE, but every `drawImage`/blur/fillText still costs full native
 * resolution unless the backing store itself is smaller. This computes that
 * smaller size from how large the canvas actually appears on screen, so a
 * preview at 25% zoom does roughly 1/16th the pixel work of one at 100% —
 * without changing anything the user can perceive, since you can't see
 * detail you're not displaying.
 *
 * Scale is allowed above 1 so zooming in past 100% to inspect fine text
 * still sharpens up, capped at MAX_RENDER_SCALE so that isn't unbounded.
 */
const MIN_RENDER_SCALE = 0.15;
const MAX_RENDER_SCALE = 2;
const MAX_DPR = 2;   // beyond this, more physical pixels buys nothing visible

export function renderScale(zoom: number, dpr: number = 1): number {
  return clamp(zoom * Math.min(dpr, MAX_DPR), MIN_RENDER_SCALE, MAX_RENDER_SCALE);
}

export type ViewportListener = (viewport: Viewport) => void;

export interface Point { x: number; y: number }

class Viewport {
  contentW = 1920;
  contentH = 1080;
  containerW = 0;
  containerH = 0;

  zoom = 1;
  panX = 0;
  panY = 0;

  /** When true, zoom follows the container size instead of the user. */
  fitMode = true;

  private _subs = new Set<ViewportListener>();

  subscribe(cb: ViewportListener): () => void {
    this._subs.add(cb);
    return () => { this._subs.delete(cb); };
  }

  private _emit(): void { for (const cb of this._subs) cb(this); }

  /**
   * Zoom que faz a composição inteira caber, com margem em volta.
   *
   * A margem é uma FRAÇÃO, não os 24px fixos de antes, e a diferença tem
   * consequência prática: o gizmo desenha as alças nas quinas da layer, e uma
   * layer posicionada meio pra fora da composição tinha as alças caindo além da
   * borda do palco — onde o `overflow: hidden` do viewport as recorta e elas
   * simplesmente param de responder. Com margem proporcional sobra área
   * clicável em volta do canvas, e o resto se alcança com zoom.
   */
  fitZoom(): number {
    if (!this.containerW || !this.containerH) return 1;
    const z = Math.min(
      (this.containerW * FIT_MARGIN) / this.contentW,
      (this.containerH * FIT_MARGIN) / this.contentH,
    );
    return clamp(z, MIN_ZOOM, MAX_ZOOM);
  }

  setContent(w: number, h: number): void {
    if (w === this.contentW && h === this.contentH) return;
    this.contentW = w;
    this.contentH = h;
    if (this.fitMode) this.zoom = this.fitZoom();
    this._clampPan();
    this._emit();
  }

  setContainer(w: number, h: number): void {
    if (w === this.containerW && h === this.containerH) return;
    this.containerW = w;
    this.containerH = h;
    if (this.fitMode) this.zoom = this.fitZoom();
    this._clampPan();
    this._emit();
  }

  fit(): void {
    this.fitMode = true;
    this.zoom = this.fitZoom();
    this._clampPan();
    this._emit();
  }

  /** Set zoom, optionally keeping the point under (ax, ay) visually pinned. */
  setZoom(z: number, ax: number = this.containerW / 2, ay: number = this.containerH / 2): void {
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

  zoomIn(ax?: number, ay?: number): void { this.setZoom(this._nextStep(1), ax, ay); }
  zoomOut(ax?: number, ay?: number): void { this.setZoom(this._nextStep(-1), ax, ay); }

  private _nextStep(dir: number): number {
    if (dir > 0) return ZOOM_STEPS.find(z => z > this.zoom + 1e-6) ?? MAX_ZOOM;
    return [...ZOOM_STEPS].reverse().find(z => z < this.zoom - 1e-6) ?? MIN_ZOOM;
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
    this.fitMode = false;
    this._clampPan();
    // No _emit: panning changes nothing React renders. The drag handler writes
    // the transform directly, which keeps a drag at zero re-renders.
  }

  /** True when the content is larger than the viewport on either axis. */
  get pannable(): boolean {
    return this.contentW * this.zoom > this.containerW + 1
        || this.contentH * this.zoom > this.containerH + 1;
  }

  /** Centres the content when it fits, clamps it to the edges when it doesn't. */
  private _clampPan(): void {
    const w = this.contentW * this.zoom;
    const h = this.contentH * this.zoom;

    this.panX = w <= this.containerW
      ? (this.containerW - w) / 2
      : clamp(this.panX, this.containerW - w, 0);

    this.panY = h <= this.containerH
      ? (this.containerH - h) / 2
      : clamp(this.panY, this.containerH - h, 0);
  }

  transform(): string {
    return `translate(${this.panX.toFixed(2)}px, ${this.panY.toFixed(2)}px) scale(${this.zoom})`;
  }

  /** Container-relative screen point -> composition pixel. Needed by the
   *  eyedropper and the transform gizmo later on. */
  screenToContent(sx: number, sy: number): Point {
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom,
    };
  }
}

export const viewport = new Viewport();
export type { Viewport };
