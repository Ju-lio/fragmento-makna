import { useEffect, useRef, useState } from 'react';
import { player } from '../engine/player.js';
import { trimLeft, trimRight } from '../engine/project.js';

/**
 * Timeline + transport.
 *
 * The playhead bar and timecode are updated by writing to refs inside the
 * player's frame callback — never through setState — so dragging the playhead
 * across a 60s project costs zero React renders.
 */
export function Timeline({ project, selectedId, onSelect, onChange }) {
  const headRef = useRef(null);
  const tcRef = useRef(null);
  const rulerRef = useRef(null);
  const [playing, setPlaying] = useState(player.playing);
  const [duration, setDuration] = useState(player.duration);

  useEffect(() => {
    const unsubFrame = player.onFrame(t => {
      const pct = (t / player.duration) * 100;
      if (headRef.current) headRef.current.style.left = `${pct}%`;
      if (tcRef.current) tcRef.current.textContent = fmt(t);
    });
    const unsubState = player.onState(p => {
      setPlaying(p.playing);
      setDuration(p.duration);
    });
    return () => { unsubFrame(); unsubState(); };
  }, []);

  useEffect(() => {
    const onKey = e => {
      const tag = e.target.tagName;
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        player.toggle();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const scrub = e => {
    const r = rulerRef.current.getBoundingClientRect();
    player.seek(((e.clientX - r.left) / r.width) * player.duration);
  };

  const startScrub = e => {
    scrub(e);
    const move = ev => scrub(ev);
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  /** Drag an edge to trim. The maths lives in project.js so it can be tested. */
  const startTrim = (e, layer, edge) => {
    e.preventDefault();
    e.stopPropagation();          // don't also start a move drag
    onSelect(layer.id);

    const rect = rulerRef.current.getBoundingClientRect();
    const startX = e.clientX;
    const orig = { ...layer };

    const move = ev => {
      const delta = ((ev.clientX - startX) / rect.width) * player.duration;
      const patch = edge === 'left' ? trimLeft(orig, delta) : trimRight(orig, delta);
      if (patch) onChange(layer.id, patch);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const startClipDrag = (e, layer) => {
    e.preventDefault();
    onSelect(layer.id);
    const rect = rulerRef.current.getBoundingClientRect();
    const startX = e.clientX;
    const orig = layer.start;
    const move = ev => {
      const dx = ((ev.clientX - startX) / rect.width) * player.duration;
      const next = Math.max(0, Math.min(player.duration - layer.duration, orig + dx));
      onChange(layer.id, { start: +next.toFixed(3) });
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const step = duration > 20 ? 5 : duration > 10 ? 2 : 1;
  const ticks = [];
  for (let s = 0; s <= duration; s += step) ticks.push(s);

  return (
    <div className="timeline">
      <div className="transport">
        <button className={`btn btn-gold${playing ? ' on' : ''}`} onClick={() => player.toggle()}>
          {playing ? '❚❚ PAUSE' : '▶ PLAY'}
        </button>
        <button className="btn" onClick={() => player.seek(0)}>|◀ INÍCIO</button>

        <div className="tc">
          <span ref={tcRef}>{fmt(player.t)}</span>
          <span className="tc-sep">/</span>
          <span>{fmt(duration)}</span>
        </div>

        <div className="transport-spacer" />

        <label className="field-label" style={{ margin: 0 }}>Duração</label>
        <input
          className="inp"
          style={{ width: 62 }}
          type="number"
          min="1"
          step="0.5"
          value={duration}
          onChange={e => player.setDuration(parseFloat(e.target.value) || 8)}
        />
      </div>

      <div className="tl-wrap">
        <div className="ruler" ref={rulerRef} onPointerDown={startScrub}>
          {ticks.map(s => (
            <div key={s} className="tick" style={{ left: `${(s / duration) * 100}%` }}>
              <span className="tick-lab">{s}s</span>
            </div>
          ))}
        </div>

        <div className="tracks">
          {project.layers.map(layer => (
            <div className="track" key={layer.id}>
              <div
                className={
                  'clip' +
                  (layer.type === 'image' ? ' clip-img' : '') +
                  (layer.type === 'video' ? ' clip-video' : '') +
                  (layer.id === selectedId ? ' clip-sel' : '')
                }
                style={{
                  left: `${(layer.start / duration) * 100}%`,
                  width: `${(layer.duration / duration) * 100}%`,
                }}
                onPointerDown={e => startClipDrag(e, layer)}
                title={layer.name}
              >
                <span
                  className="clip-handle clip-handle-l"
                  onPointerDown={e => startTrim(e, layer, 'left')}
                />
                <span className="clip-name">{layer.name}</span>
                <span
                  className="clip-handle clip-handle-r"
                  onPointerDown={e => startTrim(e, layer, 'right')}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="playhead" ref={headRef} />
      </div>
    </div>
  );
}

const fmt = t => `${t.toFixed(2)}s`;
