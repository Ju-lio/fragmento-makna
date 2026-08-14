/**
 * O interruptor "auto pré-render" — fora do React, como player/viewport/timeline.
 *
 * Ele governa UMA coisa só: o que o botão de play faz quando o trecho ainda não
 * está no cache.
 *
 *  - Desligado (o padrão): toca na hora, ao vivo. Você vê o resultado
 *    imediatamente, e o cache vai se enchendo sozinho com o que passar na tela.
 *  - Ligado: prepara o trecho inteiro antes de soltar o play. Demora, e em
 *    troca a reprodução sai da mesma composição quadro a quadro que o export.
 *
 * O padrão inverteu de propósito. Esperar um pré-render a cada play era o preço
 * cobrado de toda edição, inclusive das dezenas em que você só quer conferir se
 * o clipe entra na hora certa — e é caro demais pra ser o padrão.
 *
 * O que este interruptor NÃO faz mais é mexer na qualidade do desenho. Isso
 * agora sai só de `player.playing`: durante a reprodução o desfoque é pulado
 * pra segurar a fluidez, e volta no instante em que você pausa. Eram duas
 * coisas amarradas num botão só, e com o padrão invertido a amarração passaria
 * a mostrar quadro aproximado justamente na hora de inspecionar um quadro
 * parado.
 */
export type AutoPrerenderListener = (on: boolean) => void;

class AutoPrerender {
  on = false;
  private _subs = new Set<AutoPrerenderListener>();

  subscribe(cb: AutoPrerenderListener): () => void {
    this._subs.add(cb);
    return () => { this._subs.delete(cb); };
  }

  toggle(): void { this.set(!this.on); }

  set(v: boolean): void {
    if (v === this.on) return;
    this.on = v;
    for (const cb of this._subs) cb(this.on);
  }
}

export const autoPrerender = new AutoPrerender();
