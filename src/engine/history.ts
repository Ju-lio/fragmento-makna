/**
 * Undo/redo — uma pilha de estados, genérica e sem React.
 *
 * A pilha guarda *snapshots inteiros* do projeto, não diffs. Parece caro e não
 * é: as edições já são imutáveis (`{ ...p, layers: ... }`), então uma layer que
 * não mudou continua sendo o **mesmo objeto** em todos os snapshots. O
 * compartilhamento estrutural vem de graça do jeito que o estado já era
 * escrito, e cada entrada custa um punhado de ponteiros. Diffs custariam a
 * complexidade de aplicar e desaplicar patch, que é onde esse tipo de código
 * costuma quebrar.
 *
 * O ponteiro (`_index`) anda pela lista em vez de existirem duas pilhas: assim
 * "desfazer três e refazer duas" é aritmética, não malabarismo com dois
 * arrays.
 */

/** Quantos passos guardar. Além disso, o mais antigo cai. */
const DEFAULT_LIMIT = 200;

/**
 * Janela em que edições parecidas viram um passo só.
 *
 * Sem isso, arrastar uma alça de trim gera uma entrada por `pointermove` e
 * desfazer o gesto exige apertar Ctrl+Z duzentas vezes — o que na prática é o
 * mesmo que não ter undo. Ver `mergeKey` em `push`.
 */
const DEFAULT_MERGE_MS = 500;

interface Entry<T> {
  state: T;
  mergeKey: string | null;
  at: number;
}

export interface PushOptions {
  /**
   * Identifica "a mesma ação continuando". Duas edições seguidas com a mesma
   * chave, dentro da janela, ocupam uma entrada só.
   *
   * `null` (padrão) nunca funde: é o certo pra ações discretas — adicionar
   * layer, excluir, reordenar —, onde cada uma é um passo por si.
   */
  mergeKey?: string | null;
  now?: number;
}

export interface HistoryOptions {
  limit?: number;
  mergeWindowMs?: number;
}

export type HistoryListener = () => void;

export class History<T> {
  readonly limit: number;
  readonly mergeWindowMs: number;

  private _entries: Array<Entry<T>> = [];
  private _index = -1;
  private _subs = new Set<HistoryListener>();

  constructor(initial: T, { limit = DEFAULT_LIMIT, mergeWindowMs = DEFAULT_MERGE_MS }: HistoryOptions = {}) {
    this.limit = Math.max(1, limit);
    this.mergeWindowMs = mergeWindowMs;
    this.reset(initial);
  }

  subscribe(cb: HistoryListener): () => void {
    this._subs.add(cb);
    return () => { this._subs.delete(cb); };
  }

  private _emit(): void { for (const cb of this._subs) cb(); }

  /** O estado em que estamos agora. */
  get current(): T {
    const entry = this._entries[this._index];
    if (!entry) throw new Error('history vazio — construa com um estado inicial');
    return entry.state;
  }

  /** Não dá pra desfazer o estado inicial: não existe nada antes dele. */
  get canUndo(): boolean { return this._index > 0; }

  get canRedo(): boolean { return this._index < this._entries.length - 1; }

  /** Quantas entradas existem. Útil pra testar a fusão e o teto. */
  get depth(): number { return this._entries.length; }

  push(state: T, { mergeKey = null, now = Date.now() }: PushOptions = {}): void {
    const top = this._entries[this._index];

    const canMerge = top !== undefined
      && mergeKey !== null
      && top.mergeKey === mergeKey
      && now - top.at <= this.mergeWindowMs
      // Nunca funde no estado inicial: ele é o chão da pilha, e sobrescrevê-lo
      // deixaria a primeira edição impossível de desfazer.
      && this._index > 0
      // Nem por cima de um redo pendente: depois de desfazer, qualquer edição
      // nova é um ramo novo e tem que descartar o futuro que existia.
      && this._index === this._entries.length - 1;

    if (canMerge && top) {
      top.state = state;
      // A janela conta do último toque, não do primeiro: um arrasto longo
      // continua sendo um gesto só enquanto você não solta.
      top.at = now;
      this._emit();
      return;
    }

    // Ação nova: o que estava à frente deixa de valer.
    this._entries.length = this._index + 1;
    this._entries.push({ state, mergeKey, at: now });
    this._index++;

    if (this._entries.length > this.limit) {
      this._entries.shift();
      this._index--;
    }

    this._emit();
  }

  /** Volta um passo. `null` quando não há pra onde voltar. */
  undo(): T | null {
    if (!this.canUndo) return null;
    this._index--;
    this._emit();
    return this.current;
  }

  redo(): T | null {
    if (!this.canRedo) return null;
    this._index++;
    this._emit();
    return this.current;
  }

  /** Recomeça do zero — projeto novo, ou um projeto carregado do disco. */
  reset(state: T): void {
    this._entries = [{ state, mergeKey: null, at: 0 }];
    this._index = 0;
    this._emit();
  }
}
