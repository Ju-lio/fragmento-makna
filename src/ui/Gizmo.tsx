import { useEffect, useRef, useState } from 'react';
import { player } from '../engine/player.ts';
import { viewport } from '../engine/viewport.ts';
import { resolveState } from '../engine/effects.ts';
import { drawOrder } from '../engine/project.ts';
import {
  layerBox, layerCenter, pickLayer,
  scaleFactor, rotationDelta, normalizeAngle, snapAngle,
  snapToCenter, CENTER_SNAP_PX,
} from '../engine/gizmo.ts';
import type { Point } from '../engine/gizmo.ts';
import type { LayerPatch, Project, VisualLayer } from '../engine/types.ts';

/**
 * Alças de posicionar, escalar e girar, direto no palco.
 *
 * Mora **dentro** da `.stage-holder`, junto do canvas, e é isso que dispensa
 * toda conta de zoom no posicionamento: o holder já carrega a `transform` do
 * viewport, então basta escrever tudo em pixels LÓGICOS da composição e o
 * navegador põe no lugar. A única coisa que precisa desfazer o zoom são as
 * alças em si — uma alça de 10px viraria 2px a 25% —, e isso é uma variável CSS.
 *
 * Como o resto do editor, o gesto não passa pelo React: enquanto você arrasta,
 * o patch vai direto pro projeto e a moldura é reposicionada pelo render que
 * isso causa. O que NÃO acontece aqui é um `setState` por `pointermove`.
 */

interface GizmoProps {
  project: Project;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onChange: (id: number, patch: LayerPatch, coalesce?: boolean) => void;
}

/** Folga do acerto, em pixels da composição. Texto fino é impossível de pegar sem isso. */
const HIT_PAD = 14;

/** Nenhuma layer some de vez: abaixo disso a alça não teria como voltar. */
const MIN_SCALE = 0.02;

type Handle = 'nw' | 'ne' | 'se' | 'sw';
const HANDLES: Handle[] = ['nw', 'ne', 'se', 'sw'];

export function Gizmo({ project, selectedId, onSelect, onChange }: GizmoProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const projectRef = useRef(project);
  projectRef.current = project;

  /**
   * Qual guia de centro mostrar ENQUANTO um arrasto está grudado — `false`/
   * `false` fora de arrasto. Não dá pra derivar isso de `layer.x === 0`: uma
   * layer deixada exatamente no centro mostraria a guia pra sempre, parada,
   * mesmo sem ninguém arrastando nada.
   */
  const [guide, setGuide] = useState({ x: false, y: false });

  // O cursor mexe na moldura (efeitos animam posição e escala), então ela
  // acompanha o relógio. Redesenha só quando o quadro é repintado.
  useEffect(() => player.onFrame(() => bump(n => n + 1)), []);
  useEffect(() => viewport.subscribe(() => bump(n => n + 1)), []);

  /** Medidor de texto próprio: o canvas do palco está ocupado desenhando. */
  const measureRef = useRef<CanvasRenderingContext2D | null>(null);
  if (!measureRef.current && typeof document !== 'undefined') {
    measureRef.current = document.createElement('canvas').getContext('2d');
  }
  const measure = (line: string, font: string) => {
    const ctx = measureRef.current;
    if (!ctx) return 0;
    ctx.font = font;
    return ctx.measureText(line).width;
  };

  const t = player.t;
  const visible = drawOrder(project).filter(
    l => t >= l.start && t <= l.start + l.duration,
  );
  const selected = visible.find(l => l.id === selectedId) ?? null;

  /** Ponto de tela -> pixel lógico da composição. Uma divisão pelo zoom, e só. */
  const toComposition = (e: { clientX: number; clientY: number }): Point => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (e.clientX - rect.left) / viewport.zoom,
      y: (e.clientY - rect.top) / viewport.zoom,
    };
  };

  /**
   * Clique no palco: seleciona a layer da frente sob o ponteiro e já começa a
   * arrastar. Selecionar e só então poder mover exigiria dois gestos pro que a
   * pessoa entende como um.
   */
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const point = toComposition(e);
    const hit = pickLayer(
      visible, point, project, measure, l => resolveState(l, player.t), t, HIT_PAD,
    );
    if (!hit) return;   // vazio: deixa passar pro pan do viewport

    e.preventDefault();
    e.stopPropagation();
    if (hit.id !== selectedId) onSelect(hit.id);
    startMove(e, hit, point);
  };

  /**
   * Move a layer, grudando no centro da composição quando a mão chega perto.
   *
   * Alt desliga o ímã — mesmo gesto do arrasto na timeline — pra quando você
   * QUER deixar 3px fora do centro e o ímã insiste em puxar de volta.
   */
  const startMove = (e: React.PointerEvent, layer: VisualLayer, from: Point) => {
    const origin = { x: layer.x, y: layer.y };
    drag(e, (to, ev) => {
      const rawX = Math.round(origin.x + (to.x - from.x));
      const rawY = Math.round(origin.y + (to.y - from.y));
      const snap = ev.altKey
        ? { x: rawX, y: rawY, snapX: false, snapY: false }
        : snapToCenter(rawX, rawY, CENTER_SNAP_PX / viewport.zoom);
      setGuide({ x: snap.snapX, y: snap.snapY });
      onChange(layer.id, { x: snap.x, y: snap.y });
    }, () => setGuide({ x: false, y: false }));
  };

  const startScale = (e: React.PointerEvent, layer: VisualLayer) => {
    e.preventDefault();
    e.stopPropagation();
    const st = resolveState(layer, player.t);
    const center = layerCenter(project, st);
    const from = toComposition(e);
    // O tamanho de base, não o resolvido: escalar tem que escrever no campo do
    // modelo, e o que os efeitos somam por cima continua sendo deles.
    const base = layer.type === 'text' ? layer.size : layer.fit;

    drag(e, to => {
      const factor = Math.max(MIN_SCALE, scaleFactor(from, to, center, st.rotate));
      const next = base * factor;
      onChange(
        layer.id,
        layer.type === 'text'
          ? { size: Math.max(1, Math.round(next)) }
          : { fit: Math.max(0.01, +next.toFixed(3)) },
      );
    });
  };

  const startRotate = (e: React.PointerEvent, layer: VisualLayer) => {
    e.preventDefault();
    e.stopPropagation();
    const st = resolveState(layer, player.t);
    const center = layerCenter(project, st);
    const from = toComposition(e);
    const base = layer.rotate;

    drag(e, (to, ev) => {
      const delta = rotationDelta(from, to, center);
      // Shift prende de 15 em 15 — o passo que todo editor usa.
      onChange(layer.id, { rotate: normalizeAngle(snapAngle(base + delta, ev.shiftKey)) });
    });
  };

  /**
   * O laço de arrasto, comum aos três gestos. `onEnd` é só do `startMove`, pra
   * apagar a guia de centro quando a mão solta.
   */
  const drag = (
    e: React.PointerEvent,
    apply: (to: Point, ev: PointerEvent) => void,
    onEnd?: () => void,
  ) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => apply(toComposition(ev), ev);
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      onEnd?.();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const st = selected ? resolveState(selected, t) : null;
  const box = selected ? layerBox(selected, project, measure, t) : null;
  const center = selected && st ? layerCenter(project, st) : null;

  return (
    <div
      className="gizmo-root"
      ref={rootRef}
      style={{
        width: project.width,
        height: project.height,
        // Desfaz o zoom pra tudo aqui dentro — as alças do gizmo E as guias de
        // centro: uma alça de 10px viraria 2px a 25%, e uma guia de 2px
        // sumiria de vista no mesmo zoom.
        ['--unzoom' as string]: 1 / viewport.zoom,
      }}
      onPointerDown={onPointerDown}
    >
      {guide.x && (
        <div className="stage-guide stage-guide-v" style={{ left: project.width / 2 }} />
      )}
      {guide.y && (
        <div className="stage-guide stage-guide-h" style={{ top: project.height / 2 }} />
      )}
      {selected && st && box && center && box.w > 0 && box.h > 0 && (
        <div
          className="gizmo"
          style={{
            left: center.x,
            top: center.y,
            width: box.w * st.scale,
            height: box.h * st.scale,
            transform: `translate(-50%, -50%) rotate(${st.rotate}deg)`,
          }}
        >
          {HANDLES.map(h => (
            <span
              key={h}
              className={`gizmo-handle gizmo-${h}`}
              onPointerDown={ev => startScale(ev, selected)}
            />
          ))}
          <span className="gizmo-stem" />
          <span
            className="gizmo-rotate"
            title="Arraste pra girar (Shift prende de 15 em 15)"
            onPointerDown={ev => startRotate(ev, selected)}
          />
        </div>
      )}
    </div>
  );
}
