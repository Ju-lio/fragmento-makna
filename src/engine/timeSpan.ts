/**
 * De quem é o instante `t` — a regra, num lugar só.
 *
 * ## Por que isto virou um módulo
 *
 * A pergunta "este clipe aparece em `t`?" estava escrita **quatro vezes**, e
 * duas delas respondiam diferente. O som usava `t < start + duration`; a
 * imagem, `t <= start + duration`. Com um clipe só, a diferença é invisível.
 * Com dois clipes encostados — que é o que um corte produz — ela é o defeito:
 *
 *   A = [0s, 3s)   B = [3s, 6s)   a 30fps, o quadro 90 está em t = 3,0
 *
 * Pela regra da imagem, o quadro 90 pertencia aos DOIS. As consequências
 * apareciam todas na fronteira, que é justamente onde se olha ao cortar:
 *
 *  - `framesReadyAt` exigia o quadro de A **e** o de B pra desenhar o corte. O
 *    preview esperava por um quadro que não ia mostrar — engasgo em todo corte.
 *  - Quem desenha por cima é o último de `drawOrder`, e entre clipes da mesma
 *    faixa isso é a ordem do ARRAY. Num remix a ordem do array não é a ordem da
 *    linha do tempo, então o clipe que ficava por cima na fronteira podia ser o
 *    que estava **terminando**. Um quadro do clipe errado, em cada corte, e só
 *    em projetos reorganizados — que é exatamente o sintoma relatado.
 *  - Um clipe de 3s a 30fps cobria 91 quadros. Um clipe de 3s tem 90.
 *
 * ## A regra
 *
 * O trecho é **meio-aberto**: `[start, start + duration)`. A fronteira pertence
 * a quem entra, nunca a quem sai. É a mesma convenção que o som já usava e a
 * mesma que qualquer NLE usa — um clipe de N segundos a F quadros por segundo
 * ocupa `round(N × F)` quadros, e nem um a mais.
 *
 * O corolário que não é opcional: um intervalo `[from, to)` da linha do tempo
 * contém os quadros `frameIndexAt(from) .. frameIndexAt(to) - 1`. Ver
 * `lastFrameIndex` no `frameCache.ts` — o export contava o quadro de `to`, e
 * era o mesmo erro pelo outro lado. Os dois se cancelavam, e por isso nenhum
 * dos dois tinha aparecido: o quadro extra do export era preenchido pelo quadro
 * extra do clipe.
 */

import type { TimeSpan } from './types.ts';

/**
 * O instante `t` cai dentro deste trecho?
 *
 * Meio-aberto de propósito — ver o cabeçalho. Se você está prestes a escrever
 * `t <= start + duration` em algum lugar, é este o lugar que já respondeu.
 */
export function coversAt(span: TimeSpan, t: number): boolean {
  return t >= span.start && t < span.start + span.duration;
}
