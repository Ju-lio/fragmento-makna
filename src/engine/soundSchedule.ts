/**
 * A política do tocador de som ao vivo — pura, sem `AudioContext`, sem DOM.
 *
 * Vive fora do `soundEngine` pela mesma razão que `videoSyncPlan` vive fora do
 * `videoSync` e `advanceClock` fora do `player`: é aqui que moram os erros que
 * não se enxergam olhando a tela. Um reagendamento a mais por segundo é um
 * clique audível; um a menos é a trilha tocando o trecho errado depois de um
 * corte. Nenhum dos dois aparece num teste que só verifica que saiu som.
 *
 * ## Por que existe um tocador novo
 *
 * O som saía dos elementos `<video>`/`<audio>`, e o relógio da reprodução saía
 * do `currentTime` deles. Num REMIX — várias fatias do mesmo arquivo em ordem
 * trocada — cada corte é um `seek`, e um seek custa tempo de reprodução que o
 * elemento nunca recupera. Medido: com seis cortes em 4,8s, o elemento andava
 * **88,8%** do tempo de parede; o mesmo arquivo num clipe só, **98,7%**; e o
 * projeto mudo (relógio de rAF), **99,2%**. Como a linha do tempo seguia o
 * elemento, os 11% dele viravam 11% de tudo — a reprodução inteira lenta, com
 * engasgos nas emendas.
 *
 * Agendando cada clipe como `AudioBufferSourceNode` não existe seek: o corte
 * vira um `start(quando, offset, duração)` em amostra exata, e o relógio passa
 * a ser o `currentTime` do `AudioContext`, que corre no hardware de áudio. É o
 * mesmo modelo que o export já usa (`renderAudio`, com `OfflineAudioContext`),
 * então preview e arquivo final passam a concordar por CONSTRUÇÃO, e não por
 * uma tolerância que alguém calibrou.
 */

import { mixPlan } from './audioMix.ts';
import type { MixClip } from './audioMix.ts';
import type { Layer } from './types.ts';

/** De onde o relógio conta. Ver `impliedPosition`. */
export interface Anchor {
  /** Posição na linha do tempo em que esta agenda começou. */
  t: number;
  /** `AudioContext.currentTime` no instante em que ela começou. */
  ctx: number;
  /**
   * Qual agenda é esta.
   *
   * O `player` descarta o delta quando o `id` da fonte muda — ver o tick dele.
   * Sem isso, o primeiro tick depois de um salto leria a diferença entre duas
   * posições que não têm tempo decorrido entre elas, e a linha do tempo pularia
   * junto.
   */
  geracao: number;
}

/** Onde a linha do tempo está, segundo o relógio de áudio. */
export function impliedPosition(anchor: Anchor, ctxNow: number): number {
  return anchor.t + (ctxNow - anchor.ctx);
}

/**
 * O quanto o relógio de áudio pode divergir de `t` antes de ser uma
 * DESCONTINUIDADE, e não deriva.
 *
 * Acima da grade de quadros com folga: a 30fps o playhead pousa na grade e fica
 * sistematicamente até 33ms atrás da posição real (a sobra vive no acumulador
 * do `player`). Um limiar menor que isso reagendaria a trilha o tempo todo
 * contra um resíduo de arredondamento — cada reagendamento sendo um corte no
 * som. Um limiar muito maior deixaria um seek pequeno passar por deriva, e a
 * trilha continuaria tocando o trecho antigo.
 */
export const SALTO = 0.15;

export interface EngineState {
  /** Há agenda tocando agora? */
  tocando: boolean;
  anchor: Anchor | null;
  /** Assinatura da agenda no ar. Ver `planSignature`. */
  assinatura: string;
}

export type SoundAction = 'reagendar' | 'seguir' | 'parar';

/**
 * O que o tocador deve fazer neste tick.
 *
 * Três respostas, e o caso normal é `seguir` — uma agenda já no ar toca sozinha
 * até o fim sem ninguém tocar nela, que é o ponto todo de agendar.
 */
export function soundAction(
  state: EngineState,
  { t, playing, ctxNow, assinatura }: { t: number; playing: boolean; ctxNow: number; assinatura: string },
): SoundAction {
  if (!playing) return state.tocando ? 'parar' : 'seguir';
  if (!state.tocando || !state.anchor) return 'reagendar';

  /**
   * O projeto mudou embaixo da agenda: volume, corte, arrasto, undo.
   *
   * A agenda é uma FOTOGRAFIA — o `<audio>` reagia a cada tick, um
   * `AudioBufferSourceNode` já agendado não reage a nada. Sem comparar a
   * assinatura, editar durante a reprodução continuaria tocando o projeto
   * anterior até o fim, sem nenhum sinal de que é o antigo.
   */
  if (assinatura !== state.assinatura) return 'reagendar';

  /**
   * Saltou: seek, laço, ou o relógio de áudio e a linha do tempo se separaram.
   *
   * Um laço aparece aqui como divergência do tamanho do projeto inteiro, então
   * o mesmo teste cobre os três. Ver `SALTO`.
   */
  if (Math.abs(impliedPosition(state.anchor, ctxNow) - t) > SALTO) return 'reagendar';

  return 'seguir';
}

/**
 * O que identifica uma agenda. Muda quando o som a tocar muda, e só aí.
 *
 * Sai do próprio `mixPlan`, e não das layers, de propósito: mover um clipe de
 * faixa, renomeá-lo ou mudar um efeito visual não muda uma nota do que se ouve,
 * e reagendar por isso seria um corte no som a cada tecla.
 *
 * ⚠️ Recebe o plano do PROJETO INTEIRO (`from: 0`), nunca o plano a partir do
 * playhead. Ver `projectSignature` — assinar o trecho restante foi o defeito
 * que fez a agenda ser refeita a cada quadro.
 */
export function planSignature(clips: readonly MixClip[]): string {
  return clips
    .map(c => `${c.layerId}:${c.mediaId}:${c.at.toFixed(4)}:${c.offset.toFixed(4)}:${c.duration.toFixed(4)}:${c.gain.toFixed(3)}`)
    .join('|');
}

/**
 * A assinatura do som do PROJETO — a que o tick deve comparar.
 *
 * Existe porque a versão óbvia está errada de um jeito que não faz barulho no
 * teste e faz muito barulho no alto-falante. Assinando o plano a partir do
 * playhead (`from: t`), os campos `at`, `offset` e `duration` de todo clipe
 * mudam a cada quadro — a assinatura nunca se repete, a agenda é refeita 60
 * vezes por segundo e cada refeitura é um corte no som. Medido antes da
 * correção: 171 reagendamentos em 6 segundos.
 *
 * O trecho a AGENDAR continua saindo de `t`; o que se compara é o projeto.
 */
export function projectSignature(layers: readonly Layer[], duration: number): string {
  return planSignature(mixPlan(layers, { from: 0, to: duration }));
}

/** Um `AudioBufferSourceNode` a criar: os três números do `start()`, e o ganho. */
export interface ScheduledSource {
  layerId: number;
  mediaId: string;
  /** `AudioContext.currentTime` em que este clipe entra. */
  when: number;
  offset: number;
  duration: number;
  gain: number;
}

/**
 * A agenda concreta: de `mixPlan` para chamadas de `start()`.
 *
 * `bufferDuration` entra porque o buffer decodificado pode ser mais curto que o
 * `sourceDuration` que a layer anunciou (o elemento arredonda) — e pedir além
 * do fim faz o `BufferSource` LANÇAR, o que aqui derrubaria a reprodução
 * inteira, não só uma faixa. É a mesma proteção do `renderAudio`.
 *
 * `when` no passado é agendado como `now`: um clipe que deveria ter entrado há
 * 5ms entra agora, atrasado por esses 5ms, em vez de o navegador tocá-lo
 * inteiro de uma vez (que é o que `start()` com tempo passado faz).
 */
export function scheduleFrom(
  clips: readonly MixClip[],
  { ctxNow, bufferDurationOf }: { ctxNow: number; bufferDurationOf: (mediaId: string) => number | null },
): ScheduledSource[] {
  const out: ScheduledSource[] = [];

  for (const clip of clips) {
    const disponivel = bufferDurationOf(clip.mediaId);
    // Sem buffer decodificado não há o que agendar. Não é erro: a trilha pode
    // ainda estar vindo, e o próximo reagendamento a pega.
    if (disponivel === null) continue;

    const sobra = Math.max(0, disponivel - clip.offset);
    const duration = Math.min(clip.duration, sobra);
    if (duration <= 0) continue;

    out.push({
      layerId: clip.layerId,
      mediaId: clip.mediaId,
      when: Math.max(ctxNow, ctxNow + clip.at),
      offset: clip.offset,
      duration,
      gain: clip.gain,
    });
  }

  return out;
}
