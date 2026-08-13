/**
 * Arrastar um clipe na timeline: para onde ele vai.
 *
 * Duas coisas acontecem no mesmo gesto — o clipe anda no tempo (horizontal) e
 * troca de faixa (vertical) — e as duas têm regras diferentes:
 *
 *  - No tempo o movimento é **contínuo**: você posiciona onde quiser, limitado
 *    apenas pelas pontas da linha.
 *  - Entre faixas ele é **discreto**: cai numa faixa ou na outra, nunca no
 *    meio. Por isso o vertical é arredondado antes de qualquer outra conta —
 *    é o que faz o clipe encaixar sozinho em vez de flutuar.
 *
 * Vive fora do componente porque é a regra que decide onde a layer termina, e
 * errar aqui reordena o projeto do jeito errado sem que nada acuse.
 */

export interface ClipDragInput {
  /** Deslocamento do ponteiro desde o início do arrasto, em pixels. */
  dx: number;
  dy: number;
  /** Quantos pixels da régua valem um segundo. */
  pxPerSecond: number;
  /** Distância vertical entre o topo de uma faixa e o da seguinte. */
  trackPitch: number;
  /** Onde o clipe estava quando o gesto começou. */
  start: number;
  row: number;
  /** Duração do clipe e do projeto — o clipe não pode sair da linha. */
  span: number;
  duration: number;
  /** Índice da última faixa. 0 é a de cima. */
  lastRow: number;
}

export interface ClipDragPlan {
  start: number;
  row: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function clipDragPlan({
  dx, dy, pxPerSecond, trackPitch, start, row, span, duration, lastRow,
}: ClipDragInput): ClipDragPlan {
  // Sem escala não há como converter pixel em segundo; segurar o clipe onde
  // está é melhor que jogá-lo pra 0 por uma divisão por zero.
  const seconds = pxPerSecond > 0 ? dx / pxPerSecond : 0;

  // O clipe não pode passar do fim: o limite é a duração do projeto MENOS a
  // dele, senão a cauda sairia da linha.
  const nextStart = clamp(start + seconds, 0, Math.max(0, duration - span));

  const rowsMoved = trackPitch > 0 ? Math.round(dy / trackPitch) : 0;

  return {
    // 3 casas: a timeline trabalha em milissegundos, e sem isso o `start`
    // acumula lixo de ponto flutuante que polui a assinatura do cache.
    start: +nextStart.toFixed(3),
    row: clamp(row + rowsMoved, 0, Math.max(0, lastRow)),
  };
}

/**
 * Ordem de desenho ↔ ordem visual.
 *
 * `project.layers` está em ordem de desenho: o primeiro vai pro fundo, o
 * último por cima. Na tela isso aparece de cabeça pra baixo — a faixa de cima
 * é a que você vê na frente —, então as duas listas são espelhadas.
 *
 * A conversão é a própria inversa (aplicar duas vezes volta ao começo), então
 * uma função só serve pros dois sentidos e não há como trocá-las por engano.
 */
export const flipOrder = (index: number, count: number): number => count - 1 - index;

/**
 * Tira o item de `from` e o enfia em `to`, empurrando o resto.
 *
 * Não é troca (swap): arrastar da faixa 4 pra 0 tem que deslizar as três do
 * meio pra baixo, e não trocar as duas pontas de lugar deixando o miolo
 * bagunçado.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from === to) return out;
  if (from < 0 || from >= out.length) return out;

  const [item] = out.splice(from, 1);
  if (item === undefined) return out;
  out.splice(clamp(to, 0, out.length), 0, item);
  return out;
}
