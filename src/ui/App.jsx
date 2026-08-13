import { useCallback, useEffect, useRef, useState } from 'react';
import { player } from '../engine/player.js';
import { defaultProject, makeTextLayer, makeImageLayer, makeVideoLayer } from '../engine/project.js';
import { SCHEMA_DOC } from '../engine/presets.js';
import { drawFrame } from '../engine/renderer.js';
import { ensureDisplayFont } from '../engine/fonts.js';
import { attachVideoElement, pauseAllVideo } from '../engine/videoSync.js';
import { Stage } from './Stage.jsx';
import { Timeline } from './Timeline.jsx';
import { Win } from './Win.jsx';
import { LayersPanel } from './LayersPanel.jsx';
import { PropsPanel } from './PropsPanel.jsx';
import { EffectsPanel } from './EffectsPanel.jsx';

const TABS = [
  { id: 'layers', label: 'Layers' },
  { id: 'props', label: 'Props' },
  { id: 'fx', label: 'Efeitos' },
];

export default function App() {
  const [project, setProject] = useState(defaultProject);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('layers');
  const [toast, setToast] = useState('');
  const fileRef = useRef(null);
  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    player.start();
    setSelectedId(p => p ?? project.layers[0]?.id ?? null);

    // The canvas font must be fetched explicitly; repaint once it lands.
    ensureDisplayFont().then(() => player.invalidate());

    // Video elements must not keep rolling once the transport stops.
    const unsubState = player.onState(p => {
      if (!p.playing) pauseAllVideo(projectRef.current);
    });

    // TEMP PROBE
    {
      const v = attachVideoElement(document.createElement('video'));
      v.addEventListener('loadedmetadata', () => {
        addLayer(makeVideoLayer(v, { name: 'count_up.mp4', start: 0, duration: 5, fit: 1 }));
        player.invalidate();
      }, { once: true });
      v.src = '/dev/count_up_559872.mp4';
    }

    // ?t=1.6 opens the editor parked at that timestamp.
    const t = parseFloat(new URLSearchParams(location.search).get('t'));
    if (Number.isFinite(t)) player.seek(t);

    return () => { unsubState(); player.stop(); };
  }, []);

  const flash = msg => { setToast(msg); setTimeout(() => setToast(''), 1600); };

  const updateLayer = useCallback((id, patch) => {
    setProject(p => ({
      ...p,
      layers: p.layers.map(l => (l.id === id ? { ...l, ...patch } : l)),
    }));
  }, []);

  const addText = () => {
    const layer = makeTextLayer({
      name: `Texto ${project.layers.length + 1}`,
      start: +player.t.toFixed(2),
    });
    setProject(p => ({ ...p, layers: [...p.layers, layer] }));
    setSelectedId(layer.id);
    setTab('props');
  };

  const addLayer = layer => {
    // New media goes underneath existing layers so it never buries your titles.
    setProject(p => ({ ...p, layers: [layer, ...p.layers] }));
    setSelectedId(layer.id);
    setTab('props');
  };

  const onFile = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);

    if (file.type.startsWith('video/')) {
      const video = attachVideoElement(document.createElement('video'));
      video.addEventListener('loadedmetadata', () => {
        addLayer(makeVideoLayer(video, { name: file.name, start: +player.t.toFixed(2) }));
        player.invalidate();
      }, { once: true });
      video.addEventListener('error', () => flash('Não consegui abrir esse vídeo'), { once: true });
      video.src = url;
    } else {
      const img = new Image();
      img.onload = () => addLayer(makeImageLayer(img, { name: file.name, start: +player.t.toFixed(2) }));
      img.onerror = () => flash('Não consegui abrir essa imagem');
      img.src = url;
    }
    e.target.value = '';
  };

  /** Reorder within the draw list. `dir` is -1 for down, +1 for up (towards the front). */
  const moveLayer = (id, dir) => {
    setProject(p => {
      const i = p.layers.findIndex(l => l.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.layers.length) return p;
      const layers = [...p.layers];
      [layers[i], layers[j]] = [layers[j], layers[i]];
      return { ...p, layers };
    });
  };

  const deleteLayer = id => {
    setProject(p => {
      const gone = p.layers.find(l => l.id === id);
      if (gone?.type === 'video' && gone.video) {
        gone.video.pause();
        URL.revokeObjectURL(gone.video.src);
        gone.video.removeAttribute('src');
        gone.video.load();          // frees the decoder instead of leaking it
      }
      const layers = p.layers.filter(l => l.id !== id);
      setSelectedId(cur => (cur === id ? layers[layers.length - 1]?.id ?? null : cur));
      return { ...p, layers };
    });
  };

  const copySchema = async () => {
    try {
      await navigator.clipboard.writeText(SCHEMA_DOC);
      flash('Schema copiado!');
    } catch {
      flash('Falhou — veja o console');
      console.log(SCHEMA_DOC);
    }
  };

  const savePng = async () => {
    // Exporting before the face settles would bake in the fallback.
    // The real video exporter will need this same guard.
    await ensureDisplayFont();
    await document.fonts.ready;
    const cv = document.createElement('canvas');
    cv.width = project.width;
    cv.height = project.height;
    drawFrame(cv.getContext('2d'), project, player.t);
    const a = document.createElement('a');
    a.download = `frame_${player.t.toFixed(2)}s.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
    flash('PNG salvo!');
  };

  const resizeProject = useCallback((width, height) => {
    setProject(p => ({ ...p, width, height }));
  }, []);

  const selected = project.layers.find(l => l.id === selectedId) || null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          <span className="logo-marks">▚▚▚</span>
          FRAGMENTO
        </div>

        <button className="btn" onClick={addText}>+ TEXTO</button>
        <button className="btn" onClick={() => fileRef.current.click()}>+ MÍDIA</button>
        <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={onFile} />

        <div className="topbar-spacer" />

        {toast && <span className="toast">{toast}</span>}
        <button className="btn btn-gold" onClick={copySchema}>▣ SCHEMA</button>
        <button className="btn" onClick={savePng}>▼ PNG</button>
      </header>

      <main className="workspace">
        <Stage project={project} onResize={resizeProject} />

        <aside className="sidebar">
          <Win
            title="Inspector"
            icon="▦"
            right={
              <div className="tabstrip">
                {TABS.map(t => (
                  <button
                    key={t.id}
                    className={`tabbtn${tab === t.id ? ' on' : ''}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            }
            className="sidebar-win"
          >
            {tab === 'layers' && (
              <LayersPanel
                project={project}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onDelete={deleteLayer}
                onMove={moveLayer}
              />
            )}
            {tab === 'props' && <PropsPanel layer={selected} onChange={updateLayer} />}
            {tab === 'fx' && <EffectsPanel layer={selected} onChange={updateLayer} />}
          </Win>
        </aside>
      </main>

      <Timeline
        project={project}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onChange={updateLayer}
      />
    </div>
  );
}
