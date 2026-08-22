import { useEffect, useState } from 'react';
import { player } from '../engine/player.ts';
import { viewport, renderScale } from '../engine/viewport.ts';
import { ensureRangeCached, prerenderStatus, cancelPrerender } from '../engine/prerender.ts';
import { frameCache, signatureOf, estimateRange, formatBytes } from '../engine/frameCache.ts';
import { PREVIEW_CACHE_ENABLED } from '../engine/frameSource.ts';
import { mediaBlob } from '../engine/mediaStore.ts';
import {
  exportVideo, cancelExport, exportStatus, exportSupport, downloadBlob,
} from '../engine/videoExport.ts';
import { QUALIDADES } from '../engine/exportPlan.ts';
import type { Qualidade } from '../engine/exportPlan.ts';
import type { Project } from '../engine/types.ts';

interface PrerenderBarProps {
  project: Project;
  onMessage: (text: string) => void;
}

/** Progresso de um trabalho em curso. null = parado. */
interface Progress {
  done: number;
  total: number;
}

/**
 * Controles de trecho (in/out) e pré-render.
 *
 * O pré-render é assíncrono e cancelável: um trecho longo pode levar bastante
 * tempo, e prender o usuário até acabar seria pior que a lentidão original.
 */
export function PrerenderBar({ project, onMessage }: PrerenderBarProps) {
  const [range, setRange] = useState(() => player.effectiveRange());
  const [hasRange, setHasRange] = useState(player.hasRange);
  const [progress, setProgress] = useState<Progress | null>(null);
  /**
   * Qualidade do export, guardada por usuário.
   *
   * Em `localStorage` e não no projeto: é preferência de quem exporta, não
   * conteúdo do vídeo — a mesma regra que vale pro tema (ver ideias/temas.md).
   */
  const [qualidade, setQualidade] = useState<Qualidade>(() => {
    try {
      const guardada = localStorage.getItem('fragmento:qualidade-export');
      return QUALIDADES.includes(guardada as Qualidade) ? guardada as Qualidade : 'normal';
    } catch { return 'normal'; }
  });

  useEffect(() => {
    try { localStorage.setItem('fragmento:qualidade-export', qualidade); } catch { /* anônimo */ }
  }, [qualidade]);
  const [cached, setCached] = useState(0);
  // A estimativa de memória depende do zoom (é ele que define a resolução de
  // render). Sem escutar o viewport, o aviso fica congelado no zoom inicial e
  // passa a mentir — chegou a acusar "1.9 GB, não cabe" num trecho que cabia.
  const [zoom, setZoom] = useState(viewport.zoom);
  const [exporting, setExporting] = useState<Progress | null>(null);

  useEffect(() => viewport.subscribe(v => setZoom(v.zoom)), []);

  useEffect(() => exportStatus.subscribe(s => {
    setExporting(s.running ? { done: s.done, total: s.total } : null);
  }), []);

  useEffect(() => {
    const unsub = player.onState(p => {
      setRange(p.effectiveRange());
      setHasRange(p.hasRange);
      // A reprodução vai guardando frames sozinha; dar play/pause é o momento
      // natural de reconferir o contador sem precisar vigiá-lo todo frame.
      setCached(frameCache.size);
    });
    return unsub;
  }, []);

  // O cache morre sozinho quando o projeto muda (a assinatura deixa de bater),
  // mas o contador na tela precisa acompanhar isso pra não mentir.
  useEffect(() => {
    const sig = signatureOf(project);
    setCached(frameCache.signature === sig ? frameCache.size : 0);
  }, [project]);

  const running = progress !== null;   // null = parado
  const scale = renderScale(zoom, window.devicePixelRatio || 1);

  // O pré-render pode ser disparado daqui OU pelo botão de play, então o
  // progresso vem do estado compartilhado em vez de um estado local só desta barra.
  useEffect(() => {
    return prerenderStatus.subscribe(s => {
      setProgress(s.running ? { done: s.done, total: s.total } : null);
      if (!s.running) {
        setCached(frameCache.size);
        player.invalidate();
      }
    });
  }, []);

  const start = async () => {
    if (running) return;
    const { from, to } = player.effectiveRange();
    player.pause();
    await ensureRangeCached(project, { from, to, scale });
  };

  const cancel = () => cancelPrerender();

  /**
   * Exporta o trecho marcado, sempre em resolução CHEIA.
   *
   * A escala do preview (que segue o zoom, pra render barato) não entra aqui:
   * o arquivo final é o produto, e ninguém quer entregar um vídeo na resolução
   * que por acaso deixava o preview fluido na hora.
   */
  const startExport = async () => {
    const support = exportSupport();
    if (!support.ok) return onMessage(support.reason ?? 'Export indisponível');

    const { from, to } = player.effectiveRange();
    player.pause();

    try {
      const result = await exportVideo(project, { from, to, scale: 1, qualidade, getBlob: mediaBlob });
      if (!result) return onMessage('Export cancelado');

      downloadBlob(result.blob, result.fileName);

      // Faixa que não decodificou some do arquivo, e antes sumia calada: você
      // só descobria assistindo. O aviso vem na frente do resumo porque é a
      // parte que pede uma ação sua.
      if (result.audioSkipped) return onMessage(result.audioSkipped);
      if (result.audioFailed.length) {
        return onMessage(`Sem o som de: ${result.audioFailed.join(', ')}`);
      }

      onMessage(
        `${result.frames} quadros em ${result.codec}${result.hasAudio ? ' com áudio' : ' (sem áudio)'}`,
      );
    } catch (err) {
      onMessage(err instanceof Error ? err.message : 'Falhou ao exportar');
    } finally {
      // O preview parou de desenhar enquanto o export era dono dos <video>.
      player.invalidate();
    }
  };

  const clearCache = () => {
    frameCache.clear();
    setCached(0);
    player.invalidate();
  };

  const pct = progress?.total
    ? Math.round((progress.done / progress.total) * 100)
    : 0;

  const exportPct = exporting?.total
    ? Math.round((exporting.done / exporting.total) * 100)
    : 0;

  const estimate = estimateRange({
    width: project.width,
    height: project.height,
    scale,
    seconds: range.to - range.from,
    fps: project.fps,
    budget: frameCache.budgetBytes,
  });

  return (
    <div className="prerender">
      <span className="field-label" style={{ margin: 0 }}>Trecho</span>

      <button className="btn btn-sm" onClick={() => player.markIn()} title="Marcar início no cursor">
        [ IN
      </button>
      <button className="btn btn-sm" onClick={() => player.markOut()} title="Marcar fim no cursor">
        OUT ]
      </button>
      <button className="btn btn-sm" onClick={() => player.clearRange()} disabled={!hasRange}>
        ✕
      </button>

      <span className="prerender-range">
        {range.from.toFixed(2)}s → {range.to.toFixed(2)}s
      </span>

      {exporting ? (
        <>
          <div className="prerender-progress">
            <div
              className="prerender-progress-fill is-export"
              style={{ width: `${exportPct}%` }}
            />
            <span className="prerender-progress-label">EXPORTANDO {exportPct}%</span>
          </div>
          <button className="btn btn-sm btn-coral" onClick={cancelExport}>PARAR</button>
        </>
      ) : running ? (
        <>
          <div className="prerender-progress">
            <div className="prerender-progress-fill" style={{ width: `${pct}%` }} />
            <span className="prerender-progress-label">{pct}%</span>
          </div>
          <button className="btn btn-sm btn-coral" onClick={cancel}>PARAR</button>
        </>
      ) : (
        <>
          {/*
            Marcar trecho e EXPORTAR continuam; o pré-render e a conta de
            memória dele saem enquanto `PREVIEW_CACHE_ENABLED` é falso — o
            preview desenha ao vivo, então encher o cache não mudaria o que
            você vê. Voltam junto com ele.
          */}
          {PREVIEW_CACHE_ENABLED && (
            <button className="btn btn-sm btn-gold" onClick={start}>⚙ PRÉ-RENDER</button>
          )}
          {/*
            A qualidade fica ao lado do botão, não escondida: grão de filme e
            desfoque pesado quebram em macrobloco no `normal`, e a pessoa
            precisa poder resolver isso sem descobrir sozinha que o problema
            era bitrate. Ver `BITS_POR_PIXEL` em exportPlan.ts.
          */}
          <select
            className="inp inp-qualidade"
            value={qualidade}
            onChange={e => setQualidade(e.target.value as Qualidade)}
            title="Quanto bit gastar. Grão e desfoque pesado pedem ALTA."
          >
            {QUALIDADES.map(q => <option key={q} value={q}>{q}</option>)}
          </select>
          <button className="btn btn-sm btn-mint" onClick={startExport}>⬛ EXPORTAR</button>
          {PREVIEW_CACHE_ENABLED && (
            <span className={`prerender-est${estimate.fits ? '' : ' over'}`}>
              {estimate.fits
                ? `≈ ${formatBytes(estimate.bytes)}`
                : `≈ ${formatBytes(estimate.bytes)} — não cabe, marque até ~${estimate.maxSeconds.toFixed(1)}s`}
            </span>
          )}
          {PREVIEW_CACHE_ENABLED && cached > 0 && (
            <>
              <span className="prerender-cached" title="Frames prontos na memória">
                {cached} frames
              </span>
              <button className="btn btn-sm" onClick={clearCache} title="Limpar cache">
                LIMPAR
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
