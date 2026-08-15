/**
 * O ímã da timeline: encostar um clipe exatamente onde o outro acaba.
 *
 * Sem ele, "encostar" é impossível na prática. Um clipe de 2,0s arrastado até o
 * fim do vizinho pousa em 1,997 ou 2,003 — a diferença é um pixel na tela e
 * ninguém consegue mirar melhor que isso. O buraco de 3ms não aparece na
 * timeline, aparece no export, como um quadro preto no meio do corte.
 *
 * ## O raio é em PIXELS, e isso é a decisão
 *
 * A conversão pra segundos é do chamador. Um raio em segundos pareceria fraco
 * com zoom fechado (0,1s pode ser meio pixel) e agarraria tudo com zoom aberto
 * (0,1s virando meia tela). Em pixels o ímã tem sempre a mesma força na MÃO,
 * que é onde ele é percebido — e é por isso que ele parece "certo" em qualquer
 * zoom sem ninguém recalibrar nada.
 *
 * ## As duas bordas atraem
 *
 * Arrastar um clipe pra encostar no vizinho é encostar o FIM dele no começo do
 * outro; arrastar pra alinhar dois começos é o INÍCIO. Testar só o início faria
 * o gesto mais comum da edição — emendar dois cortes — ser justamente o que o
 * ímã não pega.
 */

/**
 * A força do ímã, em pixels de tela.
 *
 * Oito é o que dá pra mirar sem esforço e ainda deixa posicionar livremente a
 * nove pixels da borda. Muito maior e o clipe deixa de obedecer; muito menor e
 * o ímã não pega, que é o mesmo que não existir.
 */
export const MAGNET_PX = 8;

/** Onde o clipe quer parar, e o que o atrai. */
export interface MagnetInput {
  /** Início pretendido, antes do ímã. */
  start: number;
  /** Duração do clipe — é o que faz a borda final também atrair. */
  span: number;
  /**
   * Instantes que atraem: bordas dos outros clipes, o playhead, o zero.
   *
   * As bordas do PRÓPRIO clipe não podem entrar — ele grudaria em si mesmo e
   * nunca sairia do lugar.
   */
  targets: readonly number[];
  /** Raio de atração em SEGUNDOS. Zero ou menos desliga o ímã. */
  radius: number;
}

export interface MagnetResult {
  start: number;
  /** A que instante grudou, ou `null`. É o que a interface desenha como guia. */
  snappedTo: number | null;
  /** Por qual borda grudou. `null` quando não grudou. */
  edge: 'start' | 'end' | null;
}

/**
 * Aproxima `start` do alvo mais próximo, se algum estiver dentro do raio.
 *
 * O resultado é arredondado ao milissegundo, como todo instante da linha do
 * tempo. Não é cosmético: é o que faz o fim de um clipe cair EXATAMENTE no
 * início do vizinho, e portanto o que faz `overlaps` responder "encostou",
 * não "invadiu". Um ímã que produzisse 2,0000000000000004 brigaria com a
 * detecção de colisão e o clipe seria recusado justamente onde o usuário
 * mirou.
 */
export function magnetize({ start, span, targets, radius }: MagnetInput): MagnetResult {
  const solto: MagnetResult = { start: +start.toFixed(3), snappedTo: null, edge: null };
  if (!(radius > 0) || targets.length === 0) return solto;

  let melhor: { alvo: number; edge: 'start' | 'end'; distancia: number } | null = null;

  for (const alvo of targets) {
    // A borda de início e a de fim disputam em pé de igualdade; vence a mais
    // perto. Empate fica com o início, que é a ordem em que são testadas.
    const candidatos: { edge: 'start' | 'end'; distancia: number }[] = [
      { edge: 'start', distancia: Math.abs(start - alvo) },
      { edge: 'end', distancia: Math.abs(start + span - alvo) },
    ];

    for (const c of candidatos) {
      if (c.distancia > radius) continue;
      if (melhor && melhor.distancia <= c.distancia) continue;
      melhor = { alvo, edge: c.edge, distancia: c.distancia };
    }
  }

  if (!melhor) return solto;

  const novoInicio = melhor.edge === 'start' ? melhor.alvo : melhor.alvo - span;
  return {
    // Nunca antes do zero: grudar o fim num alvo menor que a duração jogaria o
    // clipe pra trás do início da linha.
    start: +Math.max(0, novoInicio).toFixed(3),
    snappedTo: melhor.alvo,
    edge: melhor.edge,
  };
}

/**
 * Os instantes que atraem, a partir dos vizinhos.
 *
 * Bordas de TODAS as faixas, não só a de destino: alinhar um título ao corte de
 * baixo é tão comum quanto emendar dois clipes da mesma faixa, e restringir à
 * faixa faria o ímã falhar exatamente no caso em que ele mais ajuda.
 *
 * Ordenado e sem repetição — não muda o resultado, mas deixa o plano legível e
 * comparável em teste.
 */
export function magnetTargets(
  others: readonly { start: number; duration: number }[],
  extras: readonly number[] = [],
): number[] {
  const pontos = new Set<number>(extras.map(e => +e.toFixed(3)));
  for (const o of others) {
    pontos.add(+o.start.toFixed(3));
    pontos.add(+(o.start + o.duration).toFixed(3));
  }
  return [...pontos].sort((a, b) => a - b);
}
