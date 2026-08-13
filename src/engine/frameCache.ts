import type { Project } from './types.ts';

/**
 * Cache de frames já compostos — o "RAM preview".
 *
 * A parte difícil de um cache de vídeo não é guardar, é saber **quando jogar
 * fora**. Um cache que devolve frame velho depois de você editar uma layer é
 * muito pior que não ter cache nenhum: você passa a não confiar no que vê.
 * Por isso tudo aqui gira em torno da assinatura (`renderSignature`), que
 * captura exatamente o que altera pixels — e nada além disso.
 *
 * O que NÃO entra na assinatura, de propósito:
 *  - a posição do playhead (é justamente o que queremos poder variar de graça)
 *  - pan e zoom (mudam onde a imagem aparece, não o que ela é)
 *  - seleção de layer, aba aberta, qualquer estado de UI
 *  - a escala de render (frames guardados são reescalados na hora de exibir,
 *    então dar zoom não joga o pré-render fora — só deixa ele mais macio)
 */

/** Frames guardados por segundo. 30 basta pra avaliar timing e corta memória pela metade vs 60. */
export const CACHE_FPS = 30;

/** Teto de memória. ImageBitmap costuma viver na GPU, mas o custo é real de qualquer jeito. */
const DEFAULT_BUDGET_BYTES = 320 * 1024 * 1024;

export const frameIndexAt = (t: number, fps: number = CACHE_FPS): number => Math.round(t * fps);
export const timeAtFrameIndex = (i: number, fps: number = CACHE_FPS): number => i / fps;

export interface RangeEstimate {
  frames: number;
  bytes: number;
  fits: boolean;
  /** Quantos segundos caberiam de fato, pra sugerir um trecho viável. */
  maxSeconds: number;
}

export interface EstimateInput {
  width: number;
  height: number;
  scale: number;
  seconds: number;
  fps?: number;
  budget?: number;
}

/**
 * Quanta memória um trecho vai custar, e se ele cabe.
 *
 * Existe pra poder avisar ANTES: sem isso, pré-renderizar um trecho grande
 * demais "termina com sucesso" e mesmo assim engasga na reprodução, porque o
 * começo foi descartado pra dar lugar ao fim. Um cache que silenciosamente
 * não cumpre o que prometeu é pior que um aviso honesto.
 */
export function estimateRange(
  { width, height, scale, seconds, fps = CACHE_FPS, budget }: EstimateInput,
): RangeEstimate {
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const bytesPerFrame = w * h * 4;
  const frames = Math.max(0, Math.round(seconds * fps) + 1);
  const bytes = frames * bytesPerFrame;
  const cap = budget ?? DEFAULT_BUDGET_BYTES;

  return {
    frames,
    bytes,
    fits: bytes <= cap,
    /**
     * Quantos segundos caberiam de fato, pra sugerir um trecho viável.
     * O -1 não é folga arbitrária: um trecho inclui as duas pontas, então
     * N segundos custam N*fps+1 quadros. Sem isso a sugestão estouraria
     * justamente por um quadro.
     */
    maxSeconds: bytesPerFrame > 0
      ? Math.max(0, Math.floor(cap / bytesPerFrame) - 1) / fps
      : Infinity,
  };
}

export const formatBytes = (b: number): string =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;

/**
 * Reduz o projeto ao que de fato desenha pixels.
 *
 * Vai por layer explicitamente, campo a campo, em vez de serializar o objeto
 * inteiro: assim, adicionar um campo de UI ao modelo (tipo "selecionado" ou
 * "recolhido") não passa a invalidar o cache sem motivo. O preço é ter que
 * lembrar de incluir aqui todo campo novo que afete a imagem.
 */
export function renderSignature(project: Project): string {
  const layers = project.layers.map(l => {
    // Campo a campo e por tipo: assim o compilador cobra o que só existe em
    // algumas layers, e um campo novo no modelo não entra aqui por acidente.
    const common = [l.type, l.start, l.duration, l.x, l.y, l.effects];
    if (l.type === 'text') return [...common, l.text, l.size, l.color, l.font];
    if (l.type === 'image') return [...common, l.fit, l.img.src];
    return [...common, l.fit, l.trimStart, l.video.src];
  });

  return JSON.stringify([project.width, project.height, project.background, layers]);
}

/** A assinatura só muda quando o objeto do projeto muda, então memoriza por referência. */
const signatures = new WeakMap<Project, string>();

export function signatureOf(project: Project): string {
  let sig = signatures.get(project);
  if (sig === undefined) {
    sig = renderSignature(project);
    signatures.set(project, sig);
  }
  return sig;
}

interface CachedFrame {
  bitmap: ImageBitmap;
  bytes: number;
  /** Capturado com o desfoque pulado — bom pra reproduzir, não pra inspecionar. */
  degraded: boolean;
}

export interface ReadOptions {
  allowDegraded?: boolean;
}

export class FrameCache {
  readonly budgetBytes: number;
  bytes = 0;
  signature: string | null = null;
  /** Escala em que os frames foram gerados; exibir usa isso pra reescalar. */
  scale = 1;
  private _frames = new Map<number, CachedFrame>();

  constructor(budgetBytes: number = DEFAULT_BUDGET_BYTES) {
    this.budgetBytes = budgetBytes;
  }

  get size(): number { return this._frames.size; }

  /**
   * Prepara o cache pra uma assinatura. Se mudou, o conteúdo antigo é
   * descartado — todo frame ali foi gerado com um projeto que não existe mais.
   */
  useSignature(sig: string, scale: number = this.scale): void {
    if (sig !== this.signature) {
      this.clear();
      this.signature = sig;
    }
    this.scale = scale;
  }

  /**
   * Devolve o frame só se ele pertencer à assinatura atual **e** servir pra
   * qualidade pedida.
   *
   * `degraded` marca frames capturados com o desfoque pulado. Eles são ótimos
   * enquanto você reproduz (é o que já estava na tela mesmo), mas devolver um
   * deles com o vídeo parado mostraria menos do que o frame realmente tem —
   * então nesse caso é melhor renderizar de novo.
   */
  get(sig: string, frameIndex: number, { allowDegraded = false }: ReadOptions = {}): ImageBitmap | null {
    if (sig !== this.signature) return null;
    const entry = this._frames.get(frameIndex);
    if (!entry) return null;
    if (entry.degraded && !allowDegraded) return null;
    return entry.bitmap;
  }

  has(sig: string, frameIndex: number, opts?: ReadOptions): boolean {
    return this.get(sig, frameIndex, opts) !== null;
  }

  set(
    sig: string,
    frameIndex: number,
    bitmap: ImageBitmap,
    bytes: number,
    { degraded = false }: { degraded?: boolean } = {},
  ): boolean {
    if (sig !== this.signature) {
      // O projeto mudou no meio de uma captura: o frame recém-gerado já
      // nasceu velho. Descarta em vez de contaminar o cache novo.
      bitmap.close?.();
      return false;
    }

    const existing = this._frames.get(frameIndex);
    if (existing) {
      // Um frame de qualidade cheia nunca deve ser rebaixado por uma captura
      // de reprodução que passou por cima dele.
      if (!existing.degraded && degraded) {
        bitmap.close?.();
        return false;
      }
      this.bytes -= existing.bytes;
      existing.bitmap.close?.();
    }

    this._frames.set(frameIndex, { bitmap, bytes, degraded });
    this.bytes += bytes;
    this._evictToBudget(frameIndex);
    return true;
  }

  /** Descarta os frames mais distantes do ponto de interesse até caber no teto. */
  private _evictToBudget(keepNear: number): void {
    if (this.bytes <= this.budgetBytes) return;

    const byDistance = [...this._frames.keys()]
      .sort((a, b) => Math.abs(b - keepNear) - Math.abs(a - keepNear));

    for (const idx of byDistance) {
      if (this.bytes <= this.budgetBytes) break;
      if (idx === keepNear) continue;
      this.delete(idx);
    }
  }

  /**
   * Descarta tudo fora de [first, last].
   *
   * Chamado antes de um pré-render: sem isso, quadros antigos de outras partes
   * da linha do tempo ocupam o orçamento, e o descarte automático acaba
   * comendo justamente os quadros do trecho que está sendo preparado — o que
   * produz um trecho "pronto" cheio de furos, que treme ao reproduzir.
   * Limpando antes, o orçamento vale só pro trecho e a estimativa bate.
   */
  retainRange(first: number, last: number): void {
    for (const idx of [...this._frames.keys()]) {
      if (idx < first || idx > last) this.delete(idx);
    }
  }

  delete(frameIndex: number): void {
    const entry = this._frames.get(frameIndex);
    if (!entry) return;
    this.bytes -= entry.bytes;
    entry.bitmap.close?.();
    this._frames.delete(frameIndex);
  }

  clear(): void {
    for (const { bitmap } of this._frames.values()) bitmap.close?.();
    this._frames.clear();
    this.bytes = 0;
  }

  /** Quais trechos (em índices de frame) já estão prontos — pra pintar na régua. */
  coverage(): Array<[number, number]> {
    const idx = [...this._frames.keys()].sort((a, b) => a - b);
    const spans: Array<[number, number]> = [];
    for (const i of idx) {
      const last = spans[spans.length - 1];
      if (last && i === last[1] + 1) last[1] = i;
      else spans.push([i, i]);
    }
    return spans;
  }
}

export const frameCache = new FrameCache();
