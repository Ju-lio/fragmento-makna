/**
 * O avanço do playhead — puro, sem rAF, sem DOM.
 *
 * Vive fora do `player` pela mesma razão que `videoSyncPlan` vive fora do
 * `videoSync`: é aqui que moram os erros de um quadro, e um erro de um quadro
 * não se enxerga olhando a tela. Errar aqui significa o preview mostrar um
 * instante que o arquivo exportado não contém — que foi exatamente o bug que
 * este arquivo veio matar.
 *
 * ## A regra
 *
 * O tempo entra em **segundos** e sai em **quadros inteiros**. `t` é sempre
 * `frame / fps`, jamais um valor entre dois quadros.
 *
 * O relógio anterior fazia `t += dt` com o `dt` do rAF e deixava o
 * arredondamento pra grade acontecer lá na frente, na hora de indexar o cache.
 * Isso amostrava **onde o rAF calhasse de cair**, não a grade — e como o rAF
 * depende do escalonamento do navegador, cada reprodução amostrava um conjunto
 * diferente de instantes. Daí o sintoma que não se conseguia reproduzir duas
 * vezes igual: som parando antes, clipe cortando antes, nunca no mesmo lugar,
 * sem ninguém ter editado nada.
 *
 * A propriedade que se ganha, e que os testes fixam:
 *
 *   **Todo instante que o preview mostra é um instante que o export renderiza.**
 *   Sob carga a reprodução mostra MENOS quadros; nunca um quadro diferente.
 */

import { frameIndexAt, timeAtFrameIndex } from './frameCache.ts';

export interface ClockState {
  /** Quadro atual. É a posição de verdade — `t` é derivado dele. */
  frame: number;
  /**
   * Tempo decorrido que ainda não completou um quadro.
   *
   * Guardar a sobra é o que mantém o andamento certo. Descartá-la faria a
   * reprodução perder um pedacinho a cada passo, e um minuto de vídeo
   * terminaria segundos atrás do som.
   */
  accum: number;
}

export interface AdvanceInput extends ClockState {
  /** Segundos decorridos desde o passo anterior. */
  elapsed: number;
  fps: number;
  duration: number;
  loop: boolean;
}

export interface AdvanceResult extends ClockState {
  /** Instante a mostrar. Sempre na grade. */
  t: number;
  /**
   * O quadro mudou?
   *
   * Falso significa que não há nada novo pra pintar — num monitor de 60Hz com
   * projeto a 30fps isso acontece em metade dos ticks, e repintar neles seria
   * desenhar duas vezes o mesmo quadro.
   */
  stepped: boolean;
  /** Chegou ao fim e não há laço: o transporte deve parar. */
  ended: boolean;
}

export function advanceClock(
  { frame, accum, elapsed, fps, duration, loop }: AdvanceInput,
): AdvanceResult {
  const carried = accum + elapsed;

  /**
   * Quantos quadros o mundo real andou. Normalmente 0 ou 1.
   *
   * Acima de 1 significa que o navegador engasgou e a reprodução vai **pular**
   * quadros — que é o que qualquer editor de vídeo faz, e é honesto. O que não
   * pode acontecer, e antes acontecia, é inventar um instante intermediário
   * pra "não perder nada": esse instante não existe no arquivo final.
   */
  const step = Math.floor(carried * fps);

  if (step <= 0) {
    return { frame, accum: carried, t: timeAtFrameIndex(frame, fps), stepped: false, ended: false };
  }

  const next = frame + step;
  const rest = carried - step / fps;
  const t = timeAtFrameIndex(next, fps);

  if (t < duration) return { frame: next, accum: rest, t, stepped: true, ended: false };

  if (loop) {
    // Zera a sobra junto. Carregá-la pra volta do laço faria cada repetição
    // começar um pouquinho adiante da anterior, e depois de muitas voltas a
    // trilha entraria visivelmente fora do lugar.
    return { frame: 0, accum: 0, t: 0, stepped: true, ended: false };
  }

  // Para no último quadro da grade — o mesmo que o exportador chama de último
  // (`frameIndexAt(to, fps)`), pra que parar no fim e exportar até o fim
  // concordem sobre onde é o fim.
  const lastFrame = frameIndexAt(duration, fps);
  return {
    frame: lastFrame,
    accum: 0,
    t: timeAtFrameIndex(lastFrame, fps),
    stepped: true,
    ended: true,
  };
}
