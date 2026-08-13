import interBlackUrl from '../fonts/InterBlack.ttf';

export const DISPLAY_FAMILY = 'InterBlack';

/**
 * Canvas text does NOT trigger CSS font loading — the browser only fetches an
 * @font-face when a DOM node actually renders with it. A canvas-only face would
 * silently never load and every frame would draw in the fallback.
 * So we load it explicitly and register it on document.fonts.
 */
let pending = null;

export function ensureDisplayFont() {
  if (pending) return pending;

  if (typeof FontFace === 'undefined') {
    pending = Promise.resolve(null);
    return pending;
  }

  const face = new FontFace(DISPLAY_FAMILY, `url(${interBlackUrl})`, { weight: '900' });
  pending = face
    .load()
    .then(loaded => {
      document.fonts.add(loaded);
      return loaded;
    })
    .catch(err => {
      console.warn('[fonts] display font failed, using fallback:', err);
      return null;
    });

  return pending;
}
