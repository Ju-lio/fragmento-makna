/**
 * Contador numérico animado — o "count up" (tipo reactbits.dev), mas como
 * campo dedicado da layer de texto, e não como efeito de transformação.
 *
 * Ver o porquê em `CountUp` (types.ts): conteúdo não compõe por soma/
 * multiplicação como as 8 props de `effects.ts`, então este módulo é
 * INDEPENDENTE do vocabulário de `Effect`/`AnimProp`/`resolveState`. A única
 * coisa emprestada de lá é `effectProgress`, que já resolve a janela de tempo
 * (delay, anchor, loop) sem saber nem se importar com o que está animando —
 * ver `TimeWindow`.
 */

import { EASE } from './easings.ts';
import { effectProgress } from './effects.ts';
import type { CountUp, TextLayer, TimeSpan } from './types.ts';

/**
 * Progresso 0..1 da contagem.
 *
 * Duração ausente cai na duração da LAYER inteira — diferente do padrão de 1s
 * de `Effect`. Faz sentido pros dois: um efeito de transformação costuma ser
 * um floreio de entrada/saída curto; um contador normalmente deve rodar
 * enquanto o texto está na tela.
 *
 * `null` (que `effectProgress` devolve só em `anchor: 'end'` ou `loop` ainda
 * fora da janela) vira 0 aqui: a layer já está desenhada nesse instante, e
 * "a contagem ainda não começou" é exatamente o mesmo que mostrar `from`.
 */
export function countUpProgress(cu: CountUp, layer: TimeSpan, t: number): number {
  const duration = cu.duration ?? layer.duration;
  const window = { duration, delay: cu.delay, anchor: cu.anchor, loop: cu.loop };
  return effectProgress(window, layer, t) ?? 0;
}

/** Valor numérico interpolado (sem formatação) no instante `t`. */
export function countUpValue(cu: CountUp, layer: TimeSpan, t: number): number {
  const p = countUpProgress(cu, layer, t);
  const fn = (cu.ease && EASE[cu.ease]) || EASE.linear;
  return cu.from + (cu.to - cu.from) * fn(p);
}

/**
 * Formata um valor já resolvido: casas decimais, separador de milhar,
 * prefixo/sufixo.
 *
 * Sempre `pt-BR` — o app inteiro fala português, e o exemplo padrão do
 * projeto ("559.872 km rodados") já usa o formato brasileiro. `separator`
 * troca só o AGRUPAMENTO de milhar; o separador DECIMAL continua sendo
 * vírgula nos dois casos — desligar um não deveria trocar o outro, ou
 * "separador: false" pareceria mudar duas coisas por uma.
 *
 * `decimals` é saneado aqui (nunca negativo, sempre inteiro): a entrada pode
 * vir de um `.frag` editado à mão.
 */
export function formatCountUp(value: number, cu: CountUp): string {
  const decimals = Math.max(0, Math.round(cu.decimals ?? 0));
  const body = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: cu.separator !== false,
  }).format(value);
  return `${cu.prefix ?? ''}${body}${cu.suffix ?? ''}`;
}

/**
 * O que `drawText` e `layerBox` devem mostrar/medir neste instante — o ÚNICO
 * lugar onde "tem contador ou não" é decidido.
 *
 * Precisa ser chamado dos DOIS lugares (desenho e medição da moldura de
 * seleção), nunca só de um: divergir faria a moldura e o hit-test do gizmo
 * continuarem medindo o `text` estático enquanto o número na tela muda de
 * largura a cada quadro — clique erraria, moldura ficaria presa no tamanho
 * errado.
 */
export function displayText(layer: TextLayer, t: number): string {
  if (!layer.countUp) return layer.text;
  return formatCountUp(countUpValue(layer.countUp, layer, t), layer.countUp);
}

/**
 * Lê um número já digitado no campo de texto ("559.872 km rodados") e separa
 * prefixo/número/sufixo — pra pré-popular `to` quando o contador é ligado,
 * sem o usuário redigitar o que já escreveu.
 *
 * Entende separador de milhar (ponto) e decimal (vírgula) no formato BR.
 * `null` quando não há dígito nenhum no texto — aí a UI cai num padrão fixo.
 */
export function seedCountUpFromText(text: string): Pick<CountUp, 'to' | 'prefix' | 'suffix'> | null {
  const m = /^(\D*)(\d[\d.,]*\d|\d)(\D*)$/.exec(text.trim());
  if (!m) return null;
  const [, prefix = '', numStr = '', suffix = ''] = m;
  const to = parseFloat(numStr.replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(to)) return null;
  return { to, prefix, suffix };
}
