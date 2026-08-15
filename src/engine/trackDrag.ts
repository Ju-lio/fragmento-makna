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
 * Desde que uma faixa carrega vários clipes, o destino também pode ser
 * **inválido**: o lugar já estar ocupado. O plano reporta isso em vez de
 * decidir sozinho, pra que a interface possa avisar antes de você soltar —
 * descobrir que o gesto não valeu só depois de largar é o que faz esse tipo
 * de arrasto parecer quebrado.
 *
 * Vive fora do componente porque é a regra que decide onde a layer termina, e
 * errar aqui reorganiza o projeto sem que nada acuse.
 */

import { magnetize } from './magnet.ts';
import { overlaps } from './project.ts';
import type { TimeSpan } from './types.ts';

/** Um clipe que já ocupa espaço — o suficiente pra detectar colisão. */
export interface Occupant extends TimeSpan {
  track: number;
}

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
  track: number;
  /** Duração do clipe e do projeto — o clipe não pode sair da linha. */
  span: number;
  duration: number;
  /**
   * As linhas na tela vão ao contrário da numeração das faixas? Verdadeiro no
   * vídeo, falso no áudio — ver o comentário na conta de `moved`.
   */
  invertedRows?: boolean;
  /**
   * Faixa mais alta que aceita o clipe. Costuma ser `topTrack + 1`: a faixa
   * vazia do topo é o que permite tirar um clipe de uma faixa cheia.
   */
  maxTrack: number;
  /** Os outros clipes do projeto. O arrastado NÃO entra — colidiria consigo. */
  others: readonly Occupant[];
  /**
   * O ímã. Ausente, o clipe pousa onde o ponteiro deixou.
   *
   * O raio vem em SEGUNDOS já convertidos — quem sabe quantos pixels valem um
   * segundo é quem desenha. Ver `magnet.ts`.
   */
  magnet?: { targets: readonly number[]; radius: number };
}

export interface ClipDragPlan {
  start: number;
  /**
   * Faixa de destino. Em `insert`, é a posição da faixa NOVA — as faixas
   * daquele número pra cima sobem uma.
   */
  track: number;
  /** Criar uma faixa nova aqui, em vez de pousar numa existente. */
  insert: boolean;
  /** Falso quando o destino colide com outro clipe da mesma faixa. */
  valid: boolean;
  /**
   * A que instante o ímã grudou, ou `null`.
   *
   * Existe pra interface, não pra lógica: um clipe que salta sozinho sem
   * nenhuma marca na tela parece defeito. A guia é o que transforma o salto em
   * "encaixou aqui".
   */
  snappedTo: number | null;
}

/**
 * Quão perto de uma linha o ponteiro precisa estar pra pousar NELA.
 *
 * Fora dessa margem, o gesto vira "inserir entre as duas" — é o que permite
 * mandar um clipe pra baixo de outro, e criar faixa no meio da pilha. Um terço
 * dá uma zona de inserção estreita o bastante pra não atrapalhar quem só quer
 * trocar de faixa, e larga o bastante pra ser mirável.
 */
const SNAP_MARGIN = 1 / 3;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function clipDragPlan({
  dx, dy, pxPerSecond, trackPitch, start, track, span, duration, maxTrack, others,
  invertedRows = true, magnet,
}: ClipDragInput): ClipDragPlan {
  // Sem escala não há como converter pixel em segundo; segurar o clipe onde
  // está é melhor que jogá-lo pra 0 por uma divisão por zero.
  const seconds = pxPerSecond > 0 ? dx / pxPerSecond : 0;

  // O clipe não pode passar do fim: o limite é a duração do projeto MENOS a
  // dele, senão a cauda sairia da linha.
  const solto = clamp(start + seconds, 0, Math.max(0, duration - span));

  /**
   * O ímã vem DEPOIS do limite e ANTES da colisão.
   *
   * Depois do limite porque grudar não pode ser desculpa pra sair da linha;
   * antes da colisão porque o pouso a validar é o pouso de verdade — testar a
   * posição solta e mover depois diria "válido" pra um lugar onde o clipe não
   * vai ficar.
   */
  const ima = magnet
    ? magnetize({ start: solto, span, targets: magnet.targets, radius: magnet.radius })
    : null;
  const nextStart = ima ? ima.start : solto;

  /**
   * A direção depende de qual espaço de faixa é este, e passou a ser um
   * PARÂMETRO quando o áudio ganhou o seu.
   *
   * No vídeo as faixas numeram ao contrário das linhas: a faixa 0 desenha no
   * fundo e por isso aparece embaixo, então descer com o ponteiro **diminui** a
   * faixa. No áudio o número não é profundidade, é só identidade, e as linhas
   * saem em ordem natural — descer **aumenta**.
   *
   * Era fixo no primeiro caso, e o sintoma foi silencioso: arrastar um clipe de
   * áudio pra baixo pedia a faixa -2, que o `clamp` prendia em 0 — o clipe
   * simplesmente não saía do lugar, sem nada indicar por quê.
   */
  const direction = invertedRows ? -1 : 1;
  const moved = trackPitch > 0 ? direction * (dy / trackPitch) : 0;
  const raw = track + moved;

  // Perto de uma linha, pousa nela. No meio do caminho entre duas, o gesto
  // quer dizer outra coisa: abrir uma faixa ali.
  const nearest = Math.round(raw);
  const insert = Math.abs(raw - nearest) > SNAP_MARGIN;

  // 3 casas: a timeline trabalha em milissegundos, e sem isso o `start`
  // acumula lixo de ponto flutuante que polui a assinatura do cache.
  const landing = { start: +nextStart.toFixed(3), duration: span };

  if (insert) {
    /**
     * Inserir na posição P significa "as faixas P pra cima sobem uma, e o
     * clipe fica em P". `ceil` porque a fronteira entre as faixas 1 e 2 abre a
     * faixa 2 — acima da 1, abaixo da antiga 2.
     *
     * Vai de 0 (embaixo de tudo, que é o que faltava) até `maxTrack`.
     */
    return {
      start: landing.start,
      track: clamp(Math.ceil(raw), 0, Math.max(0, maxTrack)),
      insert: true,
      // Faixa nova nasce vazia: não há com o que colidir.
      valid: true,
      snappedTo: ima?.snappedTo ?? null,
    };
  }

  const nextTrack = clamp(nearest, 0, Math.max(0, maxTrack));

  return {
    start: landing.start,
    track: nextTrack,
    insert: false,
    valid: !others.some(o => o.track === nextTrack && overlaps(o, landing)),
    snappedTo: ima?.snappedTo ?? null,
  };
}

/**
 * Abre uma faixa em `at`, empurrando pra cima o que estava dali em diante.
 *
 * Pura e à parte do plano porque é a única operação que mexe em layers que o
 * usuário nem tocou — e é justamente aí que um off-by-one reorganiza o projeto
 * inteiro sem ninguém notar na hora.
 */
export function openTrackAt<T extends { track: number }>(layers: readonly T[], at: number): T[] {
  return layers.map(l => (l.track >= at ? { ...l, track: l.track + 1 } : l));
}

/**
 * Ordem de desenho ↔ ordem visual.
 *
 * As faixas desenham de baixo pra cima (a 0 no fundo), e na tela aparecem ao
 * contrário — a de cima é a que você vê na frente. As duas listas são
 * espelhadas.
 *
 * A conversão é a própria inversa (aplicar duas vezes volta ao começo), então
 * uma função só serve pros dois sentidos e não há como trocá-las por engano.
 */
export const flipOrder = (index: number, count: number): number => count - 1 - index;
