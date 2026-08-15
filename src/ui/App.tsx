import React, { useCallback, useEffect, useRef, useState } from 'react';
import { player } from '../engine/player.ts';
import {
  defaultProject, makeTextLayer, makeImageLayer, makeVideoLayer, makeAudioLayer,
} from '../engine/project.ts';
import {
  clone, compactTracks, nextId, pasteSlot, projectDuration, splitLayer,
  topTrackOf, trackKind,
} from '../engine/project.ts';
import { openTrackAt } from '../engine/trackDrag.ts';
import { History } from '../engine/history.ts';
import {
  serializeProject, deserializeProject, mediaIdsOf, ProjectFormatError,
} from '../engine/serialize.ts';
import type { MediaElement } from '../engine/serialize.ts';
import {
  newMediaId, putMedia, allMedia, urlFor, existingUrl, releaseAll, pruneMedia,
  saveProject, loadProject, clearProject, mediaBlob,
  listSnapshots, putSnapshot, getSnapshot, deleteSnapshots, clearSnapshots,
} from '../engine/mediaStore.ts';
import { snapshotPlan, snapshotLabel } from '../engine/snapshots.ts';
import { toFrag, fromFrag, fragFileName, FragFileError } from '../engine/fragFile.ts';
import type { Layer, LayerPatch, MediaAsset, Project } from '../engine/types.ts';
import { SCHEMA_DOC } from '../engine/presets.ts';
import { drawFrame } from '../engine/renderer.ts';
import { ensureDisplayFont } from '../engine/fonts.ts';
import { attachVideoElement, pauseAllVideo } from '../engine/videoSync.ts';
import { attachAudioElement, stopAllSound } from '../engine/audioSync.ts';
import { soundEngine } from '../engine/soundEngine.ts';
import { clearPeaks } from '../engine/waveformStore.ts';
import { frameFor, registerSource, releaseFrames } from '../engine/videoFrames.ts';
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

/**
 * Um elemento carregado por mídia guardada, pronto pra desserialização.
 *
 * Fora do componente porque não depende de estado nenhum — e porque é usada por
 * DOIS caminhos: reabrir o projeto do disco e importar um `.frag`. Duas cópias
 * disto divergiriam, e o jeito de divergir é uma delas esquecer o
 * `registerSource` e o vídeo importado abrir sem imagem.
 *
 * Espera o `loadedmetadata` de cada um: a desserialização é síncrona e precisa
 * dos elementos já resolvidos. Quem falhar em carregar simplesmente não entra no
 * mapa, e vira `missingMedia` mais à frente — nunca uma exceção que derruba a
 * abertura inteira por causa de um arquivo.
 */
/**
 * Guarda uma versão no histórico, se a política deixar.
 *
 * Silenciosa nos dois sentidos: não avisa quando guarda (seria ruído a cada dois
 * minutos) e não reclama quando falha. Histórico é rede de segurança — se a
 * cota do navegador acabar, o certo é o editor continuar salvando o projeto
 * principal, não parar de funcionar por causa do backup.
 */
async function guardarVersao(dados: unknown): Promise<void> {
  try {
    const agora = Date.now();
    const plano = snapshotPlan((await listSnapshots()).map(at => ({ at })), agora);
    if (!plano.write) return;
    await putSnapshot(agora, dados);
    // Apaga DEPOIS de gravar: o contrário abriria uma janela em que o histórico
    // tem uma versão a menos e a nova ainda não existe.
    if (plano.drop.length) await deleteSnapshots(plano.drop);
  } catch { /* cota cheia: o projeto principal já está salvo */ }
}

async function carregarElementos(): Promise<Map<string, MediaElement>> {
  const media = await allMedia();
  const elements = new Map<string, MediaElement>();

  await Promise.all(media.map(m => new Promise<void>(done => {
    const url = urlFor(m.id, m.blob);
    registerSource(m.id, url);
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

  return elements;
}

export default function App() {
  const [project, setProject] = useState(defaultProject);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tab, setTab] = useState<TabId>('media');
  const [toast, setToast] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const fragRef = useRef<HTMLInputElement>(null);
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

  /**
   * `<audio>` extras, um por arquivo, criados sob demanda.
   *
   * Separado de `elementsRef` porque o elemento "natural" de um vídeo é o
   * `<video>`, e uma faixa destacada precisa de um cursor PRÓPRIO — senão ela
   * disputa a posição com a imagem e uma das duas cala (ver `ownersByElement`).
   * Como os dois leem a mesma `blob:`, não há byte a mais nem download extra.
   */
  const audioElementsRef = useRef(new Map<string, HTMLAudioElement>());

  const audioElementFor = useCallback((mediaId: string): HTMLAudioElement | null => {
    const found = audioElementsRef.current.get(mediaId);
    if (found) return found;

    const url = existingUrl(mediaId);
    if (!url) return null;   // a mídia ainda não foi carregada nesta sessão

    const el = attachAudioElement(new Audio());
    el.src = url;
    audioElementsRef.current.set(mediaId, el);
    return el;
  }, []);

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

  /**
   * O projeto guardado não pôde ser lido — então NADA pode ser gravado por cima.
   *
   * Sem isto, um projeto ilegível era **destruído 600ms depois de abrir o
   * editor**: o restore falhava, o editor caía no projeto de exemplo, o
   * `finally` liberava o autosave e o exemplo era gravado por cima. Os bytes
   * sumiam, e não havia nem como tentar de novo — o pior resultado possível,
   * porque o motivo de o restore falhar costuma ser um defeito NOSSO (uma
   * migração nova, um campo que mudou de forma), e quem paga é a edição de
   * quem estava usando.
   *
   * Enquanto isto for verdade o editor é só leitura, e diz isso. Sai por
   * decisão explícita: `✧ NOVO` descarta, que é o único gesto que significa
   * "pode escrever por cima".
   */
  const [saveBlocked, setSaveBlocked] = useState(false);

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
        const elements = await carregarElementos();
        if (cancelled) return;

        const { project: loaded, missingMedia } = deserializeProject(saved, (id, type) => (
          // Layer de áudio quer um `<audio>`, mesmo quando o arquivo é vídeo:
          // é o que uma faixa destacada é, depois de reabrir o projeto.
          type === 'audio' && !(elements.get(id) instanceof HTMLAudioElement)
            ? audioElementFor(id)
            : elements.get(id) ?? null
        ));

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
        //
        // E TRAVA a gravação: o que está no disco é o trabalho de alguém, e
        // não conseguir lê-lo não é motivo pra apagá-lo. Ver `saveBlocked`.
        if (!cancelled) setSaveBlocked(true);
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
    if (restoring || saveBlocked) return;
    const timer = setTimeout(() => {
      const dados = serializeProject(project);
      saveProject(dados)
        // O histórico só depois de a gravação principal dar certo: guardar uma
        // versão de algo que não foi salvo confundiria as duas coisas.
        .then(() => guardarVersao(dados))
        .catch(() => { /* cota cheia ou modo privado */ });
    }, 600);
    return () => clearTimeout(timer);
  }, [project, restoring, saveBlocked]);

  useEffect(() => {
    player.start();
    setSelectedId(p => p ?? project.layers[0]?.id ?? null);

    // The canvas font must be fetched explicitly; repaint once it lands.
    ensureDisplayFont().then(() => player.invalidate());

    /**
     * De onde o tocador tira os bytes pra decodificar. Instalado uma vez.
     *
     * O módulo do som não conhece o IndexedDB — mesma injeção que o
     * `renderAudio` do export já usava.
     */
    soundEngine.setBlobResolver(mediaBlob);

    // Nem vídeo nem som podem continuar rolando depois que o transporte para.
    const unsubState = player.onState(p => {
      if (!p.playing) {
        pauseAllVideo(projectRef.current);
        soundEngine.stop();
        // Os elementos não tocam mais, mas podem ter sobrado rolando de uma
        // sessão anterior a esta mudança. Barato, e cobre o caso.
        stopAllSound(projectRef.current.layers);
      }
    });

    /**
     * O som anda no tick, não no quadro desenhado.
     *
     * `onFrame` é pulado quando nada mudou na tela — que é exatamente o
     * momento em que a música tem que continuar tocando. Amarrar som a
     * repintura faria a trilha travar num trecho parado.
     *
     * Quase todo tick não faz nada: uma agenda já no ar toca sozinha. Ver
     * `soundAction`.
     */
    const unsubTick = player.onTick(t => {
      soundEngine.sync(projectRef.current.layers, {
        t, playing: player.playing, duration: player.duration,
      });
    });

    /**
     * O som passa a ditar o tempo — agora pelo `AudioContext`.
     *
     * Era o `currentTime` de um `<video>`, e num remix esse elemento é buscado
     * a cada corte: medido, ele andava 88,8% do tempo de parede contra 98,7% do
     * mesmo arquivo num clipe só. Como a linha do tempo seguia o elemento, a
     * reprodução inteira saía 11% lenta. O `currentTime` do contexto de áudio
     * corre no hardware e não conhece seek. Ver `soundSchedule.ts`.
     *
     * Instalado uma vez, aqui, e não a cada mudança de projeto: reinstalar
     * descartaria a leitura anterior e perderia o delta a cada quadro,
     * deixando a reprodução parada.
     */
    player.setTimeSource(() => soundEngine.clock());

    /**
     * Janela de inspeção pro relógio, só em desenvolvimento.
     *
     * Existe porque a verificação deste projeto acontece no navegador, com o
     * app de verdade — e de fora da página não há como perguntar o que o
     * relógio respondeu neste tick. Sem isso, medir o relógio exige
     * instrumentar o código a cada investigação, que é justamente o passo caro
     * que fez a bancada anterior se perder.
     *
     * Só leitura, e some do pacote em produção (`import.meta.env.DEV`).
     */
    if (import.meta.env.DEV) {
      (globalThis as Record<string, unknown>).__FRAG__ = {
        player,
        layers: () => projectRef.current.layers,
        soundClock: () => soundEngine.clock(),
        // A saída do tocador, pra bancada gravar o que está sendo tocado e
        // conferir o CONTEÚDO do som, não só que houve som.
        soundOutput: () => soundEngine.output(),
      };
    }

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

  /**
   * A grade de quadros do projeto é a do relógio. Pelo mesmo motivo da duração:
   * um efeito só cobre projeto novo, importado e restaurado do disco.
   *
   * É o que faz o playhead pousar sempre num quadro que o export também
   * renderiza — ver o cabeçalho de `player.ts`.
   */
  useEffect(() => {
    player.setFps(project.fps);
  }, [project.fps]);

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
      layers: [...p.layers, { ...layer, track: topTrackOf(p.layers, trackKind(layer)) + 1 }],
    }));
    setSelectedId(layer.id);
    setTab('props');
  };

  const addLayer = (layer: Layer) => {
    // Mídia nova entra numa faixa própria, no topo: empilhar em cima de um
    // clipe existente esconderia o que já estava lá sem aviso.
    commit(p => ({
      ...p,
      layers: [...p.layers, { ...layer, track: topTrackOf(p.layers, trackKind(layer)) + 1 }],
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
    // O decodificador de quadros lê desta mesma URL — nenhum byte a mais.
    registerSource(mediaId, url);
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
      // Nada é selecionado no lugar. Eleger a última da lista parecia gentileza
      // e era chute: a próxima edição ia pra uma layer que você não escolheu, e
      // um Delete seguido de outro apagava algo que não estava na mira.
      setSelectedId(cur => (cur === id ? null : cur));
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

    const span = {
      start: +(layer.start + layer.duration).toFixed(3),
      duration: layer.duration,
    };

    commit(p => {
      /**
       * "Logo depois" é a INTENÇÃO, não o destino garantido.
       *
       * Antes a cópia era largada ali de qualquer jeito, e se houvesse um clipe
       * naquele trecho as duas passavam a se sobrepor na mesma faixa — o que
       * quebra a invariante que sustenta a ordem de desenho. `pasteSlot` mantém
       * a intenção e sobe uma faixa quando o lugar está ocupado.
       */
      const slot = pasteSlot(p.layers, span, layer.track, trackKind(layer));
      const copy: Layer = {
        ...layer,
        id: nextId(),
        ...slot,
        effects: clone(layer.effects),
      };
      setSelectedId(copy.id);
      return { ...p, layers: [...p.layers, copy] };
    });
  }, [commit]);

  /**
   * Área de transferência PRÓPRIA, não a do sistema.
   *
   * Uma layer não é texto: ela carrega efeitos e uma referência ao elemento de
   * mídia. Serializar pro clipboard do sistema significaria reanexar a mídia na
   * volta, e colar num projeto que não tem aquele arquivo daria uma layer
   * quebrada. Guardar a referência aqui mantém tudo coerente — e clipes do
   * mesmo arquivo dividindo um elemento é caso resolvido (ver `ownersByMedia`).
   */
  const clipboardRef = useRef<Layer | null>(null);

  const copySelected = useCallback((cortar = false) => {
    const layer = projectRef.current.layers.find(l => l.id === selectedIdRef.current);
    if (!layer) return flash('Selecione um clipe primeiro');

    clipboardRef.current = { ...layer, effects: clone(layer.effects) };
    if (cortar) deleteLayer(layer.id);
    else flash(`"${layer.name}" copiado`);
  }, [deleteLayer]);

  /**
   * Cola no CURSOR, e não onde o original estava: colar é um jeito de dizer
   * "quero isto aqui", e "aqui" é onde o playhead está.
   */
  const pasteClipboard = useCallback(() => {
    const source = clipboardRef.current;
    if (!source) return flash('Nada copiado ainda');

    const span = { start: +player.t.toFixed(3), duration: source.duration };
    const slot = pasteSlot(projectRef.current.layers, span, source.track, trackKind(source));

    const copy: Layer = {
      ...source,
      id: nextId(),
      ...slot,
      // Clonados na cópia E na colagem: colar duas vezes não pode produzir duas
      // layers que dividem a mesma lista de efeitos.
      effects: clone(source.effects),
    };

    commit(p => ({ ...p, layers: [...p.layers, copy] }));
    setSelectedId(copy.id);
  }, [commit]);

  /**
   * Separa o áudio de um clipe de vídeo numa faixa própria.
   *
   * O vídeo não perde o som — ele é **calado**, não removido. É o que permite
   * desfazer voltando o `mute`, e o que mantém o `mediaId` de pé nos dois lados
   * (o export decodifica o arquivo uma vez e serve os dois clipes).
   *
   * A faixa destacada ganha um `<audio>` PRÓPRIO sobre a mesma blob. Dividir o
   * `<video>` com a imagem seria pedir pro editor calar uma das duas — que é
   * exatamente o que separar veio desfazer.
   */
  const detachAudio = useCallback((id: number) => {
    const layer = projectRef.current.layers.find(l => l.id === id);
    if (!layer || layer.type !== 'video') return flash('Selecione um clipe de vídeo');
    if (layer.mute) return flash('Esse clipe já está sem som');

    const element = audioElementFor(layer.mediaId);
    if (!element) return flash('Esse arquivo ainda está carregando');

    const faixa = makeAudioLayer(element, layer.mediaId, {
      name: `${layer.name} — áudio`,
      start: layer.start,
      duration: layer.duration,
      trimStart: layer.trimStart,
      sourceDuration: layer.sourceDuration,
      volume: layer.volume,
    });

    commit(p => {
      // Faixa de áudio nova, no espaço de faixa do ÁUDIO.
        const slot = pasteSlot(p.layers, faixa, topTrackOf(p.layers, 'audio') + 1, 'audio');
      return {
        ...p,
        // O vídeo fica mudo no MESMO passo do histórico: desfazer tem que
        // devolver o som junto com a faixa, não em dois undos.
        layers: [
          ...p.layers.map(l => (l.id === id ? { ...l, mute: true } : l)),
          { ...faixa, ...slot },
        ],
      };
    });
    setSelectedId(faixa.id);
  }, [commit, audioElementFor]);

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
      else if (key === 'c') { e.preventDefault(); copySelected(); }
      else if (key === 'x') { e.preventDefault(); copySelected(true); }
      else if (key === 'v') { e.preventDefault(); pasteClipboard(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [undo, redo, splitSelected, duplicateSelected, deleteLayer, copySelected, pasteClipboard]);

  /** Recomeça do zero — e só aqui a mídia órfã é de fato apagada. */
  const newProject = async () => {
    /**
     * O aviso diz que o histórico vai junto, porque vai — e é a única coisa
     * aqui que não tem volta.
     *
     * As versões guardadas não podem sobreviver a este gesto: ele apaga TODA a
     * mídia (`pruneMedia(new Set())`), então uma versão antiga voltaria sem os
     * vídeos e sem os áudios. Guardar uma lista de versões que não abrem direito
     * seria uma promessa falsa justamente no lugar em que a pessoa vai procurar
     * socorro.
     */
    const temHistorico = (await listSnapshots().catch(() => [])).length;
    const aviso = temHistorico
      ? `Descartar o projeto atual, a mídia importada e ${temHistorico} versão(ões) guardada(s)?`
        + '\n\nIsso não tem desfazer. Se quiser guardar, cancele e use ▼ .FRAG antes.'
      : 'Descartar o projeto atual e começar um novo?';
    if (!confirm(aviso)) return;

    player.pause();
    const fresh = defaultProject();
    projectRef.current = fresh;
    setProject(fresh);
    history.reset(fresh);
    setSelectedId(fresh.layers[0]?.id ?? null);

    // Aqui a mídia deixa de ser necessária de verdade: não há mais histórico
    // que possa trazer as layers de volta.
    releaseAll();
    releaseFrames();
    soundEngine.release();
    clearPeaks();
    // Os `<audio>` extras apontam pras URLs recém-revogadas — guardá-los faria
    // a próxima faixa destacada nascer lendo uma fonte morta.
    audioElementsRef.current.clear();
    await Promise.all([clearProject(), pruneMedia(new Set()), clearSnapshots()]);
    // Descartar é o gesto explícito que libera a gravação de novo — ver
    // `saveBlocked`. Nada mais deve liberá-la.
    setSaveBlocked(false);
    flash('Projeto novo');
  };

  /**
   * Abre um projeto já serializado — de um arquivo, ou de uma versão guardada.
   *
   * **NÃO chama `pruneMedia`**, e a diferença é destrutiva. Reabrir do disco
   * descarta a mídia órfã porque ali não há mais histórico que a alcance; abrir
   * um `.frag` é outra coisa — o arquivo pode ser antigo e não citar a mídia que
   * você acabou de importar, e podar por ele apagaria os arquivos de alguém que
   * só queria olhar uma versão anterior.
   */
  const abrirSerializado = useCallback(async (dados: unknown, feito: string) => {
    const elements = await carregarElementos();
    const { project: loaded, missingMedia } = deserializeProject(dados, (id, type) => (
      type === 'audio' && !(elements.get(id) instanceof HTMLAudioElement)
        ? audioElementFor(id)
        : elements.get(id) ?? null
    ));

    elementsRef.current = elements;
    projectRef.current = loaded;
    setProject(loaded);
    history.reset(loaded);
    setSelectedId(loaded.layers[loaded.layers.length - 1]?.id ?? null);
    player.invalidate();
    // Abrir um projeto que funciona é o gesto que destrava a gravação: o que
    // está na tela agora é conhecido e bom. Ver `saveBlocked`.
    setSaveBlocked(false);

    flash(missingMedia.length
      ? `${feito} — ${missingMedia.length} layer(s) sem a mídia original`
      : feito);
  }, [history, audioElementFor]);

  /** Baixa o projeto como `.frag`. Ver `fragFile.ts`. */
  const baixarFrag = () => {
    const texto = toFrag(projectRef.current);
    const url = URL.createObjectURL(new Blob([texto], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fragFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    flash('Projeto baixado');
  };

  const onFragFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Zera o input antes de qualquer await: sem isso, escolher O MESMO arquivo
    // de novo não dispara `change` e parece que o editor ignorou o clique.
    e.target.value = '';
    if (!file) return;

    try {
      await abrirSerializado(fromFrag(await file.text()), `Aberto: ${file.name}`);
    } catch (err) {
      // A mensagem do erro é o produto aqui — ela diz o que fazer a seguir.
      flash(err instanceof FragFileError || err instanceof ProjectFormatError
        ? err.message
        : 'Não consegui abrir esse arquivo');
    }
  };

  // --- histórico de versões ---
  const [versoes, setVersoes] = useState<number[] | null>(null);

  const abrirVersoes = async () => {
    try {
      setVersoes((await listSnapshots()).slice().reverse());
    } catch {
      flash('Não consegui ler o histórico');
    }
  };

  const voltarPara = async (at: number) => {
    try {
      const dados = await getSnapshot(at);
      if (!dados) return flash('Essa versão não está mais guardada');
      /**
       * Guarda o estado ATUAL antes de trocar.
       *
       * Voltar pra uma versão não pode ser um caminho só de ida: se você
       * escolheu a versão errada, o que estava na tela tem que continuar
       * existindo em algum lugar. Sem isto, o próprio recurso de recuperação
       * seria uma forma nova de perder trabalho.
       */
      await putSnapshot(Date.now(), serializeProject(projectRef.current));
      await abrirSerializado(dados, `Voltou pra ${snapshotLabel(at, Date.now())}`);
      setVersoes(null);
    } catch (err) {
      flash(err instanceof ProjectFormatError ? err.message : 'Não consegui abrir essa versão');
    }
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
    drawFrame(ctx, project, player.t, { frameFor: frameFor(project, player.t) });
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

        {/*
          Fica na barra o tempo todo, e não como toast: um aviso que some
          deixaria você editar uma hora achando que está salvando. Ver
          `saveBlocked`.
        */}
        {saveBlocked && (
          <span
            className="save-blocked"
            title="O projeto guardado não pôde ser lido, e não vai ser sobrescrito. Baixe o .frag pra não perder o que está na tela; ✧ NOVO descarta o guardado e volta a salvar."
          >
            ⚠ NÃO ESTÁ SALVANDO
          </span>
        )}
        {toast && <span className="toast">{toast}</span>}
        <button
          className="btn"
          onClick={abrirVersoes}
          title="As últimas versões salvas automaticamente — pra voltar se algo der errado"
        >⟲ VERSÕES</button>
        <button className="btn" onClick={baixarFrag} title="Baixar o projeto como arquivo .frag">▼ .FRAG</button>
        <button
          className="btn"
          onClick={() => fragRef.current?.click()}
          title="Abrir um projeto .frag do disco"
        >▲ ABRIR</button>
        <input ref={fragRef} type="file" accept=".frag,application/json" hidden onChange={onFragFile} />
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
            {tab === 'props' && (
              <PropsPanel layer={selected} onChange={updateLayer} onDetachAudio={detachAudio} />
            )}
            {tab === 'fx' && <EffectsPanel layer={selected} onChange={updateLayer} />}
          </Win>
        </aside>
      </main>

      {dropping && (
        <div className="dropzone" role="status">
          <span>Solte pra importar</span>
        </div>
      )}

      {versoes !== null && (
        <div className="versoes-fundo" onClick={() => setVersoes(null)}>
          <div className="versoes" onClick={e => e.stopPropagation()}>
            <Win
              title="Versões"
              icon="⟲"
              right={<button className="btn btn-sm" onClick={() => setVersoes(null)}>✕</button>}
            >
              {versoes.length === 0 ? (
                <p className="versoes-vazio">
                  Nenhuma versão guardada ainda. A primeira aparece assim que o projeto
                  for salvo; depois disso, uma a cada dois minutos de trabalho.
                </p>
              ) : (
                <>
                  <p className="versoes-ajuda">
                    Voltar não descarta o que está na tela — ele vira uma versão nova
                    aqui na lista.
                  </p>
                  <ul className="versoes-lista">
                    {versoes.map(at => (
                      <li key={at}>
                        <span>{snapshotLabel(at, Date.now())}</span>
                        <button className="btn btn-sm" onClick={() => voltarPara(at)}>VOLTAR</button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Win>
          </div>
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
