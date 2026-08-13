/**
 * Progresso de um trabalho longo — pré-render, export.
 *
 * Fica fora do React como o resto da engine, e por um motivo além da coerência:
 * quem dispara o trabalho (um botão) quase nunca é quem mostra o andamento
 * (uma barra em outro canto). Um observável compartilhado evita passar
 * callbacks de progresso por três camadas de props.
 */

export type ProgressListener = (progress: Progress) => void;

export class Progress {
  running = false;
  done = 0;
  total = 0;

  private _subs = new Set<ProgressListener>();

  subscribe(cb: ProgressListener): () => void {
    this._subs.add(cb);
    return () => { this._subs.delete(cb); };
  }

  private _emit(): void { for (const cb of this._subs) cb(this); }

  /** Fração concluída, 0..1. Zero quando não há total — evita dividir por zero. */
  get fraction(): number {
    return this.total > 0 ? Math.min(1, this.done / this.total) : 0;
  }

  begin(total: number): void {
    this.running = true;
    this.done = 0;
    this.total = total;
    this._emit();
  }

  advance(done: number): void {
    this.done = done;
    this._emit();
  }

  end(): void {
    this.running = false;
    this._emit();
  }
}
