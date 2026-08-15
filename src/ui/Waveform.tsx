import { useEffect, useRef, useState } from 'react';
import { mediaBlob } from '../engine/mediaStore.ts';
import { ensurePeaks, subscribe } from '../engine/waveformStore.ts';
import { barsFor, clipWindow, viewScale } from '../engine/waveform.ts';
import type { SoundLayer } from '../engine/types.ts';

/**
 * A onda dentro do clipe.
 *
 * Desenhada em canvas e não em SVG por um motivo prático: num projeto ampliado
 * um clipe passa de mil pixels de largura, e mil `<rect>` por clipe é DOM que o
 * navegador tem que manter, comparar e re-renderizar a cada zoom. Em canvas é
 * um `fillRect` por coluna e nada sobra depois.
 *
 * **Uma barra por pixel, sem `devicePixelRatio`.** O resto do editor é
 * pixel-art de propósito; suavizar a onda em telas retina a deixaria macia e
 * fora de lugar, e ainda custaria 4x o trabalho por quadro.
 */

interface WaveformProps {
  layer: SoundLayer;
}

/** Um pouco de folga em cima e embaixo: a onda encostando na borda vira mancha. */
const PADDING = 2;

export function Waveform({ layer }: WaveformProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [, bump] = useState(0);

  // O envelope chega assíncrono. Sem este aviso, a onda só apareceria no
  // próximo render que acontecesse por acaso.
  useEffect(() => subscribe(id => { if (id === layer.mediaId) bump(n => n + 1); }), [layer.mediaId]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const draw = () => {
      const w = Math.max(1, Math.floor(canvas.clientWidth));
      const h = Math.max(1, Math.floor(canvas.clientHeight));
      // Atribuir width/height já limpa o canvas — não precisa de clearRect.
      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const peaks = ensurePeaks(layer.mediaId, mediaBlob);
      if (!peaks) return;   // ainda decodificando: fica vazio e volta pelo aviso

      const { from, to } = clipWindow(layer);
      const bars = barsFor(peaks, from, to, w);

      const mid = h / 2;
      // Normalizada pela escala do arquivo — ver `viewScale`. Sem isso, fala e
      // material não masterizado viram uma linha reta.
      const half = Math.max(1, mid - PADDING) * viewScale(peaks);
      ctx.fillStyle = getComputedStyle(canvas).color;

      for (let x = 0; x < bars.max.length; x++) {
        // Presas à caixa: a normalização pode passar do topo num transiente
        // isolado, e uma barra saindo do clipe lê como defeito de desenho.
        const top = Math.max(PADDING, mid - (bars.max[x] as number) * half);
        const bottom = Math.min(h - PADDING, mid - (bars.min[x] as number) * half);
        // Mínimo de 1px: em silêncio absoluto a altura seria zero e a onda
        // sumiria em vez de virar a linha reta que se espera ver ali.
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
    };

    draw();
    // O zoom da timeline muda a largura do clipe; o trim muda o conteúdo. O
    // observer cobre os dois sem o componente saber de nenhum dos dois.
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  });

  return <canvas className="clip-wave" ref={ref} aria-hidden="true" />;
}
