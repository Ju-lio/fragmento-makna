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
 *
 * ## O relógio anda em QUADROS, não em tempo de parede
 *
 * Esta é a regra que sustenta "Preview = Export", e ela custou o bug mais caro
 * do projeto: *cada play saía diferente do anterior sem ninguém ter editado
 * nada* — som parando antes, clipe cortando antes, e nunca no mesmo lugar.
 *
 * A causa era este relógio acumular o `dt` do rAF (`t += dt`) e só arredondar
 * pra grade lá na frente, no `frameIndexAt`. Isso quer dizer que os instantes
 * amostrados saíam de **onde o rAF calhasse de cair**, e não da grade:
 *
 *  - Um engasgo de decoder de 100ms fazia `t` saltar 100ms de uma vez. A 30fps
 *    são três quadros que aquela reprodução simplesmente não teve — e quais
 *    sumiam mudava a cada play, porque depende do escalonamento do navegador.
 *  - A fronteira de um corte é um instante exato. Com o rAF entregando 4,98 e
 *    depois 5,01, o quadro de t=5,000 — que o export produz — nunca ia pra
 *    tela. É o "cortou antes" que não se conseguia reproduzir duas vezes igual.
 *  - O `dt` é limitado em 0,25s (contra o salto de trocar de aba). Um
 *    travamento maior que isso descartava linha do tempo em silêncio, e o
 *    relógio ficava atrás do mundo real — enquanto o `<audio>` seguia no
 *    relógio do hardware. A divergência caía na correção de deriva do som.
 *
 * Agora o tempo decorrido é acumulado em `_accum` e convertido em **quadros
 * inteiros**: `t` é sempre `_frame / fps`, nunca um valor entre dois quadros.
 * Sob carga a reprodução **pula** quadros — que é o que um editor de vídeo faz
 * mesmo, e é honesto — mas o que vai pra tela é sempre um instante que o export
 * também vai renderizar. A propriedade que se ganha:
 *
 *   **Todo quadro visto no preview é um quadro que o arquivo final contém.**
 *   A reprodução pode mostrar menos quadros; nunca um quadro diferente.
 *
 * `seek` snapa pela mesma razão, e conserta de quebra um erro que o exportador
 * já documentava: marcar IN/OUT no cursor pegava um instante fora da grade
 * (`player.t` vinha do rAF), e o som saía até meio quadro deslocado da imagem.
 * O playhead agora só pousa em quadro que existe.
 */
import { frameIndexAt, timeAtFrameIndex, CACHE_FPS } from './frameCache.ts';
import { advanceClock } from './playbackClock.ts';

export type FrameListener = (t: number) => void;
export type StateListener = (player: Player) => void;

export interface Range { from: number; to: number }

/** Uma leitura de uma fonte de tempo externa. Ver `setTimeSource`. */
export interface ClockSample {
  /** Posição na linha do tempo que a fonte implica, em segundos. */
  position: number;
  /** Quem produziu a leitura. Trocar de fonte invalida o delta — ver o tick. */
  id: string;
}

export type TimeSource = () => ClockSample | null;

class Player {
  t = 0;
  duration = 8;
  playing = false;
  loopPlayback = true;

  /**
   * A grade em que o playhead pousa. Vem do projeto (ver `setFps`).
   *
   * O relógio precisa conhecê-la: é o que separa "andar 16,7ms porque o rAF
   * disparou" de "andar um quadro". Sem isso o preview amostra instantes que o
   * export nunca renderiza.
   */
  fps = CACHE_FPS;

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
  /** Quadro atual — a posição de verdade durante a reprodução; `t` é derivado. */
  private _frame = 0;
  /** Tempo decorrido que ainda não completou um quadro. Guardá-lo é o que
   *  mantém o andamento correto: descartar a sobra faria a reprodução atrasar
   *  um pouco a cada quadro, e um minuto de vídeo terminaria segundos atrás. */
  private _accum = 0;
  private _timeSource: TimeSource | null = null;
  /** Leitura anterior da fonte, pra tirar o delta. */
  private _lastSample: ClockSample | null = null;

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

  /**
   * Instala uma fonte de tempo mais confiável que o rAF — na prática, o som.
   *
   * ## Por que o som manda
   *
   * Havia dois relógios na reprodução: o do rAF, que o navegador atrasa a cada
   * coleta de lixo, aba em segundo plano ou engasgo de decoder; e o do
   * `<audio>`, que corre no relógio do **hardware de som** e é o mais estável
   * que existe na plataforma. O editor corrigia o segundo pra alcançar o
   * primeiro — ou seja, disciplinava o relógio bom pelo ruim.
   *
   * O preço aparecia como som cortado em lugar diferente a cada reprodução: uma
   * travada de rAF punha os dois a mais de 90ms de distância, e acima disso a
   * única correção possível era um **seek**, que é um corte audível. Nada disso
   * era editado pelo usuário, e nada disso se repetia igual.
   *
   * Invertido, o problema deixa de existir em vez de ser tolerado: a linha do
   * tempo anda **o tanto que o som de fato andou**, e a imagem segue o som.
   * Dessincronia entre áudio e vídeo vira impossível por construção, e não algo
   * que uma tolerância mantém pequeno.
   *
   * O player não conhece áudio, e não deve: recebe uma função que devolve a
   * posição na linha do tempo. Quem sabe eleger a trilha condutora é o
   * `audioSync`, e é lá que essa regra vive.
   *
   * Passe `null` pra voltar ao rAF (é o que vale sem som no projeto).
   */
  setTimeSource(src: TimeSource | null): void {
    this._timeSource = src;
    this._lastSample = null;
  }

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

  /**
   * Snapa um instante qualquer pra grade. Arredonda pro quadro MAIS PRÓXIMO,
   * exatamente como `frameIndexAt` — o exportador usa a mesma conta pra achar o
   * primeiro e o último quadro do trecho, então marcar IN no cursor passa a
   * cair no mesmo quadro que o arquivo vai começar.
   */
  snap(t: number): number {
    const clamped = Math.max(0, Math.min(this.duration, t));
    return timeAtFrameIndex(frameIndexAt(clamped, this.fps), this.fps);
  }

  seek(t: number): void {
    this.t = this.snap(t);
    // O cursor de quadro segue o playhead: arrastar durante a reprodução tem
    // que reposicionar de onde ela continua, senão o próximo tick voltaria pro
    // quadro anterior ao arrasto.
    this._frame = frameIndexAt(this.t, this.fps);
    this._accum = 0;
    // A posição saltou: o delta pra leitura anterior do som não significa mais
    // nada, e somá-lo empurraria o playhead pelo tamanho do salto.
    this._lastSample = null;
    this._dirty = true;
  }

  /**
   * A grade mudou (projeto novo, ou fps editado). Repousa o playhead nela.
   *
   * Sem re-snapar, um projeto a 24fps aberto depois de um a 30 deixaria o
   * cursor num instante que não é quadro de nenhum dos dois.
   */
  setFps(fps: number): void {
    const next = Number.isFinite(fps) && fps > 0 ? fps : CACHE_FPS;
    if (next === this.fps) return;
    this.fps = next;
    this.seek(this.t);
    this._emitState();
  }

  setDuration(d: number): void {
    const next = Math.max(0.5, d);
    // Sai cedo quando nada mudou: a duração passou a ser DERIVADA do conteúdo,
    // então isto é chamado a cada edição de layer — inclusive as que não mexem
    // no comprimento, que são a maioria.
    if (next === this.duration) return;
    this.duration = next;
    if (this.t > this.duration) this.seek(this.duration);
    this._dirty = true;
    this._emitState();
  }

  play(): void {
    if (this.playing) return;
    if (this.t >= this.duration) this.t = 0;
    // Parte de um quadro da grade, sempre. Um play dado com o cursor herdado de
    // um estado antigo, fora da grade, contaminaria a reprodução inteira: cada
    // quadro seguinte carregaria o mesmo deslocamento.
    this._frame = frameIndexAt(this.t, this.fps);
    this._accum = 0;
    this._lastSample = null;
    this.t = timeAtFrameIndex(this._frame, this.fps);
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

        /**
         * Quanto tempo andar: o que o SOM andou, se houver som conduzindo.
         *
         * Usa-se o **delta** entre duas leituras, nunca a posição absoluta. A
         * posição absoluta obrigaria a acertar o instante em que o `play()`
         * chega ao alto-falante (latência variável, de 1 a 157ms medidos) e
         * daria um salto toda vez que a trilha condutora mudasse. O delta não
         * tem nenhum dos dois problemas: só diz "saiu tanto de som desde o
         * último quadro", que é exatamente o que a linha do tempo precisa
         * andar pra imagem não descolar.
         *
         * O clamp aqui é bem mais folgado que o do rAF de propósito. O limite
         * de 0,25s existe contra o salto de voltar pra uma aba que ficou
         * parada; já o delta do som é **medição do que aconteceu de verdade** —
         * se saíram 400ms de áudio, a linha do tempo tem que andar 400ms, senão
         * a imagem fica pra trás justamente na travada em que ela já está
         * sofrendo. Descartar isso era o que fazia a deriva crescer até o seek.
         */
        const sample = this._timeSource?.() ?? null;
        let elapsed = dt;
        if (sample && this._lastSample && this._lastSample.id === sample.id) {
          elapsed = Math.min(Math.max(sample.position - this._lastSample.position, 0), 1);
        }
        this._lastSample = sample;

        // A conta em si é pura e mora em `playbackClock.ts`: errar um quadro
        // aqui não se enxerga olhando a tela, então tem que dar pra testar.
        const next = advanceClock({
          frame: this._frame,
          accum: this._accum,
          elapsed,
          fps: this.fps,
          duration: this.duration,
          loop: this.loopPlayback,
        });

        this._frame = next.frame;
        this._accum = next.accum;

        if (next.stepped) {
          // Voltou pro início do laço: o som vai ser reposicionado, e o delta
          // que atravessa essa volta é salto, não tempo decorrido.
          if (next.t < this.t) this._lastSample = null;
          this.t = next.t;
          this._dirty = true;
        }
        if (next.ended) this.pause();
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
