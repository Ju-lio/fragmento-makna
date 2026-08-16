/**
 * As regras da seleção da timeline, puras e testáveis.
 *
 * A seleção é uma LISTA de ids, ordenada por ordem de escolha — o último é o
 * PRINCIPAL, que governa gizmo e painéis. Uma lista, e não um `Set`: a ordem
 * é informação (quem é o principal), e o tamanho nunca justifica a busca por
 * hash.
 *
 * Onde cada modo entra:
 * - `replace`: clique comum (ou um id `null` = clicar em área vazia);
 * - `toggle`: Ctrl/Cmd+clique;
 * - `range`: Shift+clique — o trecho contíguo na mesma faixa, entre o
 *   principal e o clicado.
 */

import type { Layer } from './types.ts';
import { trackKind } from './project.ts';

export type SelectMode = 'replace' | 'toggle' | 'range';

/**
 * A seleção nova a partir da anterior, do alvo clicado e do modificador.
 *
 * Devolve a MESMA referência quando nada muda, pro caller poder pular o
 * re-render — mesma cortesia que `commit` faz com o projeto.
 */
export function applySelection(
  prev: readonly number[],
  id: number | null,
  mode: SelectMode,
  layers: readonly Layer[],
): number[] {
  if (mode === 'replace') return id === null ? [] : [id];
  if (id === null) return [...prev];

  if (mode === 'toggle') {
    return prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
  }

  // range: precisa de uma âncora — sem ela (ou clicando nela mesma), é um
  // clique comum.
  const anchor = prev.at(-1);
  if (anchor === undefined || anchor === id) return [id];
  return rangeOnTrack(anchor, id, layers) ?? [id];
}

/**
 * O trecho contíguo da mesma faixa entre dois clipes, por tempo.
 *
 * `null` quando os dois não estão na mesma faixa do mesmo tipo — a faixa 0
 * do vídeo não é a faixa 0 do áudio (ver `trackKind`), e não há "trecho"
 * entre dois espaços diferentes. Quem chama decide o que fazer com o `null`
 * (hoje: selecionar só o clicado).
 *
 * O clicado vem POR ÚLTIMO no resultado: depois de estender, o principal é
 * ele — a âncora continua selecionada, mas não manda mais.
 */
export function rangeOnTrack(
  anchorId: number,
  clickedId: number,
  layers: readonly Layer[],
): number[] | null {
  const anchor = layers.find(l => l.id === anchorId);
  const clicked = layers.find(l => l.id === clickedId);
  if (!anchor || !clicked) return null;
  if (anchor.track !== clicked.track || trackKind(anchor) !== trackKind(clicked)) return null;

  const onTrack = layers
    .filter(l => l.track === clicked.track && trackKind(l) === trackKind(clicked))
    .sort((a, b) => a.start - b.start || a.id - b.id);

  const ai = onTrack.findIndex(l => l.id === anchorId);
  const ci = onTrack.findIndex(l => l.id === clickedId);
  if (ai < 0 || ci < 0) return null;

  const [lo, hi] = ai <= ci ? [ai, ci] : [ci, ai];
  const ids = onTrack.slice(lo, hi + 1).map(l => l.id);
  return [...ids.filter(x => x !== clickedId), clickedId];
}
