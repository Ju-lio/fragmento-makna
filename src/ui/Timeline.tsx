import React, { useEffect, useRef, useState } from 'react';
import { player } from '../engine/player.ts';
import { trimLeft, trimRight } from '../engine/project.ts';
import { autoPrerender } from '../engine/autoPrerender.ts';
import { viewport, renderScale } from '../engine/viewport.ts';
import { ensureRangeCached, isRangeCached, prerenderStatus, cancelPrerender } from '../engine/prerender.ts';
import { frameProvider } from '../engine/videoFrames.ts';
import { PrerenderBar } from './PrerenderBar.tsx';
import { Waveform } from './Waveform.tsx';
import { clipDragPlan, flipOrder } from '../engine/trackDrag.ts';
import {
  topTrackOf, trackKind, layersOfKind, freeWindow, rulerDuration,
} from '../engine/project.ts';
import type { TrackKind } from '../engine/project.ts';
import { stepFrame } from '../engine/frameCache.ts';
import { effectiveGain } from '../engine/audioMix.ts';
import {
  timelineView, tickStep, zoomAnchor, clampScroll, followPlayhead,
} from '../engine/timelineView.ts';

/** O clipe emite som audível agora? Só isso decide se a faixinha aparece. */
const hasSound = (layer: Layer): boolean =>
  (layer.type === 'video' || layer.type === 'audio') && effectiveGain(layer) > 0;
import type { Layer, LayerPatch, Project } from '../engine/types.ts';

interface TimelineProps {
  project: Project;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onChange: (id: number, patch: LayerPatch) => void;
  /** Aplica o resultado de um arrasto: posição no tempo e faixa, de uma vez. */
  onMoveClip: (id: number, to: { start: number; track: number; insert: boolean }) => void;
  /** Corta o clipe selecionado no cursor (Ctrl+B). */
  onSplit: () => void;
  /** Mostra um aviso passageiro na barra de cima. */
  onMessage: (text: string) => void;
}

/**
 * Timeline + transport.
 *
 * The playhead bar and timecode are updated by writing to refs inside the
 * player's frame callback — never through setState — so dragging the playhead
 * across a 60s project costs zero React renders.
 */
export function Timeline({
  project, selectedId, onSelect, onChange, onMoveClip, onSplit, onMessage,
}: TimelineProps) {
  const headRef = useRef<HTMLDivElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  /** A janela que rola. O conteúdo dentro dela é maior que ela quando há zoom. */
  const wrapRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(player.playing);
  const [duration, setDuration] = useState(player.duration);
  const [view, setView] = useState(() => ({
    pxPerSecond: timelineView.pxPerSecond,
    contentWidth: timelineView.contentWidth,
    scrollable: timelineView.scrollable,
  }));
  const [autoPre, setAutoPre] = useState(autoPrerender.on);
  const [range, setRange] = useState<{ in: number | null; out: number | null }>(
    () => ({ in: player.rangeIn, out: player.rangeOut }),
  );
  const [preparing, setPreparing] = useState(prerenderStatus.running);

  /**
   * Comprimento da RÉGUA: o conteúdo mais a pista de arrasto (`TIMELINE_TAIL`).
   *
   * Distinto de `player.duration`, que é só o conteúdo. Tudo que a timeline
   * DESENHA (clipes, marcas, cursor, zoom) mede por este; tudo que EXECUTA
   * (export, loop, limite do scrub) mede pela duração. Sem a separação, ou o
   * projeto não pode crescer, ou o export leva junto cinco segundos de nada.
   */
  const rulerSpan = rulerDuration(project.layers);
  const rulerSpanRef = useRef(rulerSpan);
  rulerSpanRef.current = rulerSpan;

  // Guarda o handler de play: o atalho de teclado precisa enxergar o estado
  // atual sem religar o listener a cada render.
  const playRef = useRef<(() => Promise<void>) | null>(null);
  // Mesma razão: o passo de quadro precisa do fps do projeto atual.
  const fpsRef = useRef(project.fps);
  fpsRef.current = project.fps;

  useEffect(() => {
    const unsubFrame = player.onFrame(t => {
      const pct = (t / rulerSpanRef.current) * 100;
      if (headRef.current) headRef.current.style.left = `${pct}%`;
      if (tcRef.current) tcRef.current.textContent = fmt(t);

      /**
       * Segue o cursor durante a reprodução, escrevendo `scrollLeft` direto.
       *
       * Só tocando: enquanto você arrasta o cursor, quem manda na vista é você
       * — a timeline correndo atrás do ponteiro no meio de um gesto é o tipo de
       * coisa que faz errar a mira.
       */
      const wrap = wrapRef.current;
      if (!wrap || !player.playing) return;
      const next = followPlayhead(timelineView.xOf(t), wrap.scrollLeft, wrap.clientWidth);
      if (next !== null) {
        wrap.scrollLeft = clampScroll(next, timelineView.contentWidth, wrap.clientWidth);
      }
    });
    const unsubState = player.onState(p => {
      setPlaying(p.playing);
      setDuration(p.duration);
      setRange({ in: p.rangeIn, out: p.rangeOut });
    });
    const unsubMode = autoPrerender.subscribe(setAutoPre);
    const unsubPre = prerenderStatus.subscribe(s => setPreparing(s.running));
    // O zoom é ação discreta (um clique, um passo de roda), então um render por
    // evento é barato — o que não pode custar render é rolar, e rolar é nativo.
    const unsubView = timelineView.subscribe(v => setView({
      pxPerSecond: v.pxPerSecond,
      contentWidth: v.contentWidth,
      scrollable: v.scrollable,
    }));
    return () => { unsubFrame(); unsubState(); unsubMode(); unsubPre(); unsubView(); };
  }, []);

  // A janela e a duração definem o piso do zoom ("cabe tudo"), então as duas
  // alimentam o mesmo estado. O observer pega o resize da janela do navegador e
  // também o dos painéis laterais mudando de tamanho.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    timelineView.setViewport(wrap.clientWidth, rulerSpan);
    const ro = new ResizeObserver(() => timelineView.setViewport(wrap.clientWidth, rulerSpan));
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [rulerSpan]);

  /**
   * `Ctrl` + roda dá zoom no cursor; roda sozinha rola.
   *
   * `passive: false` porque sem `preventDefault` o `Ctrl` + roda vira o zoom do
   * navegador inteiro — a página cresce e a timeline fica do mesmo tamanho.
   * Mesmo par de gestos do palco, de propósito: são a mesma pergunta feita em
   * dois lugares, e responder diferente em cada um é o que faz decorar atalho.
   */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const anchorX = e.clientX - wrap.getBoundingClientRect().left;
        const before = timelineView.pxPerSecond;
        timelineView.setPxPerSecond(before * Math.exp(-e.deltaY * 0.0015));

        const scroll = zoomAnchor(wrap.scrollLeft, anchorX, before, timelineView.pxPerSecond);
        wrap.scrollLeft = clampScroll(scroll, timelineView.contentWidth, wrap.clientWidth);
        return;
      }

      /**
       * Roda vertical rola a timeline na HORIZONTAL — o único eixo que ela tem.
       *
       * Sozinho o navegador só rola isto com `deltaX`, ou seja: trackpad de
       * dois dedos e Shift+roda. Um mouse de roda comum não teria como andar no
       * projeto ampliado, porque a barra de rolagem é de sobreposição e nem
       * sempre está lá pra ser arrastada.
       */
      if (!timelineView.scrollable) return;   // nada a rolar: a página que role
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      e.preventDefault();
      wrap.scrollLeft = clampScroll(
        wrap.scrollLeft + delta, timelineView.contentWidth, wrap.clientWidth,
      );
    };

    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, []);

  /**
   * O trecho visível, escrito direto no DOM.
   *
   * Não é enfeite: a barra de rolagem do navegador é de sobreposição e some
   * quando você não está rolando — some justamente no estado em que ela seria a
   * única coisa dizendo "tem mais projeto pra esse lado". Este rótulo é a
   * afordância que sobra, e de quebra diz ONDE você está, o que a barra nunca
   * disse.
   *
   * Escrita direta, como o timecode: rolar não pode custar render.
   */
  const paintRange = () => {
    const wrap = wrapRef.current;
    const el = rangeRef.current;
    if (!wrap || !el) return;
    // A duração sai do `player`, não do estado do React: o listener de rolagem
    // é registrado uma vez só e congelaria o valor que existia na montagem —
    // um projeto que virou 60s continuaria sendo anunciado como de 8s.
    const from = timelineView.timeAt(wrap.scrollLeft);
    const to = Math.min(timelineView.timeAt(wrap.scrollLeft + wrap.clientWidth), rulerSpanRef.current);
    el.textContent = `${from.toFixed(1)}–${to.toFixed(1)}s`;
  };

  // Roda depois de cada render (o zoom causa um) e a cada rolagem.
  useEffect(paintRange);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.addEventListener('scroll', paintRange, { passive: true });
    return () => wrap.removeEventListener('scroll', paintRange);
  }, []);

  /** Voltar pro fit leva a vista pro começo: com tudo à vista, rolagem não existe. */
  const fitAll = () => {
    timelineView.fit();
    if (wrapRef.current) wrapRef.current.scrollLeft = 0;
  };

  /** Zoom pelos botões: ancora no meio da vista, que é pra onde se está olhando. */
  const zoomBy = (dir: 1 | -1) => {
    const wrap = wrapRef.current;
    const before = timelineView.pxPerSecond;
    if (dir > 0) timelineView.zoomIn(); else timelineView.zoomOut();
    if (!wrap) return;
    const scroll = zoomAnchor(
      wrap.scrollLeft, wrap.clientWidth / 2, before, timelineView.pxPerSecond,
    );
    wrap.scrollLeft = clampScroll(scroll, timelineView.contentWidth, wrap.clientWidth);
  };

  /**
   * Play imediato por padrão; fiel quando você pede.
   *
   * Com `⚙ AUTO PRÉ-RENDER` ligado, um trecho que ainda não está inteiro no
   * cache é preparado ANTES de soltar o play — a reprodução sai então da mesma
   * composição quadro a quadro que o export. Desligado (o padrão), toca na hora
   * e o cache se enche com o que passar na tela. Ver `autoPrerender.ts`.
   */
  const handlePlay = async () => {
    if (preparing) { cancelPrerender(); return; }
    if (player.playing) { player.pause(); return; }

    const { from, to } = player.effectiveRange();

    if (autoPrerender.on && !isRangeCached(project, { from, to })) {
      player.seek(from);
      const scale = renderScale(viewport.zoom, window.devicePixelRatio || 1);
      const { cancelled } = await ensureRangeCached(project, { from, to, scale, frames: frameProvider });
      if (cancelled) return;   // você mandou parar: não sai reproduzindo sozinho
    }

    // Decidido UMA vez, aqui: o trecho inteiro sai do cache ou nada sai.
    // Misturar as duas origens quadro a quadro é o que faz o vídeo tremer.
    player.fromCache = isRangeCached(project, { from, to });

    /**
     * Tocando do cache o `<video>` não pinta nada, mas continua sendo a fonte
     * do SOM — por isso ele não é mais pausado aqui.
     *
     * Era: `if (player.fromCache) pauseAllVideo(project)`. Fazia sentido
     * enquanto o editor não tinha áudio; depois disso, era o que fazia o
     * pré-render reproduzir mudo. Quem conduz o elemento nessa situação é o
     * `syncSoundLayers` com `driveVideo`, e ele pausa sozinho o que estiver
     * em silêncio.
     */

    if (player.t < from || player.t >= to) player.seek(from);
    player.play();
  };

  playRef.current = handlePlay;

  /**
   * Transporte pelo teclado: espaço reproduz, setas andam quadro a quadro.
   *
   * O passo usa `stepFrame`, que pousa na grade — e não `t ± 1/fps`, que
   * arrastaria pra sempre um desalinhamento herdado de um arrasto do cursor.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // Ctrl/Cmd é de outros atalhos (undo, corte, zoom); não disputa.
      if (e.ctrlKey || e.metaKey) return;

      if (e.code === 'Space') {
        e.preventDefault();
        playRef.current?.();
        return;
      }

      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();

      // Andar quadro a quadro com o vídeo rodando não faz sentido: o relógio
      // desfaria o passo no quadro seguinte. Parar primeiro é o que todo
      // editor faz, e é o que você quis dizer ao apertar a seta.
      player.pause();
      // Shift dá o salto grande, pra atravessar o projeto sem soltar a tecla.
      const frames = e.shiftKey ? fpsRef.current : 1;
      player.seek(stepFrame(player.t, fpsRef.current, dir * frames));
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const scrub = (e: { clientX: number }) => {
    const ruler = rulerRef.current;
    if (!ruler) return;
    const r = ruler.getBoundingClientRect();
    player.seek(((e.clientX - r.left) / r.width) * player.duration);
  };

  const startScrub = (e: React.PointerEvent) => {
    // Sem isto o navegador ainda inicia a seleção de texto por baixo do
    // arrasto, e num trackpad chega a rolar a página junto.
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrub(e);
    const move = (ev: PointerEvent) => scrub(ev);
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  /** Drag an edge to trim. The maths lives in project.js so it can be tested. */
  const startTrim = (e: React.PointerEvent, layer: Layer, edge: 'left' | 'right') => {
    e.preventDefault();
    e.stopPropagation();          // don't also start a move drag
    onSelect(layer.id);

    const ruler = rulerRef.current;
    if (!ruler) return;
    const rect = ruler.getBoundingClientRect();
    const startX = e.clientX;
    const orig = { ...layer };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Os limites saem dos vizinhos da mesma faixa: esticar por cima do clipe
    // seguinte quebraria a invariante que sustenta a ordem de desenho.
    const bounds = freeWindow(project.layers, layer);

    const move = (ev: PointerEvent) => {
      const delta = ((ev.clientX - startX) / rect.width) * player.duration;
      const patch = edge === 'left'
        ? trimLeft(orig, delta, bounds)
        : trimRight(orig, delta, bounds);
      if (patch) onChange(layer.id, patch);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  /**
   * Arrastar um clipe: reposiciona no tempo E reordena entre faixas, no mesmo
   * gesto. É o que substituiu as setas ▲▼ do painel lateral.
   *
   * Nada é aplicado enquanto você arrasta. O clipe segue o ponteiro por
   * `transform` escrito direto no DOM e a faixa de destino acende — então o
   * gesto inteiro custa **zero re-render** do React, e a lista só é reordenada
   * uma vez, ao soltar. Reordenar a cada `pointermove` faria as faixas
   * saltarem debaixo do cursor, que é justamente o que torna esse tipo de
   * arrasto impossível de mirar.
   */
  const startClipDrag = (e: React.PointerEvent, layer: Layer) => {
    e.preventDefault();
    onSelect(layer.id);

    const ruler = rulerRef.current;
    const tracks = tracksRef.current;
    const clip = e.currentTarget as HTMLElement;
    if (!ruler || !tracks) return;

    const pxPerSecond = ruler.getBoundingClientRect().width / player.duration;
    const kind = trackKind(layer);

    // A altura da faixa sai do layout já aplicado, não de uma constante: assim
    // mexer no CSS não desalinha silenciosamente o cálculo do arrasto.
    // Só as faixas: o indicador de destino também é filho de `.tracks`.
    const trackEls = [...tracks.querySelectorAll<HTMLElement>('.track')];
    const first = trackEls[0];
    const second = trackEls[1];
    const pitch = first && second
      ? second.offsetTop - first.offsetTop
      : (first?.offsetHeight ?? 0);

    // Só o próprio tipo, e sem ele mesmo: um clipe de áudio não colide com um
    // de vídeo na "faixa 1", porque são faixas 1 diferentes.
    const others = layersOfKind(project.layers, kind)
      .filter(l => l.id !== layer.id)
      .map(l => ({ track: l.track, start: l.start, duration: l.duration }));

    const startX = e.clientX;
    const startY = e.clientY;
    /**
     * Faixa -> linha na tela. Os dois grupos são contíguos, então isto é só um
     * deslocamento — e é por isso que `clipDragPlan` não precisou mudar: o
     * arrasto continua acontecendo dentro do espaço de faixa do PRÓPRIO tipo, e
     * atravessar pro outro grupo simplesmente não é representável.
     */
    const rowOf = (track: number) => (
      kind === 'visual' ? flipOrder(track, visualRows) : visualRows + track
    );
    let plan = { start: layer.start, track: layer.track, insert: false, valid: true };

    clip.classList.add('clip-dragging');
    clip.setPointerCapture(e.pointerId);

    const drop = dropRef.current;
    if (drop && pitch > 0) {
      drop.style.height = `${first?.offsetHeight ?? 0}px`;
      drop.style.top = `${rowOf(layer.track) * pitch}px`;
      drop.classList.add('on');
    }

    const move = (ev: PointerEvent) => {
      plan = clipDragPlan({
        dx: ev.clientX - startX,
        dy: ev.clientY - startY,
        pxPerSecond,
        trackPitch: pitch,
        start: layer.start,
        track: layer.track,
        span: layer.duration,
        duration: rulerSpan,
        // A faixa vazia extra entra na conta: é ela que permite tirar um clipe
        // de uma faixa cheia e abrir uma nova, dentro do próprio tipo.
        maxTrack: topTrackOf(project.layers, kind) + 1,
        // Só o vídeo desenha as linhas invertidas — ver `clipDragPlan`.
        invertedRows: kind === 'visual',
        others,
      });

      // O clipe acompanha o plano JÁ arredondado na vertical, então ele encaixa
      // visivelmente na faixa em vez de flutuar entre duas.
      const dx = (plan.start - layer.start) * pxPerSecond;
      // Numa inserção o clipe fica NA FRONTEIRA entre as duas linhas, meia
      // altura acima da faixa que vai nascer — é o que faz o gesto parecer
      // "encaixando entre" em vez de pousando.
      const targetRow = rowOf(plan.track) + (plan.insert ? 0.5 : 0);
      const dy = (targetRow - rowOf(layer.track)) * pitch;
      clip.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
      clip.classList.toggle('clip-blocked', !plan.valid);

      if (drop) {
        drop.style.top = `${targetRow * pitch}px`;
        drop.style.height = plan.insert ? '4px' : `${first?.offsetHeight ?? 0}px`;
        // Linha fina entre as faixas = "abre uma nova aqui"; caixa cheia =
        // "pousa nesta". São ações diferentes e precisam parecer diferentes.
        drop.classList.toggle('inserting', plan.insert);
        // Avisar ANTES de soltar. Descobrir que o gesto não valeu só depois de
        // largar é o que faz esse tipo de arrasto parecer quebrado.
        drop.classList.toggle('blocked', !plan.valid);
      }
    };

    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);

      clip.classList.remove('clip-dragging', 'clip-blocked');
      clip.style.transform = '';
      drop?.classList.remove('on', 'blocked', 'inserting');

      // Destino ocupado: o clipe volta pro lugar em vez de empurrar ninguém.
      if (!plan.valid) return;
      const parado = plan.start === layer.start && plan.track === layer.track && !plan.insert;
      if (parado) return;

      onMoveClip(layer.id, { start: plan.start, track: plan.track, insert: plan.insert });
    };

    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  /**
   * Uma linha por faixa, de cima pra baixo, mais uma vazia no topo.
   *
   * A linha extra não é enfeite: sem ela não existe pra onde arrastar um clipe
   * que está numa faixa cheia, e faixas novas seriam impossíveis de criar
   * depois que tudo se juntasse. Ela tem a mesma altura das outras de
   * propósito — o cálculo do arrasto mede o espaçamento entre as duas
   * primeiras linhas e assume que ele vale pra todas.
   */
  const rows: Array<{ kind: TrackKind; track: number; clips: Layer[] }> = [];

  // Vídeo em cima, INVERTIDO — faixa maior desenha por cima, então aparece por
  // cima. Áudio embaixo, em ordem natural: ali o número não é profundidade, é
  // só identidade, e inverter só teria confundido.
  for (let track = topTrackOf(project.layers, 'visual') + 1; track >= 0; track--) {
    rows.push({
      kind: 'visual',
      track,
      clips: project.layers.filter(l => trackKind(l) === 'visual' && l.track === track),
    });
  }
  const visualRows = rows.length;
  for (let track = 0; track <= topTrackOf(project.layers, 'audio') + 1; track++) {
    rows.push({
      kind: 'audio',
      track,
      clips: project.layers.filter(l => trackKind(l) === 'audio' && l.track === track),
    });
  }

  // O passo das marcas sai do ZOOM, não da duração: é quanto espaço um rótulo
  // tem na tela que decide se ele cabe, e num projeto ampliado de 60s marcas de
  // 5 em 5 segundos ficariam a meia tela uma da outra.
  const step = tickStep(view.pxPerSecond);
  const ticks: number[] = [];
  // Índice vezes passo, e não soma acumulada: somar 0,1 trinta vezes não dá 3.
  for (let i = 0; i * step <= rulerSpan + 1e-6; i++) ticks.push(+(i * step).toFixed(3));

  return (
    <div className="timeline">
      <div className="transport">
        <button className={`btn btn-gold${playing ? ' on' : ''}`} onClick={handlePlay}>
          {preparing ? '✕ CANCELAR' : playing ? '❚❚ PAUSE' : '▶ PLAY'}
        </button>
        <button className="btn" onClick={() => player.seek(0)}>|◀ INÍCIO</button>
        <button className="btn" onClick={onSplit} title="Cortar no cursor (Ctrl+B)">✂ CORTAR</button>

        <div className="tc">
          <span ref={tcRef}>{fmt(player.t)}</span>
          <span className="tc-sep">/</span>
          <span>{fmt(duration)}</span>
        </div>

        <button
          className={`btn btn-sm${autoPre ? ' on' : ''}`}
          onClick={() => autoPrerender.toggle()}
          title="Ligado: prepara o trecho antes de tocar — demora, e reproduz igual ao arquivo exportado. Desligado: toca na hora."
        >
          ⚙ AUTO PRÉ-RENDER
        </button>

        <div className="tl-zoom">
          <button
            className="btn btn-sm"
            onClick={() => zoomBy(-1)}
            disabled={!view.scrollable}
            title="Menos zoom na timeline"
          >
            −
          </button>
          <button className="btn btn-sm" onClick={() => zoomBy(1)} title="Mais zoom na timeline (Ctrl + roda)">
            +
          </button>
          <button
            className={`btn btn-sm${view.scrollable ? '' : ' on'}`}
            onClick={fitAll}
            title="Mostrar o projeto inteiro"
          >
            TUDO
          </button>
          <span className="tl-range" ref={rangeRef} />
        </div>

        <div className="transport-spacer" />

        {/*
          Leitura, não campo. A duração saiu de "número que você digita" pra
          "onde termina o último clipe" — ver `projectDuration`. Digitá-la só
          servia pra deixar clipe de fora do export sem avisar.
        */}
        <label className="field-label" style={{ margin: 0 }}>Duração</label>
        <span className="tl-duration" title="Vai até o fim do último clipe">
          {fmt(duration)}
        </span>
      </div>

      {/*
        A janela que rola, e dentro dela o conteúdo de `duration × pxPerSecond`
        pixels. Clipes, marcas e cursor continuam posicionados em PORCENTAGEM
        do conteúdo — então dar zoom é mudar uma largura só, e nenhuma das
        contas de arrasto, trim ou scrub precisou mudar: todas medem o elemento
        de verdade com `getBoundingClientRect`, que já cresce junto.
      */}
      <div className="tl-wrap" ref={wrapRef}>
        <div className="tl-content" style={{ width: view.contentWidth }}>
          <div className="ruler" ref={rulerRef} onPointerDown={startScrub}>
            {(range.in !== null || range.out !== null) && (
              <div
                className="range-band"
                style={{
                  left: `${((range.in ?? 0) / rulerSpan) * 100}%`,
                  width: `${(((range.out ?? duration) - (range.in ?? 0)) / rulerSpan) * 100}%`,
                }}
              />
            )}
            {ticks.map(s => (
              <div key={s} className="tick" style={{ left: `${(s / rulerSpan) * 100}%` }}>
                {/*
                  Perto do fim o rótulo vira pra dentro. Solto, ele vazava pra
                  fora do conteúdo e criava ~28px de rolagem que não existia —
                  a timeline "cabendo inteira" e mesmo assim rolando um pouco.
                */}
                <span className={`tick-lab${s / rulerSpan > 0.9 ? ' tick-lab-end' : ''}`}>
                  {step < 1 ? s.toFixed(2) : s}s
                </span>
              </div>
            ))}
          </div>

        {/*
          As faixas saem na ordem VISUAL, espelho da ordem de desenho: a faixa
          0 desenha no fundo e aparece embaixo — a mesma convenção do painel de
          layers e do CapCut. Sem essa inversão, arrastar pra cima mandaria a
          layer pra trás.
        */}
        <div className="tracks" ref={tracksRef}>
          {rows.map(({ kind, track, clips }) => (
            <div
              className={
                'track'
                + (clips.length ? '' : ' track-empty')
                + (kind === 'audio' ? ' track-audio' : '')
                // A primeira linha de áudio ganha o traço que separa os grupos.
                + (kind === 'audio' && track === 0 ? ' track-audio-first' : '')
              }
              key={`${kind}:${track}`}
            >
              {clips.map(layer => (
                <div
                  key={layer.id}
                  className={
                    'clip' +
                    (layer.type === 'image' ? ' clip-img' : '') +
                    (layer.type === 'video' ? ' clip-video' : '') +
                    (layer.type === 'audio' ? ' clip-audio' : '') +
                    (layer.id === selectedId ? ' clip-sel' : '')
                  }
                  style={{
                    left: `${(layer.start / rulerSpan) * 100}%`,
                    width: `${(layer.duration / rulerSpan) * 100}%`,
                  }}
                  onPointerDown={e => startClipDrag(e, layer)}
                  title={`${layer.name} — arraste pra mover no tempo ou trocar de faixa`}
                >
                  <span
                    className="clip-handle clip-handle-l"
                    onPointerDown={e => startTrim(e, layer, 'left')}
                  />
                  {/*
                    A onda entra ATRÁS do nome, ocupando o corpo do clipe. É o
                    que faz cortar no ritmo virar mira visual em vez de
                    tentativa e erro — a batida e o silêncio entre as frases
                    estão no envelope, não no nome do arquivo.
                  */}
                  {layer.type === 'audio'
                    ? (
                      /*
                        Sem nome no clipe de áudio: o rótulo tapava justamente a
                        parte da onda onde o clipe começa, que é onde se mira pra
                        cortar. O nome continua no `title` do clipe e no painel
                        de props — ali ele não disputa espaço com a informação.
                      */
                      <Waveform layer={layer} />
                    )
                    : <span className="clip-name">{layer.name}</span>}
                  {/*
                    O som do clipe, visível e grudado nele. Não é uma layer
                    separada de propósito: a trilha de um vídeo anda junto com
                    a imagem, e uma faixa própria abriria a porta pra você
                    dessincronizar as duas sem querer.
                  */}
                  {hasSound(layer) && <span className="clip-sound" aria-hidden="true" />}
                  <span
                    className="clip-handle clip-handle-r"
                    onPointerDown={e => startTrim(e, layer, 'right')}
                  />
                </div>
              ))}
            </div>
          ))}
            <div className="track-drop" ref={dropRef} />
          </div>

          <div className="playhead" ref={headRef} />
        </div>
      </div>

      <PrerenderBar project={project} onMessage={onMessage} />
    </div>
  );
}

const fmt = (t: number) => `${t.toFixed(2)}s`;
