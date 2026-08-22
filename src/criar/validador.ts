/**
 * O que está errado num efeito — antes de ele estragar um vídeo.
 *
 * Implementa a §6 do LIMITES.md, que é a especificação. Cada checagem existe
 * porque o modo de falha correspondente é **silencioso**: o efeito parece
 * certo na tela de quem escreveu e sai errado no arquivo de quem usou. Um
 * `Math.random()` só aparece como tremeliques no MP4; uma fonte não embutida
 * só aparece na máquina de outra pessoa; um `@import` só aparece no export.
 *
 * Três níveis, e a diferença importa:
 *
 *   erro  — não carrega. O efeito está quebrado, não "diferente".
 *   aviso — carrega, mas provavelmente não faz o que o autor quis.
 *   custo — funciona, e vai doer no export. Informação, não julgamento.
 *
 * Puro: string entra, lista sai. Nada aqui toca DOM — o mesmo módulo serve o
 * `/criar` enquanto se digita, e a importação de um pacote de terceiro.
 */

import { validarMeta, validarEsquema } from './api.ts';
import { recursosExternos, temStyleInline, fontesFaltando } from './svg.ts';

export type Nivel = 'erro' | 'aviso' | 'custo';

export interface Problema {
  nivel: Nivel;
  /** O que está errado, em uma frase, pra quem escreveu o efeito. */
  mensagem: string;
  /** O que fazer. Ausente quando não há saída — só a informação. */
  saida?: string;
}

export interface PacoteParaAnalise {
  meta?: unknown;
  params?: unknown;
  html: string;
  css: string;
  /** Famílias que o pacote traz embutidas. */
  fontes?: string[];
}

/** Quantos elementos o HTML declara. Ver o custo medido em LIMITES.md §5. */
export function contarNos(html: string): number {
  return (html.match(/<[a-zA-Z][^>]*>/g) ?? [])
    .filter(tag => !/^<\/|^<!/.test(tag)).length;
}

/** O maior raio de desfoque pedido no CSS, em px. Zero se não houver nenhum. */
export function maiorDesfoque(css: string): number {
  let maior = 0;
  for (const [, valor] of css.matchAll(/(?:blur|drop-shadow)\s*\(([^)]*)\)/gi)) {
    for (const [, n] of (valor ?? '').matchAll(/(-?[\d.]+)px/g)) {
      maior = Math.max(maior, Math.abs(parseFloat(n ?? '0')));
    }
  }
  return maior;
}

/**
 * Chaves desbalanceadas no CSS.
 *
 * Não é um parser: é a checagem grosseira que pega o erro mais comum de todos
 * (esqueceu de fechar um bloco) sem trazer uma dependência. O que escapar
 * daqui o navegador ignora em silêncio — que é ruim, mas não pior do que
 * fingir que este módulo entende CSS.
 */
export function chavesDesbalanceadas(css: string): number {
  const semComentario = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const abre = (semComentario.match(/\{/g) ?? []).length;
  const fecha = (semComentario.match(/\}/g) ?? []).length;
  return abre - fecha;
}

/** Marca de slot: `data-frag="video1"`. Ver LIMITES.md §4.1. */
const TEM_SLOT = /data-frag\s*=/i;

/** Cada padrão que denuncia código não determinístico, com o nome que aparece. */
const NAO_DETERMINISTICO: Array<[RegExp, string]> = [
  [/\bMath\s*\.\s*random\s*\(/, 'Math.random()'],
  [/\bDate\s*\.\s*now\s*\(/, 'Date.now()'],
  [/\bnew\s+Date\s*\(/, 'new Date()'],
  [/\bperformance\s*\.\s*now\s*\(/, 'performance.now()'],
];

const REDE: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bimport\s*\(/, 'import() dinâmico'],
];

const CANVAS: Array<[RegExp, string]> = [
  [/<canvas[\s>]/i, '<canvas>'],
  [/\bWebGL2?RenderingContext\b/, 'WebGL'],
  [/\bgetContext\s*\(\s*['"]webgl/i, 'getContext("webgl")'],
  [/\bTHREE\s*\./, 'Three.js'],
];

/**
 * Analisa um pacote. Lista vazia = pode carregar sem ressalva.
 *
 * A ordem importa: erros primeiro, porque quem vê um erro não precisa ler os
 * avisos ainda.
 */
export function analisar(pacote: PacoteParaAnalise): Problema[] {
  const { html, css, fontes = [] } = pacote;
  const tudo = `${html}\n${css}`;
  const problemas: Problema[] = [];
  const erro = (mensagem: string, saida?: string) => problemas.push({ nivel: 'erro', mensagem, saida });
  const aviso = (mensagem: string, saida?: string) => problemas.push({ nivel: 'aviso', mensagem, saida });
  const custo = (mensagem: string, saida?: string) => problemas.push({ nivel: 'custo', mensagem, saida });

  // --- erros ------------------------------------------------------------

  const problemaMeta = validarMeta(pacote.meta);
  if (problemaMeta) erro(problemaMeta);

  if (pacote.params !== undefined) {
    const problemaParams = validarEsquema(pacote.params);
    if (problemaParams) erro(problemaParams);
  }

  const sobrando = chavesDesbalanceadas(css);
  if (sobrando > 0) erro(`Faltam ${sobrando} chave(s) "}" no CSS.`);
  if (sobrando < 0) erro(`Sobram ${-sobrando} chave(s) "}" no CSS.`);

  for (const url of recursosExternos(css)) {
    erro(
      `Recurso externo não carrega no quadro final: ${url}`,
      'Traga o arquivo pro pacote e ele entra embutido.',
    );
  }

  // --- avisos -----------------------------------------------------------

  for (const [padrao, nome] of NAO_DETERMINISTICO) {
    if (!padrao.test(tudo)) continue;
    aviso(
      `${nome} deixa o efeito não determinístico — o vídeo exportado vai tremer.`,
      'Use rng(), que recebe a semente do editor e devolve sempre o mesmo valor pro mesmo instante.',
    );
  }

  for (const [padrao, nome] of REDE) {
    if (padrao.test(tudo)) aviso(`${nome} não funciona: o efeito roda offline, sem rede.`);
  }

  for (const [padrao, nome] of CANVAS) {
    if (!padrao.test(tudo)) continue;
    aviso(
      `${nome} não aparece no quadro: conteúdo de canvas não entra no snapshot.`,
      'Pseudo-3D com perspective/rotateY funciona. Pra 3D de verdade, exporte de outra ferramenta e importe como mídia.',
    );
  }

  // `onclick=`, `onload=`… nunca disparam: o palco é um iframe com sandbox
  // sem `allow-scripts`, e o snapshot é imagem estática. O navegador ainda
  // reclama no console, o que faz o autor procurar defeito no lugar errado.
  const handlers = [...new Set(
    [...html.matchAll(/\son([a-z]+)\s*=/gi)].map(m => `on${(m[1] ?? '').toLowerCase()}`),
  )];
  if (handlers.length) {
    aviso(
      `Handler inline no HTML (${handlers.join(', ')}) nunca dispara — o efeito é imagem estática, não página.`,
      'Tudo que muda com o tempo tem que estar em @keyframes.',
    );
  }

  if (temStyleInline(html)) {
    aviso(
      '<style> dentro do HTML não passa pelo CDATA — um "<" ali dentro quebra o quadro inteiro.',
      'Mova as regras pro arquivo de CSS.',
    );
  }

  for (const familia of fontesFaltando(css, fontes)) {
    aviso(
      `A fonte "${familia}" não vem no pacote — em outra máquina o texto sai com outra fonte, e o layout muda.`,
      'Embuta a fonte no pacote, ou use uma das genéricas do CSS.',
    );
  }

  if (/backdrop-filter/i.test(css) && !TEM_SLOT.test(html)) {
    aviso(
      'backdrop-filter só enxerga o que está dentro do próprio efeito — o vídeo não está.',
      'Pra desfocar o vídeo, declare um slot: data-frag="vidro".',
    );
  }

  // --- custo ------------------------------------------------------------

  const nos = contarNos(html);
  if (nos > 500) {
    custo(
      `${nos} elementos no efeito. Medido: 500 custam ~45 ms por quadro, 2000 custam ~143 ms.`,
      'Pra muitos pedaços (partículas, chuva), um slot por pedaço sai mais barato que um nó de DOM por pedaço.',
    );
  }

  const desfoque = maiorDesfoque(css);
  if (desfoque > 30) {
    custo(
      `Desfoque de ${desfoque}px. Medido: blur(40px) custa ~45 ms por quadro em 1080p.`,
      'Não é culpa do DOM — no canvas 2D custa mais ainda. É o preço do desfoque grande.',
    );
  }

  return problemas;
}

/** Pode carregar? Aviso e custo não impedem. */
export const podeCarregar = (problemas: Problema[]): boolean =>
  !problemas.some(p => p.nivel === 'erro');

/**
 * O efeito cobre o quadro inteiro por muito tempo?
 *
 * Separado de `analisar` porque depende do PROJETO (duração da layer contra
 * duração do vídeo), e não só do pacote. É o pior caso medido: uma vinheta
 * cobrindo tudo custou ~231 ms por quadro em 1080p, o que vira +6,9 min num
 * vídeo de 60 s.
 */
export function avisoDeCobertura(duracaoDaLayer: number, duracaoDoProjeto: number): Problema | null {
  if (duracaoDoProjeto <= 0) return null;
  const fracao = duracaoDaLayer / duracaoDoProjeto;
  if (fracao < 0.2) return null;
  return {
    nivel: 'custo',
    mensagem: `Este efeito ocupa ${Math.round(fracao * 100)}% do vídeo. Efeito que cobre o quadro`
      + ' inteiro paga rasterização em todos esses quadros no export.',
    saida: 'Um título de 3 s num vídeo de 60 s custa segundos; uma vinheta do começo ao fim custa minutos.',
  };
}
