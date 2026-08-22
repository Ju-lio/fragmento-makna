/**
 * A janela de tempo de um efeito, descrita como esquema de params.
 *
 * É o primeiro uso real de `api.ts`, e serve de cobaia de propósito: o
 * vocabulário de `TimeWindow` (duração, atraso, âncora, repetir) já existe,
 * já é editado hoje — só que **editando JSON na mão**. Se o esquema não der
 * conta nem disto, não vai dar conta de efeito nenhum.
 *
 * Puro e sem React: o painel só desenha o que este arquivo descreve.
 */

import { num, bool, opcao, normalizar } from './api.ts';
import type { Params } from './api.ts';
import type { Effect, TimeWindow } from '../engine/types.ts';

/**
 * Os quatro controles de uma janela de tempo.
 *
 * `max` em segundos é generoso de propósito: passar de 30s de duração num
 * efeito de entrada quase sempre é engano, e o limite é o que impede um
 * arrasto de slider de produzir um efeito que nunca termina. Quem precisar de
 * mais continua podendo colar o JSON.
 */
export const ESQUEMA_JANELA = {
  duration: num(1, { min: 0.05, max: 30, passo: 0.05, rotulo: 'Duração', unidade: 's' }),
  delay: num(0, { min: 0, max: 30, passo: 0.05, rotulo: 'Atraso', unidade: 's' }),
  anchor: opcao(['start', 'end'] as const, 'start', {
    rotulo: 'Âncora',
    ajuda: 'start = animação de entrada · end = de saída, ancorada no fim da layer',
  }),
  loop: bool(false, { rotulo: 'Repetir', ajuda: 'Recomeça pra sempre enquanto a layer estiver na tela' }),
};

export type ValoresJanela = Params<typeof ESQUEMA_JANELA>;

/**
 * Efeito → valores dos controles.
 *
 * Os ausentes viram os padrões do esquema, e não `undefined`: o painel precisa
 * de um número pra desenhar o slider, e `duration` ausente já significa 1
 * segundo em `effectProgress`. Os dois lados concordam — se um dia o padrão
 * mudar lá, tem que mudar aqui, e é por isso que este arquivo diz de onde o
 * número veio.
 */
export function janelaDeEfeito(eff: TimeWindow): ValoresJanela {
  return normalizar(ESQUEMA_JANELA, {
    duration: eff.duration,
    delay: eff.delay,
    anchor: eff.anchor,
    loop: eff.loop,
  });
}

/**
 * Valores dos controles → efeito novo.
 *
 * Devolve uma cópia: efeito é dado do projeto, e o histórico de undo guarda
 * referências. Mutar o objeto no lugar faria o Ctrl+Z "desfazer" pra um estado
 * que já tinha sido alterado junto.
 *
 * Campos que estão no padrão são OMITIDOS do objeto — `delay: 0` e
 * `anchor: 'start'` são exatamente o que a ausência já significa, e escrevê-los
 * incharia todo efeito colado com ruído que o `.frag` carregaria pra sempre.
 * Ver o mesmo cuidado em `serialize.ts`.
 */
export function comJanela(eff: Effect, valores: ValoresJanela): Effect {
  const v = normalizar(ESQUEMA_JANELA, valores);
  const saida: Effect = { ...eff, tracks: eff.tracks, duration: v.duration };

  if (v.delay > 0) saida.delay = v.delay;
  else delete saida.delay;

  if (v.anchor === 'end') saida.anchor = 'end';
  else delete saida.anchor;

  if (v.loop) saida.loop = true;
  else delete saida.loop;

  return saida;
}
