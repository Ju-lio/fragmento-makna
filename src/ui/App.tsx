import React, { useCallback, useEffect, useRef, useState } from 'react';
import { player } from '../engine/player.ts';
import { defaultProject, makeTextLayer, makeImageLayer, makeVideoLayer } from '../engine/project.ts';
import { moveItem } from '../engine/trackDrag.ts';
import type { Layer, LayerPatch } from '../engine/types.ts';
import { SCHEMA_DOC } from '../engine/presets.ts';
import { drawFrame } from '../engine/renderer.ts';
import { ensureDisplayFont } from '../engine/fonts.ts';
import { attachVideoElement, pauseAllVideo } from '../engine/videoSync.ts';
import { Stage } from './Stage.tsx';
import { Timeline } from './Timeline.tsx';
import { Win } from './Win.tsx';
import { LayersPanel } from './LayersPanel.tsx';
import { PropsPanel } from './PropsPanel.tsx';
import { EffectsPanel } from './EffectsPanel.tsx';

type TabId = 'layers' | 'props' | 'fx';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'layers', label: 'Layers' },
  { id: 'props', label: 'Props' },
  { id: 'fx', label: 'Efeitos' },
];

export default function App() {
  const [project, setProject] = useState(defaultProject);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tab, setTab] = useState<TabId>('layers');
  const [toast, setToast] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
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

    // ?t=1.6 opens the editor parked at that timestamp.
    const t = parseFloat(new URLSearchParams(location.search).get('t') ?? '');
    if (Number.isFinite(t)) player.seek(t);

    return () => { unsubState(); player.stop(); };
  }, []);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 1600); };

  const updateLayer = useCallback((id: number, patch: LayerPatch) => {
    setProject(p => ({
      ...p,
      // O cast é o preço de um patch que atende os três tipos de layer: o
      // spread preserva o `type`, mas o compilador não consegue provar isso
      // sozinho sobre uma união.
      layers: p.layers.map(l => (l.id === id ? { ...l, ...patch } as Layer : l)),
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

  const addLayer = (layer: Layer) => {
    // New media goes underneath existing layers so it never buries your titles.
    setProject(p => ({ ...p, layers: [layer, ...p.layers] }));
    setSelectedId(layer.id);
    setTab('props');
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
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

  /**
   * Reposiciona uma layer na ordem de desenho (0 = fundo, último = frente).
   *
   * Recebe o destino absoluto, não uma direção: quem chama é o arrasto da
   * timeline, que já sabe em qual faixa o clipe foi solto. Um `dir` de ±1
   * obrigaria a traduzir um salto de três faixas em três chamadas.
   */
  const reorderLayer = useCallback((id: number, drawIndex: number) => {
    setProject(p => {
      const from = p.layers.findIndex(l => l.id === id);
      if (from < 0) return p;
      return { ...p, layers: moveItem(p.layers, from, drawIndex) };
    });
  }, []);

  const deleteLayer = (id: number) => {
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
    const ctx = cv.getContext('2d');
    if (!ctx) return flash('Canvas indisponível — não deu pra exportar');
    drawFrame(ctx, project, player.t);
    const a = document.createElement('a');
    a.download = `frame_${player.t.toFixed(2)}s.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
    flash('PNG salvo!');
  };

  const resizeProject = useCallback((width: number, height: number) => {
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
        <button className="btn" onClick={() => fileRef.current?.click()}>+ MÍDIA</button>
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
        onReorder={reorderLayer}
      />
    </div>
  );
}
