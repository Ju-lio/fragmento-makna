/**
 * Quem precisa de decodificador neste instante, e quem já pode soltar o seu.
 *
 * ## Por que existe separado do `videoFrames.ts`
 *
 * O `videoFrames.ts` é a casca que segura os decodificadores do `@elah/core` —
 * e esse pacote só roda em navegador. A decisão de *quantos* decodificadores
 * abrir, *onde* mirar cada um e *qual* soltar primeiro não tem nada de
 * navegador: é aritmética de linha do tempo. Aqui ela é pura, e por isso o
 * caso que motivou esta fase — o remix de fatias curtas do mesmo arquivo — é
 * testável no `node --test`, sem abrir uma aba.
 *
 * ## A regra que sustenta tudo: um decodificador por CLIPE
 *
 * O plano é indexado pelo `id` da LAYER, não pelo `mediaId`. Compartilhar um
 * decodificador por arquivo parecia economia e era o defeito: num remix, duas
 * fatias vizinhas do mesmo vídeo pedem quadros de pontos distantes do arquivo,
 * e cada corte fazia o índice saltar. O `@elah/core` lê salto como
 * descontinuidade e **reinicia o decodificador** — o preview engasgava a cada
 * corte (o export não, porque ele espera até 3s por quadro e engole o custo).
 * Com uma layer por decodificador, cada um caminha para frente dentro da sua
 * própria fatia e a descontinuidade deixa de existir.
 *
 * O caso de duas fatias do mesmo arquivo VISÍVEIS ao mesmo tempo, em faixas
 * diferentes, era pior ainda: as duas escreviam o playhead do mesmo
 * decodificador, uma desfazendo a mira da outra a cada quadro.
 */

import { coversAt } from './timeSpan.ts';
import type { VideoTiming } from './types.ts';

/** O recorte de um clipe que o plano lê. `VideoLayer` satisfaz. */
export interface VideoClip extends VideoTiming {
  /** Id da LAYER: é a chave do decodificador. Ver o cabeçalho. */
  id: number;
  mediaId: string;
}

/**
 * Instante do arquivo que corresponde a `t` na linha do tempo, preso ao que o
 * arquivo tem. O trim desloca a leitura, não a posição.
 */
export function sourceTimeOf(layer: VideoTiming, t: number): number {
  const bruto = (layer.trimStart || 0) + (t - layer.start);
  // `Number.isFinite` não estreita o tipo, daí o cast.
  const max = Number.isFinite(layer.sourceDuration) ? (layer.sourceDuration as number) : bruto;
  return Math.max(0, Math.min(bruto, max));
}

/**
 * Índice do quadro do arquivo, na grade do projeto.
 *
 * Inteiro, e é o ponto todo: pedir por segundos põe a fronteira do quadro à
 * mercê do ponto flutuante — o quadro 61 a 30fps começa em 2,0333333…, e um
 * pedido um bilionésimo abaixo devolve o 60. Índice inteiro não tem fronteira.
 */
export function sourceFrameOf(layer: VideoTiming, t: number, fps: number): number {
  return Math.round(sourceTimeOf(layer, t) * fps);
}

/** Onde um decodificador deve mirar, e o quanto pode adiantar. */
export interface FrameTarget {
  /** Id da layer — a chave do decodificador. */
  id: number;
  mediaId: string;
  /** Quadro do ARQUIVO a mirar. */
  sourceFrame: number;
  /** Quantos quadros pedir à frente, já preso ao fim do clipe. */
  lookahead: number;
  /** Já está na tela? `false` = está sendo armado pra entrar. */
  onScreen: boolean;
}

export interface PlanLimits {
  /** Teto de quadros à frente do cursor, por decodificador. */
  lookahead: number;
  /** Piso do mesmo pedido. Ver `framePlanAt` pra por que não pode ser 0. */
  minLookahead: number;
  /** Antecedência com que um clipe que ainda não entrou já começa a decodificar. */
  preArm: number;
}

/**
 * Os decodificadores que `t` exige: os clipes na tela e os que entram logo.
 *
 * ## Por que armar antes do corte
 *
 * Um decodificador por clipe conserta o engasgo do *segundo* play e não o do
 * primeiro: criado no instante em que o clipe aparece, ele ainda tem que abrir
 * o arquivo, procurar o keyframe anterior e decodificar até lá — e isso é
 * exatamente o buraco que se vê no corte. `preArm` dá a esse trabalho um
 * adiantamento em segundos de linha do tempo, mirando no PRIMEIRO quadro do
 * clipe. Quando o corte chega, o quadro já está em mãos.
 *
 * ## Por que o lookahead é preso ao fim do clipe
 *
 * Pedir 12 quadros à frente numa fatia de 0,2s (6 quadros) manda o decodificador
 * trabalhar — e guardar — o dobro do que o clipe mostra. Multiplicado por vinte
 * fatias, é trocar engasgo por estouro de memória.
 *
 * Isto limita o que se PEDE. O que o decodificador guarda tem outro teto, em
 * `apertarTeto` no `videoFrames.ts`: a subida até o keyframe anterior deixa no
 * cache dezenas de quadros que ninguém pediu, e esse caminho não passa por aqui.
 *
 * O piso (`minLookahead`) não é enfeite: o `@elah/core` chama de
 * descontinuidade um salto de playhead MAIOR que o lookahead. Com lookahead 0
 * no último quadro do clipe, andar um quadro viraria reset de decodificador —
 * o defeito que esta fase veio consertar, reintroduzido pela correção.
 */
export function framePlanAt(
  clips: readonly VideoClip[], t: number, fps: number, limits: PlanLimits,
): FrameTarget[] {
  const alvos: FrameTarget[] = [];

  for (const clip of clips) {
    const fim = clip.start + clip.duration;
    // Meio-aberto: na fronteira, quem manda é quem entra. Ver `timeSpan.ts`.
    // Com `<=` aqui, o clipe que termina continuava no plano no quadro do corte
    // e o `framesReadyAt` passava a exigir um quadro dele que ninguém desenha.
    const onScreen = coversAt(clip, t);
    const entrando = clip.start > t && clip.start - t <= limits.preArm;
    if (!onScreen && !entrando) continue;

    // Quem ainda não entrou mira o próprio começo: é o quadro do corte.
    const em = onScreen ? t : clip.start;
    const restantes = Math.max(0, Math.round((fim - em) * fps));

    alvos.push({
      id: clip.id,
      mediaId: clip.mediaId,
      sourceFrame: sourceFrameOf(clip, em, fps),
      lookahead: Math.max(limits.minLookahead, Math.min(limits.lookahead, restantes)),
      onScreen,
    });
  }

  return alvos;
}

/**
 * Este quadro serve pro que foi pedido?
 *
 * ## Por que a pergunta existe
 *
 * O `getCurrent` do `@elah/core` aceita entregar um quadro até DOIS atrás do
 * pedido. Isso não é bug dele: um arquivo a 29,97 num projeto a 30 tem índices
 * que simplesmente não existem — o índice sai de `round(timestamp × fps)` — e
 * sem a tolerância esse material nunca ficaria pronto. É reamostragem correta.
 *
 * O preço apareceu no EXPORT, que é onde dói: um trecho saiu
 * `413, 414, 414, 416, 417, 417` onde o projeto pedia `414…419`. Quadro
 * repetido e quadro perdido, gravados no arquivo final — exatamente o "mostrar
 * o vizinho" que trocar o `<video>` pelo decodificador veio eliminar. O
 * exportador aceitou o vizinho porque perguntou "veio algum quadro?" em vez de
 * "veio o quadro?".
 *
 * ## A regra
 *
 * O vizinho só serve quando o exato **não vem mais**: o decodificador entrega
 * em ordem, então tendo ele já passado do índice pedido, aquele índice não
 * existe no arquivo. Antes disso, esperar é o certo — é o que separa "o arquivo
 * não tem esse quadro" de "o quadro ainda está sendo decodificado".
 *
 * `delivered` indefinido significa que o quadro veio por um caminho que não
 * passou pelo nosso conversor. Aí não há o que comparar, e recusar tudo
 * apagaria a imagem: aceita-se, e quem chama avisa uma vez.
 */
export function frameServes(
  requested: number, delivered: number | undefined, highestDelivered: number,
): boolean {
  if (delivered === undefined) return true;
  if (delivered === requested) return true;
  return highestDelivered > requested;
}

/** Nada foi entregue desde o último salto. Ver `highWaterAfterAim`. */
export const MARCA_DESCONHECIDA = -1;

/**
 * A marca d'água de entrega sobrevive a mirar em `próximo`?
 *
 * ## O que a marca afirma, e quando ela deixa de ser verdade
 *
 * `frameServes` aceita um vizinho quando o decodificador já PASSOU do índice
 * pedido — a prova de que o exato não existe no arquivo. Essa prova vale porque
 * o decodificador entrega **em ordem**, e só vale enquanto ele estiver andando
 * pra frente desde o último salto.
 *
 * Voltar o cursor quebra a afirmação, e o estrago era permanente: a marca só
 * subia, nunca descia. Bastava a reprodução adiantar o lookahead até o quadro
 * 300 e você arrastar de volta pro 100 — dali em diante `300 > 100` era
 * verdade pra todo índice abaixo de 300, e o vizinho passava a ser aceito
 * **sempre**. Ou seja: o defeito que trocar o `<video>` pelo decodificador veio
 * matar (mostrar o quadro de antes) voltava sozinho, e voltava justo depois do
 * gesto mais comum que existe num editor — voltar e tocar de novo.
 *
 * Zerar é conservador na direção certa: sem prova nenhuma, `frameServes` passa
 * a exigir o quadro exato. Se o índice de fato não existir no arquivo (29,97
 * num projeto a 30), o decodificador passa por ele em alguns quadros e a marca
 * se reconstrói sozinha.
 */
export function highWaterAfterAim(
  previousAim: number, nextAim: number, highest: number,
): number {
  return nextAim < previousAim ? MARCA_DESCONHECIDA : highest;
}

/** Um decodificador vivo, do ponto de vista da política. */
export interface LiveProvider {
  id: number;
  /** Ordem do último uso. Só a ordem importa, não a unidade. */
  usedAt: number;
}

export interface DropRules {
  /** Ids que o plano de `t` está usando — esses nunca saem. */
  keep: ReadonlySet<number>;
  /** Ids de layer que ainda existem no projeto. */
  existing: ReadonlySet<number>;
  /** Quantos decodificadores podem ficar vivos ao mesmo tempo. */
  max: number;
}

/**
 * Quais decodificadores fechar agora, órfãos primeiro.
 *
 * Duas razões distintas, e as duas precisam existir:
 *
 *  - **Órfão**: a layer foi excluída. Não há quando revisitá-lo; segurar é
 *    vazamento puro.
 *  - **Excedente**: um remix de vinte fatias abriria vinte decodificadores em
 *    quatro segundos de linha do tempo. Cada um custa um `VideoDecoder` do
 *    sistema, um demuxer e o próprio cache de quadros — e o navegador tem um
 *    número finito de decodificadores de hardware. Fecha-se pela ordem do
 *    último uso: o mais antigo é o que demora mais pra voltar a fazer falta, e
 *    quando voltar o `preArm` o reabre antes do corte.
 *
 * O que está no plano de `t` (`keep`) nunca é fechado, nem que isso deixe o
 * total acima do teto: fechar o decodificador do clipe que está na tela é
 * garantir o buraco que o teto queria evitar.
 */
export function providersToDrop(
  live: readonly LiveProvider[], { keep, existing, max }: DropRules,
): number[] {
  const orfaos = live.filter(v => !existing.has(v.id));
  const restam = live.filter(v => existing.has(v.id));

  const excedente = restam.length - max;
  if (excedente <= 0) return orfaos.map(v => v.id);

  const velhos = restam
    .filter(v => !keep.has(v.id))
    .sort((a, b) => a.usedAt - b.usedAt)
    .slice(0, excedente);

  return [...orfaos.map(v => v.id), ...velhos.map(v => v.id)];
}
