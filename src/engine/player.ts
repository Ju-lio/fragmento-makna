/**
 * Playback clock — deliberately OUTSIDE React.
 *
 * Performance contract:
 *  1. One single rAF loop for the whole app, never one per component.
 *  2. The playhead is NOT React state. Per-frame consumers (canvas, playhead
 *     bar, timecode) subscribe here and write straight to the DOM/canvas, so
 *     scrubbing and playback cause zero React re-renders.
 *  3. When paused and nothing changed, we skip the frame entirely — an idle
 *     editor burns no CPU instead of redrawing 60x a second forever.
 */
export type FrameListener = (t: number) => void;
export type StateListener = (player: Player) => void;

export interface Range { from: number; to: number }

class Player {
  t = 0;
  duration = 8;
  playing = false;
  loopPlayback = true;

  /** Trecho marcado (in/out). null = projeto inteiro. Alimenta o pré-render
   *  e, mais pra frente, o export de um pedaço só. */
  rangeIn: number | null = null;
  rangeOut: number | null = null;

  /**
   * A reprodução atual está saindo inteira do cache?
   *
   * Decidido uma vez ao dar play, não a cada quadro, porque o que estraga a
   * imagem é justamente **misturar** as duas origens: um quadro do cache
   * mostra o vídeo no instante exato da grade, enquanto um quadro ao vivo
   * mostra onde o `<video>` estiver naquele momento. Alternar entre os dois
   * faz o vídeo pular pra frente e voltar.
   */
  fromCache = false;

  private _frameSubs = new Set<FrameListener>();  // per-frame, hot path
  private _stateSubs = new Set<StateListener>();  // coarse (play/pause), safe for React
  private _tickSubs = new Set<FrameListener>();   // every rAF, repaint or not — keep these cheap
  private _dirty = true;
  /** Instante do último tick. null = o próximo tick define a origem (ver `play`). */
  private _last: number | null = null;
  private _raf: number | null = null;

  /** Per-frame subscription. Returns an unsubscribe fn. */
  onFrame(cb: FrameListener): () => void {
    this._frameSubs.add(cb);
    this._dirty = true;
    return () => { this._frameSubs.delete(cb); };
  }

  /**
   * Roda a cada rAF, inclusive quando o frame é pulado por não ter mudado nada.
   *
   * Existe para observação barata — tipo "esse vídeo ainda está buscando o
   * frame?" — que precisa continuar sendo checada justamente enquanto a tela
   * está parada esperando. Não desenhe nada aqui: use `onFrame` pra isso, ou
   * a otimização de frame sujo (que é o que segura a CPU em zero quando o
   * editor está ocioso) perde completamente o sentido.
   */
  onTick(cb: FrameListener): () => void {
    this._tickSubs.add(cb);
    return () => { this._tickSubs.delete(cb); };
  }

  /** Coarse state subscription (play/pause/duration) — safe to drive React. */
  onState(cb: StateListener): () => void {
    this._stateSubs.add(cb);
    return () => { this._stateSubs.delete(cb); };
  }

  /** Force a repaint on the next frame (call after editing the project). */
  invalidate(): void { this._dirty = true; }

  /** Trecho efetivo: o marcado, ou o projeto inteiro quando não há marcação. */
  effectiveRange(): Range {
    const from = this.rangeIn ?? 0;
    const to = this.rangeOut ?? this.duration;
    return from <= to ? { from, to } : { from: to, to: from };
  }

  get hasRange(): boolean { return this.rangeIn !== null || this.rangeOut !== null; }

  markIn(t: number = this.t): void {
    this.rangeIn = Math.max(0, Math.min(t, this.duration));
    // Marcar o início depois do fim inverteria o trecho; empurra o fim junto.
    if (this.rangeOut !== null && this.rangeOut < this.rangeIn) this.rangeOut = null;
    this._emitState();
  }

  markOut(t: number = this.t): void {
    this.rangeOut = Math.max(0, Math.min(t, this.duration));
    if (this.rangeIn !== null && this.rangeIn > this.rangeOut) this.rangeIn = null;
    this._emitState();
  }

  clearRange(): void {
    this.rangeIn = null;
    this.rangeOut = null;
    this._emitState();
  }

  seek(t: number): void {
    this.t = Math.max(0, Math.min(this.duration, t));
    this._dirty = true;
  }

  setDuration(d: number): void {
    const next = Math.max(0.5, d);
    // Sai cedo quando nada mudou: a duração passou a ser DERIVADA do conteúdo,
    // então isto é chamado a cada edição de layer — inclusive as que não mexem
    // no comprimento, que são a maioria.
    if (next === this.duration) return;
    this.duration = next;
    if (this.t > this.duration) this.t = this.duration;
    this._dirty = true;
    this._emitState();
  }

  play(): void {
    if (this.playing) return;
    if (this.t >= this.duration) this.t = 0;
    this.playing = true;
    /**
     * A origem sai do PRIMEIRO tick, não de `performance.now()` daqui.
     *
     * O rAF entrega o instante em que o quadro começou a ser processado — e
     * eventos de input são despachados dentro desse mesmo quadro. Dar play num
     * clique podia então produzir um `now` ANTERIOR a este ponto, ou seja, um
     * `dt` negativo: o relógio andava pra trás logo no primeiro quadro.
     */
    this._last = null;
    this._emitState();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.fromCache = false;
    this._dirty = true;
    this._emitState();
  }

  toggle(): void { this.playing ? this.pause() : this.play(); }

  private _emitState(): void { for (const cb of this._stateSubs) cb(this); }

  start(): void {
    if (this._raf !== null) return;
    const tick = (now: number) => {
      this._raf = requestAnimationFrame(tick);

      if (this.playing) {
        if (this._last === null) this._last = now;
        // Clamp nos dois lados: pra cima contra o salto de trocar de aba, pra
        // baixo porque o relógio nunca pode recuar (ver `play`).
        const dt = Math.min(Math.max((now - this._last) / 1000, 0), 0.25);
        this._last = now;
        this.t += dt;
        if (this.t >= this.duration) {
          if (this.loopPlayback) this.t = 0;
          else { this.t = this.duration; this.pause(); }
        }
        this._dirty = true;
      }

      // Observadores baratos rodam sempre — inclusive no frame pulado, que é
      // exatamente quando estamos parados esperando algo terminar.
      for (const cb of this._tickSubs) cb(this.t);

      if (!this._dirty) return;   // idle: nothing to paint, spend nothing
      this._dirty = false;
      for (const cb of this._frameSubs) cb(this.t);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this._raf !== null) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
}

export const player = new Player();
export type { Player };
