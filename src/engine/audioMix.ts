/**
 * O que toca, quando, e de onde do arquivo.
 *
 * Serve aos dois consumidores de som: a reprodução (que posiciona elementos
 * `<audio>`/`<video>`) e o export (que agenda fontes num `OfflineAudioContext`).
 * Ter um plano só é o que garante que o arquivo exportado soe igual ao que
 * você ouviu — a mesma razão pela qual o exportador de vídeo reusa o
 * `stageVideosAt` do pré-render.
 *
 * Puro e sem Web Audio de propósito: é aqui que moram os erros de um quadro,
 * e eles são invisíveis olhando a forma de onda.
 */

import { coversAt } from './timeSpan.ts';
import type { Layer, SoundLayer, TimeSpan } from './types.ts';

/** Um pedaço de som a tocar no arquivo de saída. */
export interface MixClip {
  layerId: number;
  mediaId: string;
  /** Quando entra no resultado, em segundos contados a partir do início dele. */
  at: number;
  /** Ponto do arquivo de origem onde começa a ler. */
  offset: number;
  duration: number;
  /** Ganho já resolvido: mudo vira 0, não um caso especial pra frente. */
  gain: number;
}

/** As layers que produzem som — vídeo tem trilha própria, e ela conta. */
export function soundLayers(layers: readonly Layer[]): SoundLayer[] {
  return layers.filter((l): l is SoundLayer => l.type === 'audio' || l.type === 'video');
}

/** Ganho efetivo de uma layer. Fora de 0..1 o elemento de mídia lança. */
export function effectiveGain(layer: { volume?: number; mute?: boolean }): number {
  if (layer.mute) return 0;
  const v = layer.volume ?? 1;
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

/**
 * Instante do arquivo de origem que corresponde a `t` na linha do tempo.
 * Mesma conta do vídeo — o trim desloca a leitura, não a posição.
 */
export function sourceTimeOf(layer: { start: number; trimStart?: number }, t: number): number {
  return (layer.trimStart ?? 0) + (t - layer.start);
}

/**
 * A inversa: onde na LINHA DO TEMPO está um elemento que lê `srcTime` do arquivo.
 *
 * Existe porque o som virou o relógio-mestre da reprodução (ver `soundClock` e
 * `player.setTimeSource`): pra saber que horas são, o editor pergunta ao
 * elemento onde ele está no arquivo e traduz de volta pra linha do tempo.
 *
 * Fica coladinha na `sourceTimeOf` de propósito. Uma inversa que mora longe da
 * função que ela inverte é uma inversa que para de bater no dia em que o trim
 * ganhar um caso novo, e o sintoma seria a imagem descolando do som.
 */
export function timelineTimeOf(layer: { start: number; trimStart?: number }, srcTime: number): number {
  return layer.start + (srcTime - (layer.trimStart ?? 0));
}

/**
 * Monta a lista do que tocar num trecho.
 *
 * O recorte é a parte que erra fácil: uma música que começa antes do trecho
 * exportado não entra do começo dela, entra **do meio** — e o quanto pular sai
 * do trim mais a diferença até `from`. Sem isso, exportar de 10s a 20s
 * reiniciaria a música em 10s, e o export soaria diferente do preview.
 */
export function mixPlan(layers: readonly Layer[], { from, to }: { from: number; to: number }): MixClip[] {
  const clips: MixClip[] = [];

  for (const layer of soundLayers(layers)) {
    const gain = effectiveGain(layer);
    if (gain === 0) continue;

    // Interseção entre o clipe e o trecho pedido.
    const clipStart = Math.max(layer.start, from);
    const clipEnd = Math.min(layer.start + layer.duration, to);
    const duration = clipEnd - clipStart;
    if (duration <= 0) continue;

    const offset = sourceTimeOf(layer, clipStart);
    // Ler além do fim do arquivo devolve silêncio; pior, um `offset` negativo
    // faz o BufferSource lançar. Descartar é mais honesto que tocar errado.
    if (offset < 0 || offset >= layer.sourceDuration) continue;

    clips.push({
      layerId: layer.id,
      mediaId: layer.mediaId,
      at: clipStart - from,
      offset,
      // Nunca ler além do que o arquivo tem: um clipe esticado além da fonte
      // pediria mais material do que existe.
      duration: Math.min(duration, layer.sourceDuration - offset),
      gain,
    });
  }

  // Ordena pelo instante de entrada. Não muda o resultado sonoro — é pra que
  // o plano seja legível e comparável em teste.
  return clips.sort((a, b) => a.at - b.at || a.layerId - b.layerId);
}

/** Existe algum som no trecho? Evita montar um contexto de áudio à toa. */
export function hasSound(layers: readonly Layer[], range: { from: number; to: number }): boolean {
  return mixPlan(layers, range).length > 0;
}

/**
 * Uma layer de som está tocando neste instante?
 *
 * Ponta final EXCLUSIVA, ao contrário do vídeo: o quadro final de um clipe
 * visual ainda aparece, mas um som que segue tocando um instante além do fim
 * do clipe é audível como um estalo.
 */
export function isSoundActive(layer: TimeSpan, t: number): boolean {
  // A regra é a mesma da imagem, e agora mora num lugar só — ver `timeSpan.ts`.
  // Esta metade sempre esteve certa; era a da imagem que contava a fronteira
  // duas vezes.
  return coversAt(layer, t);
}
