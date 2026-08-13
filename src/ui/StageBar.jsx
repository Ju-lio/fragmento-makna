import { useEffect, useState } from 'react';
import { viewport } from '../engine/viewport.js';
import { RESOLUTIONS } from '../engine/project.js';

/** Footer strip under the preview: composition size on the left, zoom on the right. */
export function StageBar({ project, onResize }) {
  const [zoom, setZoom] = useState(viewport.zoom);
  const [fitMode, setFitMode] = useState(viewport.fitMode);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    return viewport.subscribe(v => {
      setZoom(v.zoom);
      setFitMode(v.fitMode);
    });
  }, []);

  const current = RESOLUTIONS.find(r => r.w === project.width && r.h === project.height);

  const pickResolution = e => {
    const val = e.target.value;
    if (val === 'custom') { setCustom(true); return; }
    const r = RESOLUTIONS.find(x => x.id === val);
    if (r) { setCustom(false); onResize(r.w, r.h); }
  };

  return (
    <div className="stagebar">
      <span className="field-label" style={{ margin: 0 }}>Formato</span>

      <select
        className="inp stagebar-select"
        value={custom || !current ? 'custom' : current.id}
        onChange={pickResolution}
      >
        {RESOLUTIONS.map(r => (
          <option key={r.id} value={r.id}>{r.label} — {r.note}</option>
        ))}
        <option value="custom">Custom</option>
      </select>

      {(custom || !current) && (
        <span className="stagebar-custom">
          <input
            className="inp"
            type="number"
            min="16"
            step="2"
            value={project.width}
            onChange={e => onResize(clampDim(e.target.value), project.height)}
          />
          <span className="stagebar-x">x</span>
          <input
            className="inp"
            type="number"
            min="16"
            step="2"
            value={project.height}
            onChange={e => onResize(project.width, clampDim(e.target.value))}
          />
        </span>
      )}

      <div className="stagebar-spacer" />

      <button className="btn btn-sm" onClick={() => viewport.zoomOut()} title="Ctrl -">−</button>
      <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
      <button className="btn btn-sm" onClick={() => viewport.zoomIn()} title="Ctrl +">+</button>
      <button
        className={`btn btn-sm${fitMode ? ' on' : ''}`}
        onClick={() => viewport.fit()}
        title="Ctrl 0"
      >
        FIT
      </button>
      <button className="btn btn-sm" onClick={() => viewport.setZoom(1)}>100%</button>
    </div>
  );
}

const clampDim = v => Math.max(16, Math.min(7680, parseInt(v, 10) || 16));
