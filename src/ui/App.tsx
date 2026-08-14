import React, { useCallback, useEffect, useRef, useState } from 'react';
import { player } from '../engine/player.ts';
import {
  defaultProject, makeTextLayer, makeImageLayer, makeVideoLayer, makeAudioLayer,
} from '../engine/project.ts';
import { clone, compactTracks, nextId, projectDuration, splitLayer, topTrack } from '../engine/project.ts';
import { openTrackAt } from '../engine/trackDrag.ts';
import { History } from '../engine/history.ts';
import {
  serializeProject, deserializeProject, mediaIdsOf, ProjectFormatError,
} from '../engine/serialize.ts';
import type { MediaElement } from '../engine/serialize.ts';
import {
  newMediaId, putMedia, allMedia, urlFor, releaseAll, pruneMedia,
  saveProject, loadProject, clearProject,
} from '../engine/mediaStore.ts';
import type { Layer, LayerPatch, MediaAsset, Project } from '../engine/types.ts';
import { SCHEMA_DOC } from '../engine/presets.ts';
import { drawFrame } from '../engine/renderer.ts';
import { ensureDisplayFont } from '../engine/fonts.ts';
import { attachVideoElement, pauseAllVideo } from '../engine/videoSync.ts';
import { attachAudioElement, syncSoundLayers, stopAllSound } from '../engine/audioSync.ts';
import { Stage } from './Stage.tsx';
import { Timeline } from './Timeline.tsx';
import { Win } from './Win.tsx';
import { MediaPanel } from './MediaPanel.tsx';
import { PropsPanel } from './PropsPanel.tsx';
import { EffectsPanel } from './EffectsPanel.tsx';

type TabId = 'media' | 'props' | 'fx';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'media', label: 'Mídia' },
  { id: 'props', label: 'Props' },
  { id: 'fx', label: 'Efeitos' },
];

export default function App() {
  const [project, setProject] = useState(defaultProject);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tab, setTab] = useState<TabId>('media');
  const [toast, setToast] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef(project);
  projectRef.current = project;

  /**
   * Elemento vivo de cada mídia do acervo.
   *
   * Fica fora do projeto porque não é dado do projeto: é o objeto de DOM desta
   * sessão, que morre com a aba. O que o projeto guarda é o `mediaId`; isto
   * aqui é o que traduz um de volta pro outro na hora de criar uma layer.
   */
  const elementsRef = useRef(new Map<string, MediaElement>());

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
        const elements = new Map<string, MediaElement>();

        await Promise.all(media.map(m => new Promise<void>(done => {
          const url = urlFor(m.id, m.blob);
          if (m.type.startsWith('audio/')) {
            const a = attachAudioElement(new Audio());
            a.addEventListener('loadedmetadata', () => { elements.set(m.id, a); done(); }, { once: true });
            a.addEventListener('error', () => done(), { once: true });
            a.src = url;
          } else if (m.type.startsWith('video/')) {
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

        // O acervo do painel usa este registro pra reencontrar os elementos.
        elementsRef.current = elements;

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

    // Nem vídeo nem som podem continuar rolando depois que o transporte para.
    const unsubState = player.onState(p => {
      if (!p.playing) {
        pauseAllVideo(projectRef.current);
        stopAllSound(projectRef.current.layers);
      }
    });

    /**
     * O som anda no tick, não no quadro desenhado.
     *
     * `onFrame` é pulado quando nada mudou na tela — que é exatamente o
     * momento em que a música tem que continuar tocando. Amarrar som a
     * repintura faria a trilha travar num trecho parado.
     */
    const unsubTick = player.onTick(t => {
      syncSoundLayers(projectRef.current.layers, t, player.playing, {
        // Com a imagem saindo do cache, ninguém mais conduz os <video> — e é
        // deles que sai o som do clipe.
        driveVideo: player.fromCache,
      });
    });

    // ?t=1.6 opens the editor parked at that timestamp.
    const t = parseFloat(new URLSearchParams(location.search).get('t') ?? '');
    if (Number.isFinite(t)) player.seek(t);

    return () => { unsubState(); unsubTick(); player.stop(); };
  }, []);

  /**
   * A duração do projeto é DERIVADA do conteúdo, não digitada.
   *
   * Um efeito só, aqui, cobre todo caminho que mexe em layers — edição, undo,
   * importação, arrasto, restauração do disco. A alternativa era cada um deles
   * lembrar de atualizar o relógio, e o que esquecesse produziria exatamente o
   * bug que isto veio matar: clipe fora da duração, cortado do export sem aviso.
   */
  useEffect(() => {
    player.setDuration(projectDuration(project.layers));
  }, [project.layers]);

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
    e.target.value = '';
    if (file) importFile(file);
  };

  const importFile = (file: File) => {
    if (!/^(image|video|audio)\//.test(file.type)) {
      return flash(`"${file.name}" não é imagem, vídeo nem áudio`);
    }

    // O arquivo vai pro armazenamento ANTES de virar layer: é isso que faz o
    // projeto reabrir sozinho depois. Se a gravação falhar, a layer ainda
    // entra — perder a mídia ao recarregar é ruim, não poder editar agora é pior.
    const mediaId = newMediaId();
    putMedia(mediaId, file).catch(() => flash('Mídia não pôde ser guardada pra depois'));

    const url = urlFor(mediaId, file);
    attachMedia(file.type, url, mediaId, file.name, element => {
      // Entra no acervo E na linha do tempo. Importar pra depois posicionar é
      // um fluxo válido, mas o comum é querer ver na hora.
      registerAsset({ id: mediaId, name: file.name, type: file.type, duration: durationOf(element) });
      addLayerFor(mediaId, file.type, element, file.name);
    });
  };

  const durationOf = (el: HTMLImageElement | HTMLMediaElement) =>
    'duration' in el && Number.isFinite(el.duration) ? el.duration : 0;

  const registerAsset = (asset: MediaAsset) => {
    commit(p => (
      p.media.some(m => m.id === asset.id) ? p : { ...p, media: [...p.media, asset] }
    ));
  };

  /** Cria a layer certa pro tipo do arquivo e a coloca no cursor. */
  const addLayerFor = (
    mediaId: string,
    type: string,
    element: MediaElement,
    name: string,
  ) => {
    const start = +player.t.toFixed(2);
    if (type.startsWith('audio/')) {
      addLayer(makeAudioLayer(element as HTMLAudioElement, mediaId, { name, start }));
    } else if (type.startsWith('video/')) {
      addLayer(makeVideoLayer(element as HTMLVideoElement, mediaId, { name, start }));
      player.invalidate();
    } else {
      addLayer(makeImageLayer(element as HTMLImageElement, mediaId, { name, start }));
    }
  };

  /** Reutiliza um arquivo do acervo — sem reimportar, sem guardar outra cópia. */
  const useAsset = (asset: MediaAsset) => {
    const element = elementsRef.current.get(asset.id);
    if (!element) return flash('Esse arquivo ainda está carregando');
    addLayerFor(asset.id, asset.type, element, asset.name);
  };

  /** Tira do acervo junto com os clipes que o usam — um só passo de histórico. */
  const removeAsset = (asset: MediaAsset) => {
    commit(p => ({
      ...p,
      media: p.media.filter(m => m.id !== asset.id),
      layers: compactTracks(
        p.layers.filter(l => l.type === 'text' || l.mediaId !== asset.id),
      ),
    }));
  };

  /**
   * Soltar arquivos em qualquer lugar do editor importa.
   *
   * O contador de `dragenter`/`dragleave` existe porque o navegador dispara
   * `dragleave` toda vez que o ponteiro cruza a borda de um filho — sem contar
   * as entradas, o destaque pisca sem parar enquanto você atravessa a
   * interface com o arquivo na mão.
   */
  const dragDepth = useRef(0);
  const [dropping, setDropping] = useState(false);

  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth.current++;
    setDropping(true);
  };

  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    // Sem isto o navegador ABRE o arquivo, trocando o editor pelo vídeo — e
    // você perde o projeto que não tinha sido salvo ainda.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    for (const file of e.dataTransfer.files) importFile(file);
  };

  /**
   * Cria o elemento de DOM pro arquivo e avisa quando ele estiver pronto.
   *
   * `ready` só dispara depois dos metadados: antes disso a duração é `NaN` e a
   * layer nasceria com tamanho inválido.
   */
  const attachMedia = (
    type: string,
    url: string,
    mediaId: string,
    name: string,
    ready: (el: MediaElement) => void,
  ) => {
    const remember = (el: MediaElement) => {
      elementsRef.current.set(mediaId, el);
      ready(el);
    };

    if (type.startsWith('audio/')) {
      const audio = attachAudioElement(new Audio());
      audio.addEventListener('loadedmetadata', () => remember(audio), { once: true });
      audio.addEventListener('error', () => flash(`Não consegui abrir "${name}"`), { once: true });
      audio.src = url;
    } else if (type.startsWith('video/')) {
      const video = attachVideoElement(document.createElement('video'));
      video.addEventListener('loadedmetadata', () => remember(video), { once: true });
      video.addEventListener('error', () => flash(`Não consegui abrir "${name}"`), { once: true });
      video.src = url;
    } else {
      const img = new Image();
      img.onload = () => remember(img);
      img.onerror = () => flash(`Não consegui abrir "${name}"`);
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
  const moveClip = useCallback(
    (id: number, to: { start: number; track: number; insert: boolean }) => {
      commit(p => {
        // Inserção abre espaço ANTES de posicionar: as faixas dali pra cima
        // sobem uma, e só então o clipe ocupa o número que vagou. Na ordem
        // inversa ele subiria junto e cairia na faixa errada.
        const base = to.insert ? openTrackAt(p.layers, to.track) : p.layers;
        const layers = base.map(
          l => (l.id === id ? { ...l, start: to.start, track: to.track } : l),
        );
        // Compacta depois: tirar o único clipe de uma faixa deixaria uma linha
        // fantasma, e uma inserção pode ter aberto um buraco na origem.
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



  const deleteLayer = useCallback((id: number) => {
    commit(p => {
      const layers = p.layers.filter(l => l.id !== id);
      if (layers.length === p.layers.length) return p;
      setSelectedId(cur => (cur === id ? layers[layers.length - 1]?.id ?? null : cur));
      return { ...p, layers: compactTracks(layers) };
    });
    // O <video> NÃO é destruído aqui: com undo, essa layer pode voltar, e um
    // elemento com o src revogado voltaria preto e sem áudio. O decoder é
    // solto quando o projeto inteiro é trocado, não a cada exclusão.
  }, [commit]);

  /**
   * Duplica o clipe selecionado, logo DEPOIS dele na mesma faixa.
   *
   * Depois e não em cima: a faixa não aceita sobreposição, então colar no
   * mesmo lugar seria recusado — e "duplicar não fez nada" é pior que
   * duplicar num lugar que você move em seguida.
   */
  const duplicateSelected = useCallback(() => {
    const layer = projectRef.current.layers.find(l => l.id === selectedIdRef.current);
    if (!layer) return flash('Selecione um clipe pra duplicar');

    const copy: Layer = {
      ...layer,
      id: nextId(),
      start: +(layer.start + layer.duration).toFixed(3),
      effects: clone(layer.effects),
    };

    commit(p => ({ ...p, layers: [...p.layers, copy] }));
    setSelectedId(copy.id);
  }, [commit]);

  // Atalhos globais. Fora de campos de texto, onde o undo nativo do navegador
  // é o que você espera, e o "b" é só a letra b.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Delete não usa modificador — é a tecla que todo editor usa pra apagar.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = selectedIdRef.current;
        if (id === null) return;
        e.preventDefault();
        deleteLayer(id);
        return;
      }

      if (!(e.ctrlKey || e.metaKey)) return;

      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
      else if (key === 'b') { e.preventDefault(); splitSelected(); }
      else if (key === 'd') { e.preventDefault(); duplicateSelected(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [undo, redo, splitSelected, duplicateSelected, deleteLayer]);

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
    <div
      className={`app${dropping ? ' dropping' : ''}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="logo">
          <span className="logo-marks">▚▚▚</span>
          FRAGMENTO
        </div>

        <button className="btn" onClick={addText}>+ TEXTO</button>
        <button className="btn" onClick={() => fileRef.current?.click()}>+ MÍDIA</button>
        <input ref={fileRef} type="file" accept="image/*,video/*,audio/*" hidden onChange={onFile} />

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
        <Stage
          project={project}
          onResize={resizeProject}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onChange={updateLayer}
        />

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
            {tab === 'media' && (
              <MediaPanel project={project} onUse={useAsset} onRemove={removeAsset} />
            )}
            {tab === 'props' && <PropsPanel layer={selected} onChange={updateLayer} />}
            {tab === 'fx' && <EffectsPanel layer={selected} onChange={updateLayer} />}
          </Win>
        </aside>
      </main>

      {dropping && (
        <div className="dropzone" role="status">
          <span>Solte pra importar</span>
        </div>
      )}

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
