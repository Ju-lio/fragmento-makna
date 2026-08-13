import { useEffect, useRef } from 'react';
import { player } from '../engine/player.js';
import { viewport } from '../engine/viewport.js';
import { drawFrame } from '../engine/renderer.js';
import { StageBar } from './StageBar.jsx';

/**
 * The canvas viewport.
 *
 * Note what is NOT here: no per-frame React state, and no per-pointer-event
 * React state. The component mounts, subscribes to the player, and paints
 * straight to the canvas. Playing back, scrubbing and panning all re-render
 * exactly nothing.
 */
export function Stage({ project, onResize }) {
  const wrapRef = useRef(null);
  const holderRef = useRef(null);
  const canvasRef = useRef(null);
  const projectRef = useRef(project);

  projectRef.current = project;

  // --- paint loop -------------------------------------------------------
  useEffect(() => {
    const ctx = canvasRef.current.getContext('2d');
    const unsub = player.onFrame(t => drawFrame(ctx, projectRef.current, t));
    player.invalidate();
    return unsub;
  }, []);

  // Any project edit must trigger exactly one repaint.
  useEffect(() => { player.invalidate(); });

  // --- viewport sizing --------------------------------------------------
  useEffect(() => {
    const applyTransform = () => {
      if (holderRef.current) holderRef.current.style.transform = viewport.transform();
    };

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      viewport.setContainer(width, height);
      applyTransform();
    });
    ro.observe(wrapRef.current);

    const unsub = viewport.subscribe(applyTransform);
    applyTransform();

    return () => { ro.disconnect(); unsub(); };
  }, []);

  // Resolution changes resize the canvas, which also clears it.
  useEffect(() => {
    viewport.setContent(project.width, project.height);
    player.invalidate();
  }, [project.width, project.height]);

  // --- pan --------------------------------------------------------------
  const onPointerDown = e => {
    const panButton = e.button === 1 || e.button === 0;
    if (!panButton || !viewport.pannable) return;
    e.preventDefault();

    let lastX = e.clientX;
    let lastY = e.clientY;
    wrapRef.current.classList.add('grabbing');

    const move = ev => {
      viewport.panBy(ev.clientX - lastX, ev.clientY - lastY);
      lastX = ev.clientX;
      lastY = ev.clientY;
      // Direct DOM write — a pan drag costs zero React renders.
      holderRef.current.style.transform = viewport.transform();
    };
    const up = () => {
      wrapRef.current?.classList.remove('grabbing');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  // --- wheel: scroll pans, ctrl+scroll zooms at the cursor ---------------
  useEffect(() => {
    const el = wrapRef.current;
    const onWheel = e => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();

      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0015);
        viewport.setZoom(viewport.zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
      } else if (viewport.pannable) {
        viewport.panBy(-e.deltaX, -e.deltaY);
        holderRef.current.style.transform = viewport.transform();
      }
    };
    // passive:false so preventDefault actually stops the page from zooming.
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // --- keyboard ---------------------------------------------------------
  useEffect(() => {
    const onKey = e => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!(e.ctrlKey || e.metaKey)) return;

      if (e.key === '=' || e.key === '+') { e.preventDefault(); viewport.zoomIn(); }
      else if (e.key === '-') { e.preventDefault(); viewport.zoomOut(); }
      else if (e.key === '0') { e.preventDefault(); viewport.fit(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="stage">
      <div className="stage-viewport" ref={wrapRef} onPointerDown={onPointerDown}>
        <div className="stage-holder" ref={holderRef}>
          <canvas
            ref={canvasRef}
            width={project.width}
            height={project.height}
            className="stage-canvas"
          />
        </div>
      </div>
      <StageBar project={project} onResize={onResize} />
    </div>
  );
}
