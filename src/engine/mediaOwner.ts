/**
 * Quem conduz cada elemento de mídia neste instante.
 *
 * Clipes do mesmo arquivo costumam dividir **um** elemento. Não é escolha de
 * design, é como o projeto se monta: `splitLayer` copia a layer com spread e a
 * referência do `<video>`/`<audio>` vai junto, o acervo entrega o mesmo elemento
 * a cada reúso, e a restauração cria um elemento por arquivo — nunca por layer.
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
 *
 * **A chave é o ELEMENTO, não o arquivo.** Foi por arquivo primeiro, e a
 * diferença só aparece quando se destaca o áudio de um clipe: as duas layers
 * apontam pro mesmo `mediaId` e para elementos **diferentes** (um `<video>`, um
 * `<audio>` novo sobre a mesma blob). Agrupando por arquivo, uma calaria a
 * outra — o mesmo bug do clipe cortado, chegando pelo outro lado. Agrupando
 * pelo elemento, a pergunta passa a ser a real: quem está mexendo neste cursor?
 */
export function ownersByElement<T>(
  layers: readonly T[],
  elementOf: (layer: T) => object | null | undefined,
  inUse: (layer: T) => boolean,
): T[] {
  const byElement = new Map<object, T>();

  for (const layer of layers) {
    const el = elementOf(layer);
    // Sem elemento não há cursor pra disputar — e a layer não conduz nada.
    if (!el) continue;
    if (!byElement.has(el) || inUse(layer)) byElement.set(el, layer);
  }

  return [...byElement.values()];
}

/**
 * Quem conduzia cada elemento na última vez. Guardado por elemento, não por
 * layer, porque é o elemento que tem o cursor.
 */
const lastOwner = new WeakMap<object, number>();

/**
 * O elemento trocou de clipe desde a última passada? Já registra o novo.
 *
 * Existe porque **trocar de clipe é um CORTE, não deriva** — e as duas coisas
 * eram indistinguíveis pra quem corrige a posição. Um remix é o caso puro:
 * várias fatias do mesmo arquivo, em ordem trocada, dividindo um `<video>` só.
 * Quando a fatia A termina e a B começa lendo de outro ponto, o cursor precisa
 * PULAR pra lá.
 *
 * Sem isto, esse pulo chegava na correção de deriva como um erro qualquer, e
 * abaixo do limiar de resync ele virava ajuste de **velocidade** — que jamais
 * resolve uma descontinuidade. O elemento seguia lendo o arquivo em linha reta
 * enquanto a imagem (vinda do cache) mostrava o remix: o preview tocava
 * "1 2 3 4 5 6 7 8 9…" onde deveria tocar "1 2 3 4 | 5 6 7 | 5 6 7".
 */
export function ownerChanged(element: object, layerId: number): boolean {
  const before = lastOwner.get(element);
  if (before === layerId) return false;
  lastOwner.set(element, layerId);
  return true;
}
