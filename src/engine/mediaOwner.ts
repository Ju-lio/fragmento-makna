/**
 * Quem conduz cada elemento de mídia neste instante.
 *
 * Clipes do mesmo arquivo dividem **um** elemento. Não é escolha de design, é
 * como o projeto se monta: `splitLayer` copia a layer com spread e a referência
 * do `<video>`/`<audio>` vai junto, o acervo entrega o mesmo elemento a cada
 * reúso, e a restauração cria um elemento por `mediaId` — nunca por layer.
 *
 * Um elemento tem um cursor só, então mais de um candidato é uma disputa que
 * alguém perde. Perdia em silêncio, e sempre pro mesmo lado: quem vinha depois
 * na lista escrevia por último e ganhava, estando em uso ou não. Era o que
 * fazia a primeira metade de um clipe cortado tocar muda (som) e o que fazia o
 * clipe piscar durante a reprodução (imagem) — a metade inativa pausava o
 * elemento que a ativa tinha acabado de soltar.
 *
 * Critério: quem está em uso ganha; entre dois em uso, o último da lista, que é
 * o que está por cima. Sem nenhum candidato em uso sobra o primeiro, e é de
 * propósito — o plano dele é justamente parar o elemento, que senão continuaria
 * rolando depois do fim do último clipe.
 *
 * Genérico porque a disputa é a mesma em três lugares (som, imagem, pré-render)
 * e só o critério de "em uso" muda. Três cópias divergiriam, e o modo de
 * divergir é ficar mudo ou piscando — que é o que já aconteceu.
 */
export function ownersByMedia<T extends { mediaId: string }>(
  layers: readonly T[],
  inUse: (layer: T) => boolean,
): T[] {
  const byMedia = new Map<string, T>();

  for (const layer of layers) {
    if (!byMedia.has(layer.mediaId) || inUse(layer)) byMedia.set(layer.mediaId, layer);
  }

  return [...byMedia.values()];
}
