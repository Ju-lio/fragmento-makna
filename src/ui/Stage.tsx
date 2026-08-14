import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { player } from '../engine/player.ts';
import { viewport, renderScale } from '../engine/viewport.ts';
import { previewMode } from '../engine/previewMode.ts';
import { previewStatus } from '../engine/previewStatus.ts';
import { drawFrame } from '../engine/renderer.ts';
import {
  syncVideoLayers, previewBusyState, hasActiveVideo, videoElementsOwner,
} from '../engine/videoSync.ts';
import { frameCache, signatureOf, frameIndexAt } from '../engine/frameCache.ts';
import { pickFrameSource } from '../engine/frameSource.ts';
import { StageBar } from './StageBar.tsx';
import { Gizmo } from './Gizmo.tsx';
import type { LayerPatch, Project } from '../engine/types.ts';

interface StageProps {
  project: Project;
  onResize: (width: number, height: number) => void;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onChange: (id: number, patch: LayerPatch, coalesce?: boolean) => void;
}

/**
 * The canvas viewport.
 *
 * Note what is NOT here: no per-frame React state, and no per-pointer-event
 * React state. The component mounts, subscribes to the player, and paints
 * straight to the canvas. Playing back, scrubbing and panning all re-render
 * exactly nothing.
 */
export function Stage({ project, onResize, selectedId, onSelect, onChange }: StageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const projectRef = useRef(project);
  const resRef = useRef({ w: 0, h: 0 });   // last physical resolution actually applied
  const [busy, setBusy] = useState<string | null>(null);   // null = nada a mostrar

  projectRef.current = project;

  // --- paint loop -------------------------------------------------------
  useEffect(() => {
    const canvasEl = canvasRef.current;
    const ctx = canvasEl?.getContext('2d');
    if (!canvasEl || !ctx) return;

    /**
     * Guarda o frame que acabou de ser desenhado, pra que voltar nele depois
     * seja de graça. É isto que faz "assisti o clipe, agora clico no meio dele
     * e vejo na hora" funcionar sem ninguém ter que apertar pré-render.
     *
     * `createImageBitmap` é assíncrono, então mantemos no máximo uma captura
     * em voo: sem esse limite, uma reprodução longa enfileiraria centenas de
     * cópias pendentes e a captura viraria o próprio gargalo.
     *
     * Nota: o frame é guardado no índice mais próximo, mas foi desenhado no
     * instante exato do rAF. A diferença é de no máximo meio quadro (~17ms) —
     * imperceptível num preview, e o preço de não engessar a reprodução na
     * grade do cache.
     */
    let capturing = false;
    const captureFrame = (sig: string, index: number, degraded: boolean) => {
      if (capturing) return;
      if (frameCache.has(sig, index, { allowDegraded: degraded })) return;

      capturing = true;
      const bytes = canvasEl.width * canvasEl.height * 4;

      createImageBitmap(canvasEl)
        .then(bitmap => { frameCache.set(sig, index, bitmap, bytes, { degraded }); })
        .catch(() => { /* captura é oportunista: falhar só significa recompor depois */ })
        .finally(() => { capturing = false; });
    };
    const unsub = player.onFrame((rawT: number) => {
      /**
       * Alguém está posicionando os `<video>` quadro a quadro: sai da frente.
       *
       * Vale pro pré-render e pro export, que levam cada elemento ao instante
       * exato e esperam o `seeked` antes de capturar — enquanto este loop os
       * empurraria de volta pra posição do cursor. O resultado eram quadros
       * gravados com o vídeo no lugar errado, e a reprodução saía pulando pra
       * frente e voltando, só nas layers de vídeo.
       *
       * A pergunta é sobre a POSSE, não sobre qual trabalho está rodando: é a
       * condição real, e um trabalho novo que reivindique os elementos passa a
       * ser respeitado sem ninguém precisar lembrar de vir aqui.
       *
       * (O gatilho era sutil: o vídeo em `seeking` acendia a barra de
       * atividade, que re-renderiza este componente, que invalida o quadro,
       * que trazia o loop de volta pra brigar pelo elemento.)
       */
      if (videoElementsOwner() !== null) return;

      const project = projectRef.current;
      const sig = signatureOf(project);
      const fps = project.fps;

      /**
       * Renderiza SEMPRE no instante da grade, nunca no tempo bruto do rAF.
       *
       * Isso não é detalhe: um frame vindo do cache foi gerado no tempo da
       * grade, e um recém-renderizado sairia no tempo exato do rAF. Alternar
       * entre os dois faz o tempo andar pra trás e pra frente entre quadros
       * consecutivos — a imagem "tremendo" mesmo com todos os frames corretos.
       * Fixando a grade, cache e render viram a mesma coisa e ficam
       * intercambiáveis.
       */
      const fastPreview = previewMode.fast || player.playing;

      const { index, t, useCache } = pickFrameSource({
        rawT,
        fps,
        playing: player.playing,
        fromCache: player.fromCache,
        hasCached: i => frameCache.has(sig, i, { allowDegraded: fastPreview }),
      });

      if (useCache) {
        const bitmap = frameCache.get(sig, index, { allowDegraded: fastPreview });
        if (bitmap) {
          ctx.drawImage(bitmap, 0, 0, ctx.canvas.width, ctx.canvas.height);
          return;
        }
      }

      /**
       * Furo no meio de uma reprodução vinda do cache.
       *
       * Renderizar ao vivo aqui seria pior que não desenhar: os `<video>`
       * estão pausados (não são a fonte da imagem nesta reprodução), então o
       * quadro sairia com o vídeo num instante errado — e é exatamente essa
       * alternância que faz a imagem pular pra frente e voltar.
       *
       * Segurar o quadro anterior transforma o defeito num congelamento de um
       * quadro, que quase não se percebe.
       */
      if (player.playing && player.fromCache) return;

      // Nudge the <video> elements onto the clock, then paint whatever
      // frame they are currently holding.
      syncVideoLayers(project, t);
      const { degraded } = drawFrame(ctx, project, t, { fastPreview });

      /**
       * Reproduzindo ao vivo, o `<video>` corre no relógio dele e só é
       * corrigido quando desvia mais de 80ms. O quadro capturado aí serve
       * pra reexibir, mas não é fiel ao instante da grade — então entra como
       * degradado, e o pré-render vai regerá-lo com o seek exato.
       */
      const videoApprox = player.playing && hasActiveVideo(project, t);
      captureFrame(sig, index, degraded || videoApprox);
    });
    player.invalidate();
    return unsub;
  }, []);

  // Sonda de atividade: precisa rodar mesmo nos frames pulados, porque é
  // justamente enquanto a tela está parada esperando o decoder que a barra
  // tem que decidir se aparece. Só lê propriedades do <video>, não desenha.
  useEffect(() => {
    const unsubTick = player.onTick((t: number) => {
      // Durante pré-render ou export quem comunica é a barra de progresso, que
      // sabe exatamente quanto falta. Acender a barra genérica aqui, além de
      // redundante, re-renderizava este componente e reacordava o loop de
      // desenho no meio do trabalho.
      if (videoElementsOwner() !== null) { previewStatus.report(false); return; }

      // Frame que vem do cache não espera por nada — mesmo que o <video> por
      // trás ainda esteja buscando, não é uma espera que você percebe.
      const project = projectRef.current;
      const allowDegraded = previewMode.fast || player.playing;
      if (frameCache.get(signatureOf(project), frameIndexAt(t, project.fps), { allowDegraded })) {
        previewStatus.report(false);
        return;
      }
      const { busy: isBusy, reason } = previewBusyState(projectRef.current, t);
      previewStatus.report(isBusy, reason);
    });
    // A barra só re-renderiza nas transições — o report() acima roda 60x por
    // segundo, mas o store filtra e só avisa quando a visibilidade muda.
    const unsubStatus = previewStatus.subscribe(s => setBusy(s.visible ? s.reason : null));
    return () => { unsubTick(); unsubStatus(); };
  }, []);

  // Any project edit must trigger exactly one repaint.
  useEffect(() => { player.invalidate(); });

  // Flipping the fast-preview toggle, or starting/stopping playback, must
  // repaint immediately — otherwise you'd see the old quality until the next
  // unrelated change happened to invalidate the frame.
  useEffect(() => {
    const unsubMode = previewMode.subscribe(() => player.invalidate());
    const unsubState = player.onState(() => player.invalidate());
    return () => { unsubMode(); unsubState(); };
  }, []);

  // --- physical resolution --------------------------------------------
  // The canvas's CSS size (how big it LOOKS) stays pinned to the composition's
  // logical size via the style prop below — the zoom transform on .stage-holder
  // takes it from there, unchanged. What we adjust here is the backing store
  // resolution (how many physical pixels drawFrame actually has to touch),
  // which is what makes a preview that's visually tiny also cheap to render.
  // See renderScale() in viewport.js for why this is safe to do losslessly.
  useLayoutEffect(() => {
    // Layout effect, not a regular one: this must land before the browser's
    // first paint, or the canvas briefly shows at its 300x150 default and
    // stretches to fill the CSS box until this catches up.
    const applyResolution = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const dpr = window.devicePixelRatio || 1;
      const scale = renderScale(viewport.zoom, dpr);
      const w = Math.max(1, Math.round(projectRef.current.width * scale));
      const h = Math.max(1, Math.round(projectRef.current.height * scale));

      // Setting canvas.width/height clears it even when set to the same
      // value, so guard against redundant work on sub-pixel zoom deltas.
      if (w === resRef.current.w && h === resRef.current.h) return;
      resRef.current = { w, h };

      canvas.width = w;
      canvas.height = h;
      player.invalidate();
    };

    applyResolution();
    const unsub = viewport.subscribe(applyResolution);
    return unsub;
  }, [project.width, project.height]);

  // --- viewport sizing --------------------------------------------------
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const applyTransform = () => {
      if (holderRef.current) holderRef.current.style.transform = viewport.transform();
    };

    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      viewport.setContainer(width, height);
      applyTransform();
    });
    ro.observe(wrap);

    const unsub = viewport.subscribe(applyTransform);
    applyTransform();

    return () => { ro.disconnect(); unsub(); };
  }, []);

  // Resolution changes update the viewport's notion of content size, which
  // in turn refits (if in fit mode) and feeds the physical-resolution effect
  // above.
  useEffect(() => {
    viewport.setContent(project.width, project.height);
    player.invalidate();
  }, [project.width, project.height]);

  // --- pan --------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    const panButton = e.button === 1 || e.button === 0;
    if (!panButton || !viewport.pannable) return;
    e.preventDefault();

    let lastX = e.clientX;
    let lastY = e.clientY;
    wrapRef.current?.classList.add('grabbing');

    const move = (ev: PointerEvent) => {
      viewport.panBy(ev.clientX - lastX, ev.clientY - lastY);
      lastX = ev.clientX;
      lastY = ev.clientY;
      // Direct DOM write — a pan drag costs zero React renders.
      if (holderRef.current) holderRef.current.style.transform = viewport.transform();
    };
    const up = () => {
      wrapRef.current?.classList.remove('grabbing');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  // --- wheel: scroll pans, ctrl+scroll zooms at the cursor ---------------
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();

      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0015);
        viewport.setZoom(viewport.zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
      } else if (viewport.pannable) {
        viewport.panBy(-e.deltaX, -e.deltaY);
        if (holderRef.current) holderRef.current.style.transform = viewport.transform();
      }
    };
    // passive:false so preventDefault actually stops the page from zooming.
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // --- keyboard ---------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!(e.ctrlKey || e.metaKey)) return;

      if (e.key === '=' || e.key === '+') { e.preventDefault(); viewport.zoomIn(); }
      else if (e.key === '-') { e.preventDefault(); viewport.zoomOut(); }
      else if (e.key === '0') { e.preventDefault(); viewport.fit(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="stage">
      <div className="stage-viewport" ref={wrapRef} onPointerDown={onPointerDown}>
        {busy && (
          <div className="busybar" role="status" aria-live="polite">
            <div className="busybar-track"><div className="busybar-fill" /></div>
            <span className="busybar-label">{busy}</span>
          </div>
        )}
        <div className="stage-holder" ref={holderRef}>
          <canvas
            ref={canvasRef}
            style={{ width: project.width, height: project.height }}
            className="stage-canvas"
          />
          {/*
            Dentro do holder, junto do canvas: o holder já carrega a transform
            do viewport, então o gizmo escreve em pixels lógicos e o navegador
            põe no lugar — sem nenhuma conta de zoom no posicionamento.
          */}
          <Gizmo
            project={project}
            selectedId={selectedId}
            onSelect={onSelect}
            onChange={onChange}
          />
        </div>
      </div>
      <StageBar project={project} onResize={onResize} />
    </div>
  );
}
