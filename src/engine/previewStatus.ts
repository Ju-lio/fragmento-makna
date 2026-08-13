/**
 * "O preview está trabalhando" — o sinal por trás da barrinha de atividade.
 *
 * O detalhe que faz ou quebra esse tipo de indicador: ele NÃO pode aparecer
 * em toda operação. Um seek que resolve em 30ms piscando uma barra na tela
 * é pior que barra nenhuma — vira ruído visual e passa a sensação de instabilidade.
 * Por isso existe o `delayMs`: o preview precisa ficar ocupado de forma
 * contínua por um tempo mínimo antes da barra surgir. Operação rápida nunca
 * chega a mostrar nada; operação lenta mostra e explica a espera.
 *
 * Fica fora do React, como player/viewport: `report()` roda a cada frame, mas
 * só notifica quem escuta quando a visibilidade realmente muda de estado —
 * então a barra custa no máximo 2 re-renders por episódio, não 60 por segundo.
 */
const DEFAULT_DELAY_MS = 140;

export type PreviewStatusListener = (status: PreviewStatus) => void;

class PreviewStatus {
  readonly delayMs: number;
  visible = false;
  reason: string | null = null;

  /** Quando a ocupação atual começou. null = não está ocupado. */
  private _busySince: number | null = null;
  private _subs = new Set<PreviewStatusListener>();

  constructor(delayMs: number = DEFAULT_DELAY_MS) {
    this.delayMs = delayMs;
  }

  subscribe(cb: PreviewStatusListener): () => void {
    this._subs.add(cb);
    return () => { this._subs.delete(cb); };
  }

  /**
   * Chamado a cada frame com o estado atual.
   * `reason` é só um rótulo pra UI ('decodificando', 'carregando'...).
   */
  report(busy: boolean, reason: string | null = null, now: number = performance.now()): void {
    if (!busy) {
      this._busySince = null;
      this._set(false, null);
      return;
    }

    if (this._busySince === null) this._busySince = now;
    // Só fica visível depois de estar ocupado tempo suficiente pra valer a pena avisar.
    if (now - this._busySince >= this.delayMs) this._set(true, reason);
  }

  private _set(visible: boolean, reason: string | null): void {
    if (visible === this.visible && reason === this.reason) return;
    this.visible = visible;
    this.reason = reason;
    for (const cb of this._subs) cb(this);
  }
}

export const previewStatus = new PreviewStatus();
export { PreviewStatus };
