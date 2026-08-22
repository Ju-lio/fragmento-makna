/**
 * A montagem do SVG que carrega o overlay — a metade PURA da rasterização.
 *
 * Fica separada de `overlay.ts` porque é string entra, string sai: dá pra
 * testar em node, sem navegador, do mesmo jeito que o resto do motor. O que
 * precisa de DOM (levar a animação ao instante `t`, serializar o palco vivo,
 * decodificar a imagem) fica lá.
 *
 * O caminho inteiro é:
 *
 *   DOM vivo → seek → serializa → [ESTE ARQUIVO] → <img> → drawImage → canvas
 *
 * Ver LIMITES.md pro que o navegador aceita aqui dentro. Os três fatos que
 * explicam quase todas as decisões deste arquivo:
 *
 *   1. JS não roda no snapshot — é imagem estática.
 *   2. Nada externo carrega — fonte e imagem têm que ir embutidas.
 *   3. O `<style>` é lido como XML, então `<` e `&` precisam de CDATA.
 */

/** Prefixo das variáveis que o editor injeta. As do autor são `--p-*`. */
export const PREFIXO_SINAL = '--frag-';

export interface OpcoesSvg {
  largura: number;
  altura: number;
  /** O CSS do autor, como ele escreveu. */
  css: string;
  /** O corpo já serializado a partir do DOM vivo (com o seek aplicado). */
  corpo: string;
  /** Variáveis a injetar: `--p-*` dos params e `--frag-*` dos sinais. */
  vars?: Record<string, string>;
  /** `@font-face` já montados, com a fonte em `data:`. Ver `faceDeFonte`. */
  fontes?: string[];
}

/**
 * Fecha o CSS num CDATA seguro.
 *
 * Sem isto, `syntax: '<integer>'` no CSS do autor abre uma tag XML e o quadro
 * inteiro vira erro de parse — não sai torto, some. Foi medido.
 *
 * O `]]>` no meio do CSS é o caso patológico: ele fecharia o CDATA cedo. A
 * troca por `]]]]><![CDATA[>` fecha e reabre a seção em volta do `>`, que é o
 * jeito canônico de escapar isso sem tocar no conteúdo.
 */
export function emCdata(texto: string): string {
  return `<![CDATA[${texto.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

/** Escapa o que vai dentro de um ATRIBUTO XML (o `style` do embrulho). */
export function emAtributo(texto: string): string {
  return texto
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** `@font-face` com o arquivo embutido. Ver o fato 2 no topo. */
export function faceDeFonte(familia: string, dataUri: string): string {
  return `@font-face{font-family:'${familia}';src:url(${dataUri});font-display:block;}`;
}

/**
 * Declaração das variáveis, pra entrar no `style` do embrulho.
 *
 * Vão como atributo `style` e não numa regra `:root` porque o embrulho é o
 * escopo natural: o CSS do autor herda tudo dele, e nada vaza pra fora do
 * snapshot. Ordem alfabética pra que o mesmo estado produza sempre a mesma
 * string — o que importa pro cache e pra comparar dois quadros em teste.
 */
export function declaracaoDeVars(vars: Record<string, string> = {}): string {
  return Object.keys(vars).sort().map(k => `${k}:${vars[k]}`).join(';');
}

/**
 * O SVG completo, pronto pra virar `src` de uma `<img>`.
 *
 * O `xmlns` aparece DUAS vezes de propósito: no `<svg>` e no `<div>` de
 * dentro. O de dentro é o do XHTML, e sem ele o conteúdo do `foreignObject`
 * não é reconhecido como HTML — o quadro sai em branco, sem erro nenhum.
 */
export function montarSvg({ largura, altura, css, corpo, vars, fontes = [] }: OpcoesSvg): string {
  const estilo = [
    ...fontes,
    // O embrulho carrega o tamanho do projeto: é contra ele que `vw`, `vh` e
    // `%` resolvem, e é isso que faz o mesmo efeito servir 1920×1080 e
    // 1080×1920 sem o autor fazer nada. Medido — ver LIMITES.md §3.
    `.frag-cena{position:relative;width:${largura}px;height:${altura}px;overflow:hidden}`,
    css,
  ].join('\n');

  const declaracao = declaracaoDeVars(vars);
  const style = `width:${largura}px;height:${altura}px${declaracao ? ';' + declaracao : ''}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}">`
    + `<foreignObject x="0" y="0" width="${largura}" height="${altura}">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" class="frag-cena" style="${emAtributo(style)}">`
    + `<style>${emCdata(estilo)}</style>`
    + corpo
    + `</div></foreignObject></svg>`;
}

/** O SVG como `src` de `<img>`. Data URI, não blob: ver a nota em `overlay.ts`. */
export function comoDataUri(svg: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// --- checagens de carga -------------------------------------------------
// Puras porque a fase F (o validador) vai reusá-las, e porque errar aqui só
// aparece muito depois — um efeito que some no export, não na hora de salvar.

/** Hosts externos citados no CSS. Nada disso carrega. Ver LIMITES.md §2.2. */
export function recursosExternos(css: string): string[] {
  const achados = new Set<string>();
  for (const [, url] of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
    if (url && /^(https?:)?\/\//i.test(url)) achados.add(url);
  }
  for (const [, url] of css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/gi)) {
    if (url) achados.add(url);
  }
  return [...achados];
}

/**
 * `<style>` dentro do HTML do autor.
 *
 * Não passa pelo CDATA (só o CSS do pacote passa), então um `<` ali dentro
 * quebra a serialização do quadro inteiro. Vale um aviso, não uma recusa: o
 * caso comum é CSS bem-comportado, e recusar seria hostil.
 */
export function temStyleInline(html: string): boolean {
  return /<style[\s>]/i.test(html);
}

/** Fontes citadas no CSS que o pacote não traz — vão cair no fallback do sistema. */
export function fontesFaltando(css: string, disponiveis: string[]): string[] {
  const conhecidas = new Set(disponiveis.map(f => f.toLowerCase()));
  // As genéricas do CSS não são "faltando": são o fallback, e é legítimo.
  const genericas = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-monospace', 'ui-sans-serif', 'ui-serif', 'inherit', 'initial', 'unset',
    'math', 'emoji', 'fangsong',
  ]);
  const faltando = new Set<string>();

  for (const [, lista] of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    for (const bruto of (lista ?? '').split(',')) {
      const nome = bruto.trim().replace(/^['"]|['"]$/g, '');
      if (!nome) continue;
      const chave = nome.toLowerCase();
      if (genericas.has(chave) || conhecidas.has(chave)) continue;
      faltando.add(nome);
    }
  }
  return [...faltando];
}
