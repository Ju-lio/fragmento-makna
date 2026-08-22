/**
 * O runtime do overlay: HTML+CSS do autor → bitmap de um instante.
 *
 * A metade que precisa de navegador. A montagem do SVG, que é string entra
 * string sai, mora em `svg.ts` e é testada em node.
 *
 * ## O seek
 *
 * O centro de tudo. Uma animação CSS não tem API de "vá para o segundo 12,4" —
 * mas `animation-play-state: paused` com `animation-delay` NEGATIVO pinta
 * exatamente aquele instante, estático. Medido: exato em 26 de 26 instantes,
 * inclusive depois do primeiro ciclo de um loop (ver LIMITES.md §1).
 *
 * É isso que permite o autor escrever `@keyframes` comum, do jeito que já
 * sabe, e o editor ainda assim pedir um quadro qualquer, fora de ordem, como
 * o export faz.
 *
 * O atraso do próprio autor é PRESERVADO: lido uma vez na montagem e reescrito
 * como `original - t`. A versão ingênua (um `!important` em tudo) apagava os
 * atrasos escalonados e fazia todo stagger animar em bloco.
 *
 * ## Por que iframe
 *
 * O palco vivo precisa existir pra ter layout e estado calculados — é de lá
 * que sai a serialização. Se ele fosse um `<div>` na página do editor, um
 * `body{background:#000}` no CSS do autor pintaria o editor inteiro. O iframe
 * isola de graça, e é a base do sandbox que a importação de terceiros vai
 * exigir.
 */

import { montarSvg, comoDataUri, faceDeFonte } from './svg.ts';
import { PREFIXO_SINAL } from './svg.ts';
import type { Meta } from './api.ts';

export interface Pacote {
  meta: Meta;
  html: string;
  css: string;
  /** Família → data URI. Nada externo carrega; ver LIMITES.md §2.2. */
  fontes?: Record<string, string>;
}

export interface PedidoDeQuadro {
  largura: number;
  altura: number;
  /** Tempo dentro da janela do efeito, em segundos. */
  t: number;
  /** Duração da janela, pra `--frag-progresso`. */
  duracao?: number;
  /** As variáveis dos params (`--p-*`), de `variaveisCss`. */
  params?: Record<string, string>;
}

/** Marca no elemento onde o atraso original ficou guardado. */
const ATRASO = 'data-frag-atraso';

export class Overlay {
  private quadroEl: HTMLIFrameElement | null = null;
  private prontoPromise: Promise<void> | null = null;

  // Campo declarado, não *parameter property*: `erasableSyntaxOnly` está
  // ligado no tsconfig, e parameter property não é apagável — quebraria só na
  // hora de rodar os testes. Ver a nota no topo do README.
  private pacote: Pacote;

  constructor(pacote: Pacote) {
    this.pacote = pacote;
  }

  /** Monta o palco. Idempotente — chamar de novo devolve a mesma promessa. */
  pronto(): Promise<void> {
    if (this.prontoPromise) return this.prontoPromise;

    this.prontoPromise = new Promise<void>((resolve, reject) => {
      const frame = document.createElement('iframe');
      // Fora da tela, e não `display:none`: elemento sem caixa não tem layout,
      // e sem layout não há `getComputedStyle` que preste.
      frame.style.cssText = 'position:fixed;left:-99999px;top:0;border:0;visibility:hidden';
      frame.setAttribute('aria-hidden', 'true');
      // Sem `allow-scripts`: nesta fase o pacote é HTML+CSS, e JS não roda
      // dentro do snapshot de qualquer jeito (ver LIMITES.md §1, fato 1).
      frame.setAttribute('sandbox', 'allow-same-origin');
      this.quadroEl = frame;

      frame.onload = () => {
        try {
          this.escreverDocumento();
          const doc = frame.contentDocument!;
          // A fonte precisa estar carregada ANTES de medir: sem isso o layout
          // sai com a métrica do fallback e o quadro não bate com o export.
          const espera = doc.fonts?.ready ?? Promise.resolve();
          espera.then(() => { this.guardarAtrasos(); resolve(); }, reject);
        } catch (e) { reject(e); }
      };
      frame.onerror = () => reject(new Error('o palco do overlay não carregou'));
      document.body.appendChild(frame);
      frame.src = 'about:blank';
    });

    return this.prontoPromise;
  }

  private escreverDocumento() {
    const doc = this.quadroEl!.contentDocument!;
    const faces = Object.entries(this.pacote.fontes ?? {})
      .map(([familia, uri]) => faceDeFonte(familia, uri))
      .join('\n');

    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"><style>`
      + `html,body{margin:0;padding:0}`
      + faces
      + this.pacote.css
      + `</style></head><body>${this.pacote.html}</body></html>`,
    );
    doc.close();
  }

  /**
   * Lê o `animation-delay` de cada nó UMA vez e guarda.
   *
   * Reler depois de já ter escrito faria o valor escorregar a cada quadro —
   * foi o que quebrou o determinismo na primeira versão: o "original" da
   * segunda chamada já era o valor modificado pela primeira.
   */
  private guardarAtrasos() {
    const doc = this.quadroEl!.contentDocument!;
    const janela = this.quadroEl!.contentWindow!;
    for (const el of doc.body.querySelectorAll<HTMLElement>('*')) {
      const cs = janela.getComputedStyle(el);
      if (cs.animationName === 'none') continue;
      el.setAttribute(ATRASO, String(parseFloat(cs.animationDelay) || 0));
    }
  }

  /**
   * Leva o palco ao instante `t`.
   *
   * Escreve tudo antes de ler qualquer coisa: intercalar escrita e leitura de
   * estilo força um recálculo de layout POR NÓ em vez de um por quadro. Numa
   * cena de 300 partículas isso foi a diferença entre 62ms e alguns.
   */
  private levarAoInstante(t: number) {
    const doc = this.quadroEl!.contentDocument!;
    for (const el of doc.body.querySelectorAll<HTMLElement>(`[${ATRASO}]`)) {
      const original = Number(el.getAttribute(ATRASO)) || 0;
      el.style.animationDelay = `${original - t}s`;
      el.style.animationPlayState = 'paused';
    }
  }

  /** Os sinais que o editor injeta. Os params do autor vêm com `--p-`. */
  private sinais({ t, duracao, largura, altura }: PedidoDeQuadro): Record<string, string> {
    const p = duracao && duracao > 0 ? Math.min(1, Math.max(0, t / duracao)) : 0;
    return {
      [`${PREFIXO_SINAL}t`]: `${t}s`,
      [`${PREFIXO_SINAL}progresso`]: String(Number(p.toFixed(6))),
      [`${PREFIXO_SINAL}largura`]: `${largura}px`,
      [`${PREFIXO_SINAL}altura`]: `${altura}px`,
      [`${PREFIXO_SINAL}duracao`]: `${duracao ?? 0}s`,
    };
  }

  /** O SVG de um instante — o que `quadro` desenha, exposto pra teste. */
  async svgDe(pedido: PedidoDeQuadro): Promise<string> {
    await this.pronto();
    const doc = this.quadroEl!.contentDocument!;
    doc.body.style.width = `${pedido.largura}px`;
    doc.body.style.height = `${pedido.altura}px`;

    this.levarAoInstante(pedido.t);

    const corpo = [...doc.body.children]
      .map(el => new XMLSerializer().serializeToString(el))
      .join('');

    const faces = Object.entries(this.pacote.fontes ?? {})
      .map(([familia, uri]) => faceDeFonte(familia, uri));

    return montarSvg({
      largura: pedido.largura,
      altura: pedido.altura,
      css: this.pacote.css,
      corpo,
      vars: { ...this.sinais(pedido), ...(pedido.params ?? {}) },
      fontes: faces,
    });
  }

  /**
   * Um quadro do overlay, como imagem pronta pra `drawImage`.
   *
   * Data URI e não blob URL: o SVG é carregado em modo estático, e nesse modo
   * um `blob:` continua sendo recurso externo — não carrega. Medido também que
   * `createImageBitmap` de um SVG falha no Firefox, então o caminho é
   * `<img>` + `decode()`, que funciona nos dois.
   */
  async quadro(pedido: PedidoDeQuadro): Promise<HTMLImageElement> {
    const svg = await this.svgDe(pedido);
    const img = new Image();
    img.src = comoDataUri(svg);
    await img.decode();
    return img;
  }

  destruir() {
    this.quadroEl?.remove();
    this.quadroEl = null;
    this.prontoPromise = null;
  }
}
