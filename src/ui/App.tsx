import React, { useCallback, useEffect, useRef, useState } from 'react';
import { player } from '../engine/player.ts';
import { defaultProject, makeTextLayer, makeImageLayer, makeVideoLayer } from '../engine/project.ts';
import { compactTracks, splitLayer, topTrack } from '../engine/project.ts';
import { History } from '../engine/history.ts';
import {
  serializeProject, deserializeProject, mediaIdsOf, ProjectFormatError,
} from '../engine/serialize.ts';
import {
  newMediaId, putMedia, allMedia, urlFor, releaseAll, pruneMedia,
  saveProject, loadProject, clearProject,
} from '../engine/mediaStore.ts';
import type { Layer, LayerPatch, Project } from '../engine/types.ts';
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

  const historyRef = useRef<History<Project> | null>(null);
  historyRef.current ??= new History(project);
  const history = historyRef.current;

  // O atalho de corte precisa enxergar a seleção atual sem religar o listener
  // de teclado a cada troca de layer.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  useEffect(() => history.subscribe(() => {
    setCanUndo(history.canUndo);
    setCanRedo(history.canRedo);
  }), [history]);

  /**
   * O funil ÚNICO por onde toda edição passa. Nada chama `setProject` direto.
   *
   * Registra no histórico *fora* do updater do `setState`: em StrictMode o
   * React chama o updater duas vezes pra flagrar efeito colateral, e um
   * `push` ali dentro entraria duplicado na pilha. Por isso o estado anterior
   * vem de `projectRef`, que já era mantido pra outros usos.
   *
   * `mergeKey` marca "a mesma ação continuando" — ver `history.ts`. Ações
   * discretas passam `null` e viram um passo cada.
   */
  const commit = useCallback((update: (p: Project) => Project, mergeKey: string | null = null) => {
    const prev = projectRef.current;
    const next = update(prev);
    if (next === prev) return;          // no-op não suja o histórico

    projectRef.current = next;
    history.push(next, { mergeKey });
    setProject(next);
  }, [history]);

  const restore = useCallback((state: Project | null) => {
    if (!state) return;
    projectRef.current = state;
    setProject(state);
  }, []);

  const undo = useCallback(() => restore(history.undo()), [history, restore]);
  const redo = useCallback(() => restore(history.redo()), [history, restore]);


  /**
   * Restaura o projeto guardado, ou fica no de exemplo.
   *
   * `restoring` segura o autosave: sem isso o efeito de gravação dispara no
   * primeiro render e sobrescreve o que está no disco com o projeto de
   * exemplo — você abriria o editor e teria perdido tudo.
   */
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const saved = await loadProject();
        if (!saved || cancelled) return;

        // Descarta a mídia órfã ANTES de carregar. Excluir layer não apaga o
        // arquivo (o undo pode trazê-la de volta), mas ao reabrir não existe
        // mais histórico que a alcance — e sem isso o editor decodificaria
        // vídeos que ninguém usa a cada abertura.
        const used = mediaIdsOf(saved);
        await pruneMedia(used);
        if (cancelled) return;

        // Cada mídia guardada vira um elemento antes de montar as layers: a
        // desserialização é síncrona e precisa dos elementos já resolvidos.
        const media = await allMedia();
        const elements = new Map<string, HTMLImageElement | HTMLVideoElement>();

        await Promise.all(media.map(m => new Promise<void>(done => {
          const url = urlFor(m.id, m.blob);
          if (m.type.startsWith('video/')) {
            const v = attachVideoElement(document.createElement('video'));
            v.addEventListener('loadedmetadata', () => { elements.set(m.id, v); done(); }, { once: true });
            v.addEventListener('error', () => done(), { once: true });
            v.src = url;
          } else {
            const img = new Image();
            img.onload = () => { elements.set(m.id, img); done(); };
            img.onerror = () => done();
            img.src = url;
          }
        })));
        if (cancelled) return;

        const { project: loaded, missingMedia } = deserializeProject(saved, id => elements.get(id) ?? null);

        projectRef.current = loaded;
        setProject(loaded);
        history.reset(loaded);
        setSelectedId(loaded.layers[loaded.layers.length - 1]?.id ?? null);
        player.invalidate();

        if (missingMedia.length) {
          flash(`${missingMedia.length} layer(s) sem mídia: ${missingMedia.join(', ')}`);
        }
      } catch (err) {
        // Projeto ilegível não pode impedir o editor de abrir. Fica no de
        // exemplo e avisa, em vez de mostrar tela branca.
        flash(err instanceof ProjectFormatError ? err.message : 'Não consegui abrir o projeto salvo');
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();

    return () => { cancelled = true; };
  }, [history]);

  /**
   * Autosave: grava o projeto pouco depois de você parar de mexer.
   *
   * O atraso não é economia de disco, é correção — arrastar um clipe produz
   * uma edição por quadro, e gravar em cada uma enfileiraria centenas de
   * transações que terminam fora de ordem.
   */
  useEffect(() => {
    if (restoring) return;
    const timer = setTimeout(() => {
      saveProject(serializeProject(project)).catch(() => { /* cota cheia ou modo privado */ });
    }, 600);
    return () => clearTimeout(timer);
  }, [project, restoring]);

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

  /**
   * `coalesce` liga a fusão de passos no histórico, e é o padrão porque a
   * maioria das edições é contínua: arrastar uma alça de trim ou digitar num
   * campo numérico dispara dezenas de chamadas que são UMA ação pro usuário.
   * A chave sai da layer + os campos tocados, então gestos diferentes nunca
   * se misturam.
   *
   * Quem edita em cliques discretos (adicionar/remover efeito) passa `false`,
   * senão dois cliques rápidos viram um passo só.
   */
  const updateLayer = useCallback((id: number, patch: LayerPatch, coalesce = true) => {
    const mergeKey = coalesce ? `layer:${id}:${Object.keys(patch).sort().join(',')}` : null;
    commit(p => ({
      ...p,
      // O cast é o preço de um patch que atende os três tipos de layer: o
      // spread preserva o `type`, mas o compilador não consegue provar isso
      // sozinho sobre uma união.
      layers: p.layers.map(l => (l.id === id ? { ...l, ...patch } as Layer : l)),
    }), mergeKey);
  }, [commit]);

  const addText = () => {
    const layer = makeTextLayer({
      name: `Texto ${project.layers.length + 1}`,
      start: +player.t.toFixed(2),
    });
    commit(p => ({
      ...p,
      layers: [...p.layers, { ...layer, track: topTrack(p.layers) + 1 }],
    }));
    setSelectedId(layer.id);
    setTab('props');
  };

  const addLayer = (layer: Layer) => {
    // Mídia nova entra numa faixa própria, no topo: empilhar em cima de um
    // clipe existente esconderia o que já estava lá sem aviso.
    commit(p => ({
      ...p,
      layers: [...p.layers, { ...layer, track: topTrack(p.layers) + 1 }],
    }));
    setSelectedId(layer.id);
    setTab('props');
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    // O arquivo vai pro armazenamento ANTES de virar layer: é isso que faz o
    // projeto reabrir sozinho depois. Se a gravação falhar, a layer ainda
    // entra — perder a mídia ao recarregar é ruim, não poder editar agora é pior.
    const mediaId = newMediaId();
    putMedia(mediaId, file).catch(() => flash('Mídia não pôde ser guardada pra depois'));

    const url = urlFor(mediaId, file);
    attachMedia(file.type, url, mediaId, file.name);
  };

  /** Monta o elemento certo pro tipo do arquivo e devolve uma layer pronta. */
  const attachMedia = (type: string, url: string, mediaId: string, name: string) => {
    if (type.startsWith('video/')) {
      const video = attachVideoElement(document.createElement('video'));
      video.addEventListener('loadedmetadata', () => {
        addLayer(makeVideoLayer(video, mediaId, { name, start: +player.t.toFixed(2) }));
        player.invalidate();
      }, { once: true });
      video.addEventListener('error', () => flash('Não consegui abrir esse vídeo'), { once: true });
      video.src = url;
    } else {
      const img = new Image();
      img.onload = () => addLayer(makeImageLayer(img, mediaId, { name, start: +player.t.toFixed(2) }));
      img.onerror = () => flash('Não consegui abrir essa imagem');
      img.src = url;
    }
  };

  /**
   * Reposiciona uma layer na ordem de desenho (0 = fundo, último = frente).
   *
   * Recebe o destino absoluto, não uma direção: quem chama é o arrasto da
   * timeline, que já sabe em qual faixa o clipe foi solto. Um `dir` de ±1
   * obrigaria a traduzir um salto de três faixas em três chamadas.
   */
  /**
   * Resultado de um arrasto: posição no tempo e faixa, aplicadas juntas.
   *
   * Uma coisa só porque é um gesto só — separar em duas edições colocaria dois
   * passos no histórico pro mesmo movimento, e um estado intermediário
   * impossível (o clipe na faixa nova, no instante velho) chegaria a existir.
   */
  const moveClip = useCallback((id: number, to: { start: number; track: number }) => {
    commit(p => {
      const layers = p.layers.map(l => (l.id === id ? { ...l, ...to } : l));
      // Compacta depois de mover: tirar o único clipe de uma faixa deixaria
      // uma linha fantasma pra trás.
      return { ...p, layers: compactTracks(layers) };
    });
  }, [commit]);

  /**
   * Corta o clipe selecionado no cursor — o Ctrl+B do CapCut.
   *
   * Age só no selecionado, e não em tudo que estiver sob o cursor: cortar
   * cinco faixas de uma vez porque você errou o alvo é bem pior de desfazer
   * do que cortar de novo.
   */
  const splitSelected = useCallback(() => {
    const layer = projectRef.current.layers.find(l => l.id === selectedIdRef.current);
    if (!layer) return flash('Selecione um clipe pra cortar');

    const halves = splitLayer(layer, player.t);
    if (!halves) return flash('O cursor precisa estar dentro do clipe, longe das pontas');

    const [left, right] = halves;
    commit(p => ({
      ...p,
      layers: p.layers.flatMap(l => (l.id === layer.id ? [left, right] : [l])),
    }));
    // Seleciona a metade nova: depois de cortar, o passo seguinte quase sempre
    // é mexer no que ficou pra frente.
    setSelectedId(right.id);
  }, [commit]);

  // Atalhos globais. Fora de campos de texto, onde o undo nativo do navegador
  // é o que você espera, e o "b" é só a letra b.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!(e.ctrlKey || e.metaKey)) return;

      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
      else if (key === 'b') { e.preventDefault(); splitSelected(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [undo, redo, splitSelected]);

  const deleteLayer = (id: number) => {
    commit(p => {
      const layers = p.layers.filter(l => l.id !== id);
      if (layers.length === p.layers.length) return p;
      setSelectedId(cur => (cur === id ? layers[layers.length - 1]?.id ?? null : cur));
      return { ...p, layers: compactTracks(layers) };
    });
    // O <video> NÃO é destruído aqui: com undo, essa layer pode voltar, e um
    // elemento com o src revogado voltaria preto e sem áudio. O decoder é
    // solto quando o projeto inteiro é trocado, não a cada exclusão.
  };

  /** Recomeça do zero — e só aqui a mídia órfã é de fato apagada. */
  const newProject = async () => {
    if (!confirm('Descartar o projeto atual e começar um novo?')) return;

    player.pause();
    const fresh = defaultProject();
    projectRef.current = fresh;
    setProject(fresh);
    history.reset(fresh);
    setSelectedId(fresh.layers[0]?.id ?? null);

    // Aqui a mídia deixa de ser necessária de verdade: não há mais histórico
    // que possa trazer as layers de volta.
    releaseAll();
    await Promise.all([clearProject(), pruneMedia(new Set())]);
    flash('Projeto novo');
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
    // Digitar "1080" num campo de dimensão passa por 1, 10, 108, 1080 — um
    // passo de histórico por tecla seria inútil.
    commit(p => ({ ...p, width, height }), 'resize');
  }, [commit]);

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

        <span className="topbar-sep" />
        <button className="btn" onClick={undo} disabled={!canUndo} title="Desfazer (Ctrl+Z)">↶</button>
        <button className="btn" onClick={redo} disabled={!canRedo} title="Refazer (Ctrl+Shift+Z)">↷</button>

        <div className="topbar-spacer" />

        {toast && <span className="toast">{toast}</span>}
        <button className="btn" onClick={newProject} title="Descartar tudo e começar um projeto novo">✧ NOVO</button>
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
        onMoveClip={moveClip}
        onSplit={splitSelected}
        onMessage={flash}
      />
    </div>
  );
}
