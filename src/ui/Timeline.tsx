import React, { useEffect, useRef, useState } from 'react';
import { player } from '../engine/player.ts';
import { trimLeft, trimRight } from '../engine/project.ts';
import { previewMode } from '../engine/previewMode.ts';
import { viewport, renderScale } from '../engine/viewport.ts';
import { ensureRangeCached, isRangeCached, prerenderStatus, cancelPrerender } from '../engine/prerender.ts';
import { pauseAllVideo } from '../engine/videoSync.ts';
import { PrerenderBar } from './PrerenderBar.tsx';
import { clipDragPlan, flipOrder } from '../engine/trackDrag.ts';
import { topTrack, freeWindow } from '../engine/project.ts';
import type { Layer, LayerPatch, Project } from '../engine/types.ts';

interface TimelineProps {
  project: Project;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onChange: (id: number, patch: LayerPatch) => void;
  /** Aplica o resultado de um arrasto: posição no tempo e faixa, de uma vez. */
  onMoveClip: (id: number, to: { start: number; track: number }) => void;
  /** Corta o clipe selecionado no cursor (Ctrl+B). */
  onSplit: () => void;
}

/**
 * Timeline + transport.
 *
 * The playhead bar and timecode are updated by writing to refs inside the
 * player's frame callback — never through setState — so dragging the playhead
 * across a 60s project costs zero React renders.
 */
export function Timeline({
  project, selectedId, onSelect, onChange, onMoveClip, onSplit,
}: TimelineProps) {
  const headRef = useRef<HTMLDivElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(player.playing);
  const [duration, setDuration] = useState(player.duration);
  const [fast, setFast] = useState(previewMode.fast);
  const [range, setRange] = useState<{ in: number | null; out: number | null }>(
    () => ({ in: player.rangeIn, out: player.rangeOut }),
  );
  const [preparing, setPreparing] = useState(prerenderStatus.running);

  // Guarda o handler de play: o atalho de teclado precisa enxergar o estado
  // atual sem religar o listener a cada render.
  const playRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const unsubFrame = player.onFrame(t => {
      const pct = (t / player.duration) * 100;
      if (headRef.current) headRef.current.style.left = `${pct}%`;
      if (tcRef.current) tcRef.current.textContent = fmt(t);
    });
    const unsubState = player.onState(p => {
      setPlaying(p.playing);
      setDuration(p.duration);
      setRange({ in: p.rangeIn, out: p.rangeOut });
    });
    const unsubMode = previewMode.subscribe(setFast);
    const unsubPre = prerenderStatus.subscribe(s => setPreparing(s.running));
    return () => { unsubFrame(); unsubState(); unsubMode(); unsubPre(); };
  }, []);

  /**
   * Play com fidelidade: se o trecho ainda não está inteiro no cache, prepara
   * primeiro e só então reproduz. Foi a escolha explícita — esperar um pouco é
   * aceitável, reproduzir com buraco e tremendo não é.
   *
   * `⚡ FAST` é a saída pra quando você quer o contrário: reproduz na hora,
   * aceitando qualidade menor.
   */
  const handlePlay = async () => {
    if (preparing) { cancelPrerender(); return; }
    if (player.playing) { player.pause(); return; }

    const { from, to } = player.effectiveRange();

    if (!previewMode.fast && !isRangeCached(project, { from, to })) {
      player.seek(from);
      const scale = renderScale(viewport.zoom, window.devicePixelRatio || 1);
      const { cancelled } = await ensureRangeCached(project, { from, to, scale });
      if (cancelled) return;   // você mandou parar: não sai reproduzindo sozinho
    }

    // Decidido UMA vez, aqui: o trecho inteiro sai do cache ou nada sai.
    // Misturar as duas origens quadro a quadro é o que faz o vídeo tremer.
    player.fromCache = isRangeCached(project, { from, to });

    // Tocando do cache o `<video>` não pinta nada — deixá-lo rodando só
    // gastaria decoder e o faria derivar do relógio à toa.
    if (player.fromCache) pauseAllVideo(project);

    if (player.t < from || player.t >= to) player.seek(from);
    player.play();
  };

  playRef.current = handlePlay;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        playRef.current?.();
      }
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

    // A altura da faixa sai do layout já aplicado, não de uma constante: assim
    // mexer no CSS não desalinha silenciosamente o cálculo do arrasto.
    // Só as faixas: o indicador de destino também é filho de `.tracks`.
    const trackEls = [...tracks.querySelectorAll<HTMLElement>('.track')];
    const first = trackEls[0];
    const second = trackEls[1];
    const pitch = first && second
      ? second.offsetTop - first.offsetTop
      : (first?.offsetHeight ?? 0);

    // Todo mundo menos o próprio arrastado — senão ele colidiria consigo mesmo.
    const others = project.layers
      .filter(l => l.id !== layer.id)
      .map(l => ({ track: l.track, start: l.start, duration: l.duration }));

    const startX = e.clientX;
    const startY = e.clientY;
    const rowOf = (track: number) => flipOrder(track, rows.length);
    let plan = { start: layer.start, track: layer.track, valid: true };

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
        duration: player.duration,
        // A faixa vazia do topo entra na conta: é ela que permite tirar um
        // clipe de uma faixa cheia e abrir uma nova.
        maxTrack: topTrack(project.layers) + 1,
        others,
      });

      // O clipe acompanha o plano JÁ arredondado na vertical, então ele encaixa
      // visivelmente na faixa em vez de flutuar entre duas.
      const dx = (plan.start - layer.start) * pxPerSecond;
      const dy = (rowOf(plan.track) - rowOf(layer.track)) * pitch;
      clip.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
      clip.classList.toggle('clip-blocked', !plan.valid);

      if (drop) {
        drop.style.top = `${rowOf(plan.track) * pitch}px`;
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
      drop?.classList.remove('on', 'blocked');

      // Destino ocupado: o clipe volta pro lugar em vez de empurrar ninguém.
      if (!plan.valid) return;
      if (plan.start !== layer.start || plan.track !== layer.track) {
        onMoveClip(layer.id, { start: plan.start, track: plan.track });
      }
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
  const rows: Array<{ track: number; clips: Layer[] }> = [];
  for (let track = topTrack(project.layers) + 1; track >= 0; track--) {
    rows.push({ track, clips: project.layers.filter(l => l.track === track) });
  }

  const step = duration > 20 ? 5 : duration > 10 ? 2 : 1;
  const ticks: number[] = [];
  for (let s = 0; s <= duration; s += step) ticks.push(s);

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
          className={`btn btn-sm${fast ? ' on' : ''}`}
          onClick={() => previewMode.toggle()}
          title="Ligado: reproduz na hora, com qualidade menor. Desligado: prepara o trecho antes e reproduz liso e fiel."
        >
          ⚡ FAST
        </button>

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
          {(range.in !== null || range.out !== null) && (
            <div
              className="range-band"
              style={{
                left: `${((range.in ?? 0) / duration) * 100}%`,
                width: `${(((range.out ?? duration) - (range.in ?? 0)) / duration) * 100}%`,
              }}
            />
          )}
          {ticks.map(s => (
            <div key={s} className="tick" style={{ left: `${(s / duration) * 100}%` }}>
              <span className="tick-lab">{s}s</span>
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
          {rows.map(({ track, clips }) => (
            <div className={`track${clips.length ? '' : ' track-empty'}`} key={track}>
              {clips.map(layer => (
                <div
                  key={layer.id}
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
                  title={`${layer.name} — arraste pra mover no tempo ou trocar de faixa`}
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
              ))}
            </div>
          ))}
          <div className="track-drop" ref={dropRef} />
        </div>

        <div className="playhead" ref={headRef} />
      </div>

      <PrerenderBar project={project} />
    </div>
  );
}

const fmt = (t: number) => `${t.toFixed(2)}s`;
