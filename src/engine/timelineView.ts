/**
 * Zoom e rolagem da timeline.
 *
 * O problema que resolve: a régua espremia o projeto inteiro na largura da
 * janela, sempre. Num projeto de 60s um clipe de 2s virava 3% da tela — largo
 * demais pra mirar a alça de trim, estreito demais pra ler o nome. Era a
 * parede mais próxima entre o editor e "montar um Reels de 60s".
 *
 * Fica fora do React como o `viewport.ts`, e pela mesma razão: rolar dispara
 * eventos na taxa da tela e cada um só precisa mexer numa posição de scroll.
 *
 * **O modelo de coordenadas é o detalhe que faz o resto ficar barato.** Em vez
 * de reposicionar cada clipe em pixels quando o zoom muda, a timeline ganha um
 * elemento de conteúdo de `duration × pxPerSecond` pixels, e clipes, marcas e
 * cursor continuam posicionados em **porcentagem** dele — exatamente como
 * antes. Dar zoom passa a ser mudar uma largura, e a porcentagem de cada clipe
 * nunca muda. É o mesmo truque do palco, onde o zoom é uma `transform` só.
 *
 * A rolagem é a nativa do navegador (`overflow-x`), não uma reimplementação:
 * ela já traz barra, roda do mouse, trackpad horizontal e teclado de graça, e
 * `scrollLeft` é uma escrita direta no DOM — zero re-render.
 */

/** Piso do zoom. Abaixo disso a régua não é mais legível em lugar nenhum. */
const MIN_PX_PER_SECOND = 2;

/**
 * Teto do zoom. A 600 px/s um quadro a 30fps ocupa 20px — dá pra mirar um
 * quadro específico, que é o mais fino que faz sentido pedir de uma timeline.
 */
const MAX_PX_PER_SECOND = 600;

/** Passo do zoom por clique/tecla. 1,6 dá ~7 passos entre o fit e o teto. */
const ZOOM_STEP = 1.6;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Zoom em que o projeto inteiro cabe na janela — o piso útil.
 *
 * Sem teto de propósito, ao contrário do zoom manual: num projeto de 1s numa
 * janela larga o fit pede 3000 px/s, e é isso mesmo que se quer. Prender o fit
 * ao teto deixaria o conteúdo mais **estreito** que a janela, e como tudo aqui
 * dentro é posicionado em porcentagem do conteúdo, os clipes se amontoariam à
 * esquerda com faixa vazia à direita.
 */
export function fitPxPerSecond(width: number, duration: number): number {
  if (width <= 0 || duration <= 0) return MIN_PX_PER_SECOND;
  return Math.max(width / duration, MIN_PX_PER_SECOND);
}

/**
 * Prende o zoom entre "cabe tudo" e o teto.
 *
 * O piso é o fit, não uma constante: abaixo dele sobraria faixa vazia à direita
 * e a rolagem deixaria de ter pra onde ir — o projeto encolhendo no canto de
 * uma janela larga, que não é uma vista que alguém queira.
 */
export function clampPxPerSecond(pps: number, width: number, duration: number): number {
  const floor = fitPxPerSecond(width, duration);
  // `floor` pode passar do teto num projeto curto numa janela larga; aí ele
  // vence, porque mostrar o projeto inteiro importa mais que respeitar o teto.
  return Math.max(floor, Math.min(pps, Math.max(floor, MAX_PX_PER_SECOND)));
}

/**
 * Rolagem que mantém fixo o instante que está sob `anchorX`.
 *
 * É o que faz `Ctrl` + roda dar zoom "no cursor" em vez de no começo do
 * projeto. Sem isso, ampliar pra examinar um corte joga o corte pra fora da
 * tela e obriga a procurá-lo de novo a cada passo de zoom.
 */
export function zoomAnchor(
  scroll: number, anchorX: number, from: number, to: number,
): number {
  if (from <= 0) return scroll;
  const t = (scroll + anchorX) / from;   // instante sob o cursor, preservado
  return Math.max(0, t * to - anchorX);
}

/** Prende a rolagem ao que existe de conteúdo. */
export function clampScroll(scroll: number, contentWidth: number, width: number): number {
  return clamp(scroll, 0, Math.max(0, contentWidth - width));
}

/**
 * Marcas da régua: o menor passo "redondo" que ainda deixa os rótulos
 * respirarem.
 *
 * Uma escada fixa em vez de uma divisão: passos de 0,3s ou 7s são tão legíveis
 * quanto um relógio quebrado. Estes são os que a pessoa consegue somar de
 * cabeça enquanto olha.
 */
const TICK_LADDER = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

/** Espaço mínimo entre marcas. Cabe o rótulo mais largo da escada sem colidir. */
const MIN_TICK_PX = 52;

export function tickStep(pxPerSecond: number): number {
  return TICK_LADDER.find(s => s * pxPerSecond >= MIN_TICK_PX)
    ?? (TICK_LADDER[TICK_LADDER.length - 1] as number);
}

/**
 * Pra onde rolar pra não perder o cursor de vista durante a reprodução.
 * `null` = já está visível, não mexe em nada.
 *
 * Reposiciona por **página**, não continuamente: seguir o cursor pixel a pixel
 * deixa a timeline inteira deslizando o tempo todo debaixo do olho, e aí não dá
 * pra ler nem mirar nada enquanto toca. Assim ele atravessa a janela, e quando
 * sai reaparece na outra ponta com uma página inteira pela frente.
 */
export function followPlayhead(x: number, scroll: number, width: number): number | null {
  if (width <= 0) return null;

  const margin = Math.min(width * 0.1, 80);
  const visible = x >= scroll + margin && x <= scroll + width - margin;
  if (visible) return null;

  // Andando pra frente, o cursor reaparece perto da borda esquerda — o que
  // ainda não passou é o que interessa ver. Voltando (loop, scrub), o espelho.
  return x < scroll + margin ? x - width + margin : x - margin;
}

export type TimelineViewListener = (view: TimelineView) => void;

class TimelineView {
  pxPerSecond = 40;
  /** Largura visível da janela, em px. */
  width = 0;
  duration = 8;

  /** Enquanto ligado, o zoom acompanha o tamanho da janela em vez de você. */
  fitMode = true;

  private _subs = new Set<TimelineViewListener>();

  subscribe(cb: TimelineViewListener): () => void {
    this._subs.add(cb);
    return () => { this._subs.delete(cb); };
  }

  private _emit(): void { for (const cb of this._subs) cb(this); }

  /**
   * Largura do elemento de conteúdo, que é o que o zoom de fato muda.
   *
   * Exatamente `duration × pxPerSecond`, sem piso na largura da janela: é essa
   * igualdade que faz `left: 40%` significar "40% da duração" em qualquer
   * zoom. Como o zoom nunca desce abaixo do fit, o resultado já é sempre pelo
   * menos a largura da janela.
   */
  get contentWidth(): number {
    return this.duration * this.pxPerSecond;
  }

  /** Existe mais projeto do que cabe na janela? Decide se a rolagem serve. */
  get scrollable(): boolean {
    return this.duration * this.pxPerSecond > this.width + 1;
  }

  fitPxPerSecond(): number { return fitPxPerSecond(this.width, this.duration); }

  setViewport(width: number, duration: number): void {
    if (width === this.width && duration === this.duration) return;
    this.width = width;
    this.duration = duration;
    // Fora do fit, o zoom escolhido é preservado — só volta pro válido se a
    // janela encolheu tanto que ele passou a ser menor que "cabe tudo".
    this.pxPerSecond = this.fitMode
      ? this.fitPxPerSecond()
      : clampPxPerSecond(this.pxPerSecond, width, duration);
    this._emit();
  }

  setPxPerSecond(pps: number): void {
    const next = clampPxPerSecond(pps, this.width, this.duration);
    this.fitMode = false;
    if (next === this.pxPerSecond) return;
    this.pxPerSecond = next;
    this._emit();
  }

  fit(): void {
    this.fitMode = true;
    const next = this.fitPxPerSecond();
    if (next === this.pxPerSecond) return;
    this.pxPerSecond = next;
    this._emit();
  }

  zoomIn(): void { this.setPxPerSecond(this.pxPerSecond * ZOOM_STEP); }
  zoomOut(): void { this.setPxPerSecond(this.pxPerSecond / ZOOM_STEP); }

  /** Px de conteúdo -> instante. */
  timeAt(x: number): number { return this.pxPerSecond > 0 ? x / this.pxPerSecond : 0; }

  /** Instante -> px de conteúdo. */
  xOf(t: number): number { return t * this.pxPerSecond; }
}

export const timelineView = new TimelineView();
export type { TimelineView };
