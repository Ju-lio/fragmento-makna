/**
 * O contrato entre um efeito e o editor.
 *
 * Um efeito do Fragmento é HTML + CSS + (opcionalmente) TS. Este arquivo
 * define as duas únicas coisas que o autor precisa declarar além disso:
 *
 *   meta   — o que é (efeito, filtro, transição, texto). Decide em que aba
 *            aparece e como o compositor trata.
 *   params — os controles que o editor deve desenhar.
 *
 * `params` é **fonte única**, e é essa a ideia toda: o mesmo objeto que o
 * runtime percorre pra montar os campos do painel é o que o TypeScript lê
 * pra tipar `p` dentro do código do autor. Declarar `intensidade: num(0.5)`
 * faz nascer um slider no editor E faz `p.intensidade` ser `number` — sem
 * schema duplicado, sem cast, sem os dois saírem de sincronia.
 *
 * Puro de propósito: nada aqui toca DOM, React ou canvas. É o que permite
 * testar o contrato inteiro em node, do mesmo jeito que `src/engine/`.
 *
 * Ver LIMITES.md para o que um efeito pode e não pode fazer.
 */

// --- o que é ------------------------------------------------------------

/**
 * A "tag" que identifica o efeito.
 *
 * Em português porque é o que o autor escreve, e o público-alvo é
 * brasileiro. Um porte pra inglês trocaria estas quatro strings e o mapa de
 * rótulos — de propósito, nada mais no motor depende delas.
 */
export const TIPOS = ['efeito', 'filtro', 'transicao', 'texto'] as const;
export type Tipo = (typeof TIPOS)[number];

export interface Meta {
  tipo: Tipo;
  nome: string;
  autor?: string;
  /** Versão do efeito, do autor. Não confundir com a do formato. */
  versao?: string;
}

// --- descritores de parâmetro -------------------------------------------

interface Comum {
  /** O que aparece ao lado do campo. Ausente = o nome da chave. */
  rotulo?: string;
  /** Texto de ajuda, mostrado no editor. */
  ajuda?: string;
}

export interface DescNum extends Comum {
  tipo: 'num';
  padrao: number;
  min?: number;
  max?: number;
  passo?: number;
  /** Sufixo aplicado na variável CSS: `8` com `unidade:'px'` vira `8px`. */
  unidade?: string;
}

export interface DescCor extends Comum {
  tipo: 'cor';
  /** Qualquer cor CSS. Não normalizamos: `#f00`, `red` e `rgb()` servem. */
  padrao: string;
}

export interface DescBool extends Comum {
  tipo: 'bool';
  padrao: boolean;
}

export interface DescTexto extends Comum {
  tipo: 'texto';
  padrao: string;
  /** Mais de uma linha vira textarea no painel. */
  linhas?: number;
}

export interface DescOpcao<T extends readonly string[] = readonly string[]> extends Comum {
  tipo: 'opcao';
  valores: T;
  padrao: T[number];
}

export type Desc = DescNum | DescCor | DescBool | DescTexto | DescOpcao;

/** O objeto que o autor exporta como `params`. */
export type Esquema = Record<string, Desc>;

// --- construtores -------------------------------------------------------
// Existem pra que o autor escreva `num(0.5, { max: 2 })` em vez de repetir
// `{ tipo: 'num', padrao: 0.5, max: 2 }` — e pra que o `tipo` nunca seja
// digitado errado, porque quem escreve é a função.

export const num = (padrao: number, o: Omit<DescNum, 'tipo' | 'padrao'> = {}): DescNum =>
  ({ tipo: 'num', padrao, ...o });

export const cor = (padrao: string, o: Comum = {}): DescCor =>
  ({ tipo: 'cor', padrao, ...o });

export const bool = (padrao: boolean, o: Comum = {}): DescBool =>
  ({ tipo: 'bool', padrao, ...o });

export const texto = (padrao: string, o: Omit<DescTexto, 'tipo' | 'padrao'> = {}): DescTexto =>
  ({ tipo: 'texto', padrao, ...o });

/**
 * `const T` é o que segura os literais: sem ele, `opcao(['screen','multiply'])`
 * viraria `string[]` e `p.modo` seria `string` em vez de
 * `'screen' | 'multiply'` — perdendo justamente a checagem que faz o autor
 * descobrir o erro de digitação em tempo de compilação.
 */
export const opcao = <const T extends readonly string[]>(
  valores: T,
  padrao: T[number],
  o: Comum = {},
): DescOpcao<T> => ({ tipo: 'opcao', valores, padrao, ...o });

// --- a ponte de tipos ---------------------------------------------------

/** O valor que cada descritor produz. É o coração do "estilo Unity". */
export type Valor<D> =
  D extends DescNum ? number :
  D extends DescCor ? string :
  D extends DescBool ? boolean :
  D extends DescTexto ? string :
  D extends DescOpcao<infer T> ? T[number] :
  never;

/**
 * Os valores resolvidos de um esquema — o que chega no código do autor.
 *
 * ```ts
 * export const params = { forca: num(0.5), modo: opcao(['screen','multiply'], 'screen') };
 * export function desenhar(c: Ctx<typeof params>) {
 *   c.p.forca   // number
 *   c.p.modo    // 'screen' | 'multiply'
 * }
 * ```
 */
export type Params<E extends Esquema> = { [K in keyof E]: Valor<E[K]> };

/** O que o efeito recebe a cada quadro. */
export interface Ctx<E extends Esquema> {
  /** Os valores dos controles, já normalizados. */
  p: Params<E>;
  /** Tempo absoluto na linha do tempo, em segundos. */
  t: number;
  /** Progresso 0..1 dentro da janela do efeito. */
  progresso: number;
  largura: number;
  altura: number;
  /**
   * Aleatório SEMEADO. `Math.random()` quebra o export — ver LIMITES.md §2.1.
   * A semente vem do editor e é estável, então o mesmo `t` dá sempre o mesmo
   * quadro.
   */
  rng: () => number;
}

// --- runtime ------------------------------------------------------------

/** Os valores iniciais de um esquema. */
export function padroes<E extends Esquema>(esquema: E): Params<E> {
  const saida = {} as Params<E>;
  for (const chave of Object.keys(esquema) as Array<keyof E>) {
    (saida as Record<string, unknown>)[chave as string] = esquema[chave]!.padrao;
  }
  return saida;
}

const limitar = (v: number, min?: number, max?: number) =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/**
 * Valores do usuário → valores utilizáveis. **Sempre** devolve algo desenhável.
 *
 * Corrige em silêncio de propósito: isto roda no caminho do desenho, 30 vezes
 * por segundo, e um efeito que se recusa a renderizar porque um número veio
 * como string é pior que um efeito que cai no padrão. Quem quer saber o que
 * estava errado chama `conferirValores` — que é o que o painel usa pra
 * mostrar o aviso, uma vez, em vez de a cada quadro.
 */
export function normalizar<E extends Esquema>(esquema: E, brutos: unknown): Params<E> {
  const fonte = (typeof brutos === 'object' && brutos ? brutos : {}) as Record<string, unknown>;
  const saida = {} as Record<string, unknown>;

  for (const chave of Object.keys(esquema)) {
    const d = esquema[chave]!;
    const v = fonte[chave];

    switch (d.tipo) {
      case 'num': {
        // `Number('')` é 0, e string vazia num campo numérico quer dizer
        // "apaguei pra digitar de novo", não "zero".
        const n = typeof v === 'number' ? v : (v === '' || v == null ? NaN : Number(v));
        saida[chave] = Number.isFinite(n) ? limitar(n, d.min, d.max) : d.padrao;
        break;
      }
      case 'cor':
      case 'texto':
        saida[chave] = typeof v === 'string' ? v : d.padrao;
        break;
      case 'bool':
        saida[chave] = typeof v === 'boolean' ? v : d.padrao;
        break;
      case 'opcao':
        saida[chave] = typeof v === 'string' && d.valores.includes(v) ? v : d.padrao;
        break;
    }
  }
  return saida as Params<E>;
}

/** O que estava errado nos valores. Vazio = tudo certo. Ver `normalizar`. */
export function conferirValores<E extends Esquema>(esquema: E, brutos: unknown): string[] {
  const fonte = (typeof brutos === 'object' && brutos ? brutos : {}) as Record<string, unknown>;
  const problemas: string[] = [];

  for (const chave of Object.keys(esquema)) {
    const d = esquema[chave]!;
    const v = fonte[chave];
    if (v === undefined) continue;   // ausente é normal: cai no padrão

    if (d.tipo === 'num') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) problemas.push(`"${chave}" precisa ser número.`);
      else if (n !== limitar(n, d.min, d.max)) {
        problemas.push(`"${chave}" fora da faixa (${d.min ?? '-∞'} a ${d.max ?? '∞'}).`);
      }
    } else if (d.tipo === 'bool') {
      if (typeof v !== 'boolean') problemas.push(`"${chave}" precisa ser true ou false.`);
    } else if (d.tipo === 'opcao') {
      if (typeof v !== 'string' || !d.valores.includes(v)) {
        problemas.push(`"${chave}" precisa ser um de: ${d.valores.join(', ')}.`);
      }
    } else if (typeof v !== 'string') {
      problemas.push(`"${chave}" precisa ser texto.`);
    }
  }
  return problemas;
}

/**
 * Os params viram variáveis CSS, e é assim que eles chegam no CSS do autor:
 *
 * ```css
 * .raio { filter: drop-shadow(0 0 var(--p-brilho) var(--p-cor)); }
 * ```
 *
 * O prefixo `--p-` existe pra não colidir com as variáveis do próprio autor
 * nem com as que o editor injeta pra outras coisas (`--frag-*`).
 *
 * Medido: variável CSS animada via `@property` funciona dentro do snapshot —
 * ver LIMITES.md §3. É por isso que este é o caminho, e não substituição de
 * texto no CSS.
 */
export function variaveisCss<E extends Esquema>(
  esquema: E,
  valores: Params<E>,
): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const chave of Object.keys(esquema)) {
    const d = esquema[chave]!;
    const v = (valores as Record<string, unknown>)[chave];
    let texto: string;
    switch (d.tipo) {
      // A unidade entra aqui e não no painel: o campo mostra "8", o CSS
      // recebe "8px". Sem isso o autor escreveria `calc(var(--p-x) * 1px)`
      // em todo lugar.
      case 'num': texto = `${v}${d.unidade ?? ''}`; break;
      // Booleano vira 1/0 porque CSS não tem booleano: o autor multiplica
      // (`scale(calc(1 + var(--p-pulsa) * .2))`) ou usa em `opacity`.
      case 'bool': texto = v ? '1' : '0'; break;
      // Texto vai entre aspas pra servir direto em `content:`.
      case 'texto': texto = JSON.stringify(String(v)); break;
      default: texto = String(v);
    }
    saida[`--p-${chave}`] = texto;
  }
  return saida;
}

// --- validação de carga -------------------------------------------------

/**
 * Recebe `unknown` de propósito: é um arquivo de terceiro chegando: nada
 * pode ser assumido. É aqui que `unknown` legitimamente vira `Meta`, e em
 * nenhum outro ponto — mesma regra do `validateEffect` em `effects.ts`.
 */
export function validarMeta(bruto: unknown): string | null {
  if (typeof bruto !== 'object' || !bruto) return 'Faltou o `meta` do efeito.';
  const m = bruto as Partial<Meta>;
  if (typeof m.tipo !== 'string' || !TIPOS.includes(m.tipo as Tipo)) {
    return `meta.tipo inválido: "${m.tipo}". Use: ${TIPOS.join(', ')}.`;
  }
  if (typeof m.nome !== 'string' || !m.nome.trim()) return 'meta.nome não pode ficar vazio.';
  return null;
}

const CHAVE_VALIDA = /^[a-z][a-zA-Z0-9]*$/;

/** Confere o esquema em si — não os valores. Roda uma vez, na carga. */
export function validarEsquema(bruto: unknown): string | null {
  if (typeof bruto !== 'object' || !bruto) return '`params` precisa ser um objeto.';
  const e = bruto as Record<string, unknown>;

  for (const chave of Object.keys(e)) {
    // A chave vira `--p-<chave>` no CSS, então precisa ser um identificador
    // seguro. Rejeitar aqui é muito melhor que gerar CSS quebrado depois.
    if (!CHAVE_VALIDA.test(chave)) {
      return `nome de param inválido: "${chave}". Use letras e números, começando com minúscula.`;
    }
    const d = e[chave] as Partial<Desc> | null;
    if (typeof d !== 'object' || !d) return `param "${chave}" precisa ser um descritor.`;
    if (!d.tipo) return `param "${chave}" sem tipo. Use num, cor, bool, texto ou opcao.`;

    switch (d.tipo) {
      case 'num':
        if (typeof d.padrao !== 'number' || !Number.isFinite(d.padrao)) {
          return `param "${chave}": padrão precisa ser número.`;
        }
        if (d.min != null && d.max != null && d.min > d.max) {
          return `param "${chave}": min (${d.min}) maior que max (${d.max}).`;
        }
        break;
      case 'cor':
      case 'texto':
        if (typeof d.padrao !== 'string') return `param "${chave}": padrão precisa ser texto.`;
        break;
      case 'bool':
        if (typeof d.padrao !== 'boolean') return `param "${chave}": padrão precisa ser booleano.`;
        break;
      case 'opcao': {
        const vals = (d as DescOpcao).valores;
        if (!Array.isArray(vals) || !vals.length) return `param "${chave}": faltou a lista de valores.`;
        if (!vals.includes((d as DescOpcao).padrao)) {
          return `param "${chave}": padrão "${(d as DescOpcao).padrao}" não está na lista.`;
        }
        break;
      }
      default:
        return `param "${chave}": tipo desconhecido "${(d as { tipo: string }).tipo}".`;
    }
  }
  return null;
}

/** O manifesto inteiro. `null` = pode carregar. */
export function validarManifesto(bruto: unknown): string | null {
  if (typeof bruto !== 'object' || !bruto) return 'Manifesto vazio.';
  const m = bruto as { meta?: unknown; params?: unknown };
  const problemaMeta = validarMeta(m.meta);
  if (problemaMeta) return problemaMeta;
  // `params` é opcional: efeito sem controle nenhum é legítimo.
  if (m.params === undefined) return null;
  return validarEsquema(m.params);
}
