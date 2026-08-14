/**
 * Os quadros são decodificados por nós, não pelo `<video>`.
 *
 * ## Por que tirar o elemento do caminho da imagem
 *
 * Um `<video>` é um tocador, não um leitor de quadros. Você pede uma posição e
 * ele chega lá **quando chegar** — e o que estiver na tela nesse meio-tempo é o
 * quadro que ele tinha antes. Isso é aceitável pra assistir e é exatamente o
 * errado pra editar: durante a reprodução ao vivo o elemento corre no relógio
 * do pipeline de mídia, então a imagem composta num instante da grade mostra
 * onde ele estiver, não o quadro daquele instante.
 *
 * Era o último resíduo de infidelidade do preview, e não tinha conserto por
 * ajuste de tolerância — é o que o elemento **é**.
 *
 * Aqui a pergunta muda de "leve o elemento até t" para "me dê o quadro de t".
 * Demuxamos o arquivo e decodificamos com WebCodecs (`VideoDecoder`, via
 * mediabunny), guardando os quadros num anel indexado por tempo de origem. O
 * preview então **desenha o quadro certo ou não desenha nada** — nunca o
 * vizinho. É o movimento simétrico do export, que já usava `VideoEncoder`.
 *
 * ## Dois regimes, porque medir mostrou 20x de diferença
 *
 * Medido neste navegador, num H.264 1080p com keyframe a cada 60 quadros:
 *
 * | acesso | mecanismo | custo por quadro |
 * |---|---|---|
 * | sequencial | `samples()` (gerador) | ~0,5–4 ms |
 * | sequencial | `getSample()` avulso | **~50 ms** |
 * | aleatório | `getSample()` avulso | ~40 ms |
 *
 * `getSample` refaz o trabalho desde o keyframe anterior a cada chamada, e a
 * 30fps o orçamento é de 33ms — usá-lo quadro a quadro não fecha a conta em
 * 1080p. Por isso a reprodução puxa de um **gerador** que segue adiante, e só o
 * scrub (que é um salto isolado, e onde 40ms é bem melhor que o seek de um
 * `<video>`) usa a chamada avulsa.
 *
 * ## Memória
 *
 * Um `VideoSample` segura um quadro decodificado inteiro — na casa dos MB em
 * 1080p. O anel é pequeno de propósito: como decodificar custa menos que um
 * quadro de tempo real, não há motivo pra correr muito à frente, e correr à
 * frente é justamente o que estouraria a memória. Todo caminho de saída fecha o
 * que descarta; um sample não fechado é o quadro inteiro preso até o coletor
 * passar, e é o erro que o exportador já documenta.
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import type { InputVideoTrack, VideoSample } from 'mediabunny';
import { mediaBlob } from './mediaStore.ts';
import type { DecodedFrame, Project, VideoLayer, VideoTiming } from './types.ts';

/** Quadros decodificados mantidos por arquivo. Ver "Memória" acima. */
const RING_MAX = 16;

/** Quantos quadros manter decodificados à frente do que se está pedindo. */
const LOOKAHEAD = 6;

/**
 * Salto que faz o fluxo recomeçar em vez de avançar até lá.
 *
 * Abaixo disto sai mais barato deixar o gerador correr (ele já está com o
 * decoder quente); acima, recomeçar do keyframe mais próximo do destino ganha.
 */
const RESTART_GAP = 0.5;

/**
 * Empurrãozinho pra frente na hora de perguntar "que quadro cobre este
 * instante".
 *
 * A busca é pelo último quadro com timestamp **≤** o pedido, e a fronteira é
 * fina demais pra confiar em ponto flutuante: o quadro 61 de um vídeo a 30fps
 * começa em 2,0333333…, e um pedido que caia um bilionésimo abaixo disso
 * devolve o quadro 60 — um quadro inteiro de erro. Medido: pedir `2.0333`
 * (truncado) devolveu o quadro 60 quando o certo era o 61.
 *
 * 1µs é grande o bastante pra vencer o erro de arredondamento (que é da ordem
 * de 1e-15 nestas magnitudes) e 30 mil vezes menor que um quadro, então nunca
 * pula pro seguinte.
 */
const NUDGE = 1e-6;

/** Blobs entregues pela interface, antes mesmo de o IndexedDB ter gravado. */
const blobs = new Map<string, Blob>();

/**
 * Registra os bytes de uma mídia recém-importada.
 *
 * O `mediaBlob` do IndexedDB é a fonte canônica, mas a gravação é assíncrona: um
 * arquivo acabado de arrastar pra tela precisa decodificar **agora**, não quando
 * a transação fechar.
 */
export function registerBlob(id: string, blob: Blob): void {
  blobs.set(id, blob);
}

async function blobFor(id: string): Promise<Blob | null> {
  return blobs.get(id) ?? await mediaBlob(id);
}

/** Um arquivo aberto, com o decodificador e o anel de quadros dele. */
class SourceDecoder {
  /** Resolve `false` quando este navegador não abre o arquivo. Ver `usable`. */
  readonly ready: Promise<boolean>;

  private sink: VideoSampleSink | null = null;
  private track: InputVideoTrack | null = null;
  /** null enquanto abre. Ver `state` — dois estados não bastavam. */
  private opened: boolean | null = null;

  /** Quadros decodificados, em ordem de apresentação. */
  private ring: VideoSample[] = [];

  private gen: AsyncGenerator<VideoSample, void, unknown> | null = null;
  /** Onde o fluxo atual começou — pra saber se um pedido é "adiante" ou salto. */
  private streamAt = -Infinity;
  /** O último instante que o gerador já entregou. */
  private reached = -Infinity;
  private filling: Promise<void> | null = null;
  /** Invalida trabalho em voo quando o fluxo é reiniciado. */
  private generation = 0;

  private readonly id: string;

  constructor(id: string) {
    this.id = id;
    this.ready = this.open();
  }

  private async open(): Promise<boolean> {
    const r = await this.tryOpen();
    this.opened = r;
    return r;
  }

  private async tryOpen(): Promise<boolean> {
    try {
      const blob = await blobFor(this.id);
      if (!blob) return false;
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) return false;
      this.track = track;
      this.sink = new VideoSampleSink(track);
      return true;
    } catch {
      // Formato que este navegador não abre. Não é motivo pra derrubar o
      // editor: quem chama cai no `<video>`, que pode dar conta.
      return false;
    }
  }

  get usable(): boolean { return this.sink !== null; }

  /**
   * Três estados, e não dois, porque "ainda não sei" não é "não dá".
   *
   * Abrir o arquivo é assíncrono. Tratar o intervalo como "não decodifica"
   * mandava o desenho pro `<video>` justamente nos primeiros quadros — e como
   * ninguém pedia quadro nenhum, o decodificador nunca chegava a ser criado.
   * O preview ficava no caminho de reserva pra sempre, sem nada indicando.
   */
  get state(): 'opening' | 'ok' | 'unsupported' {
    if (this.opened === null) return 'opening';
    return this.opened ? 'ok' : 'unsupported';
  }

  /**
   * O quadro que COBRE este instante, ou null.
   *
   * Síncrono de propósito: é o que o `drawFrame` chama, e `drawFrame` é função
   * pura de (projeto, tempo) — não pode esperar por nada.
   *
   * Devolver o quadro anterior quando o certo ainda não chegou seria refazer,
   * com outro mecanismo, exatamente o defeito do `<video>`. Melhor devolver
   * null e deixar quem chama segurar a imagem anterior de propósito.
   */
  sampleAt(srcTime: number): VideoSample | null {
    const alvo = srcTime + NUDGE;
    let found: VideoSample | null = null;
    for (const s of this.ring) {
      if (s.timestamp <= alvo) found = s;
      else break;
    }
    if (!found) return null;
    // Cobertura: um quadro vale até o próximo começar. Sem esta checagem, um
    // anel atrasado devolveria quadro velho como se fosse o atual.
    if (found.duration > 0 && alvo >= found.timestamp + found.duration) return null;
    return found;
  }

  /** Garante o quadro de `srcTime` no anel, e alguns adiante. */
  async fill(srcTime: number): Promise<void> {
    if (!this.sink) return;
    // Uma frente de decodificação por arquivo. Duas competiriam pelo mesmo
    // gerador e embaralhariam a ordem dos quadros.
    while (this.filling) await this.filling;

    if (this.sampleAt(srcTime) && this.reached >= srcTime + LOOKAHEAD * 0.033) return;

    this.filling = this.fillNow(srcTime);
    try { await this.filling; } finally { this.filling = null; }
  }

  private async fillNow(srcTime: number): Promise<void> {
    const sink = this.sink;
    if (!sink) return;

    // Salto pra trás, ou pra longe demais adiante: o gerador atual não serve.
    // Deixar ele correr até lá decodificaria tudo pelo caminho, à toa.
    if (srcTime < this.streamAt || srcTime > this.reached + RESTART_GAP) {
      this.restart(srcTime);
    }

    if (!this.gen) {
      this.streamAt = srcTime;
      this.gen = sink.samples(Math.max(0, srcTime));
    }

    const mine = this.generation;
    const ate = srcTime + LOOKAHEAD * 0.033;

    while (this.reached < ate) {
      const { value, done } = await this.gen.next();
      if (done) { this.gen = null; break; }
      // Reiniciaram o fluxo enquanto esperávamos: este quadro é de outro
      // pedido e não pode entrar no anel.
      if (this.generation !== mine) { value.close(); return; }
      this.ring.push(value);
      this.reached = value.timestamp;
      this.trim(srcTime);
    }
  }

  /** Um quadro exato, sem depender do fluxo — pro scrub e pro export. */
  async exact(srcTime: number): Promise<VideoSample | null> {
    if (!this.sink) return null;
    const pronto = this.sampleAt(srcTime);
    if (pronto) return pronto;
    await this.fill(srcTime);
    return this.sampleAt(srcTime);
  }

  /** Descarta o que ficou pra trás, mantendo o anel pequeno. */
  private trim(around: number): void {
    while (this.ring.length > RING_MAX) {
      // Sempre sobra o mais antigo; se ele ainda cobre o instante pedido, para.
      const primeiro = this.ring[0];
      if (!primeiro) break;
      if (primeiro.timestamp > around - 0.5) break;
      primeiro.close();
      this.ring.shift();
    }
    // Teto absoluto: um anel que só cresce é um vazamento com nome bonito.
    while (this.ring.length > RING_MAX * 2) {
      this.ring.shift()?.close();
    }
  }

  private restart(at: number): void {
    this.generation++;
    void this.gen?.return();
    this.gen = null;
    this.streamAt = at;
    this.reached = -Infinity;
    for (const s of this.ring) s.close();
    this.ring = [];
  }

  dispose(): void {
    this.restart(-Infinity);
    this.sink = null;
    this.track = null;
  }
}

const decoders = new Map<string, SourceDecoder>();

/** O decodificador deste arquivo, abrindo-o na primeira vez. */
export function decoderFor(mediaId: string): SourceDecoder {
  let d = decoders.get(mediaId);
  if (!d) { d = new SourceDecoder(mediaId); decoders.set(mediaId, d); }
  return d;
}

/**
 * O quadro decodificado que cobre `srcTime`, se já estiver em mãos.
 *
 * Nunca decodifica: é chamada de dentro do desenho, que é síncrono. Quem quer
 * garantir o quadro chama `ensureFrame` antes.
 */
export function frameAt(mediaId: string, srcTime: number): VideoSample | null {
  const d = decoders.get(mediaId);
  return d && d.usable ? d.sampleAt(srcTime) : null;
}

/** Garante o quadro (e alguns adiante) — o que o preview pede a cada quadro. */
export async function ensureFrame(mediaId: string, srcTime: number): Promise<VideoSample | null> {
  const d = decoderFor(mediaId);
  if (!(await d.ready)) return null;
  return d.exact(srcTime);
}

/** Este arquivo decodifica neste navegador? Resolve antes do primeiro quadro. */
export async function canDecode(mediaId: string): Promise<boolean> {
  return decoderFor(mediaId).ready;
}

/**
 * O `frameFor` que o `drawFrame` espera, para um instante da linha do tempo.
 *
 * Existe aqui, e não copiado em cada chamador, porque é a tradução de "instante
 * do projeto" para "instante do arquivo" — e preview, pré-render e export
 * precisam dela **idêntica**. Duas cópias divergiriam num caso de trim e o
 * arquivo exportado deixaria de bater com o que se viu.
 */
export function framesAt(t: number): (layer: VideoLayer) => DecodedFrame | null {
  return layer => frameAt(layer.mediaId, sourceTimeFor(layer, t));
}

/** Instante do arquivo, preso ao que o arquivo tem. */
export function sourceTimeFor(layer: VideoTiming, t: number): number {
  const bruto = (layer.trimStart || 0) + (t - layer.start);
  // `Number.isFinite` não estreita o tipo, daí o cast — mesma conta e mesmo
  // cuidado do `clampToSource` em `videoSync.ts`.
  const max = Number.isFinite(layer.sourceDuration) ? (layer.sourceDuration as number) : bruto;
  return Math.max(0, Math.min(bruto, max));
}

/** As layers de vídeo que aparecem neste instante. */
function visibleAt(project: Project, t: number): VideoLayer[] {
  return project.layers.filter(
    (l): l is VideoLayer =>
      l.type === 'video' && t >= l.start && t <= l.start + l.duration,
  );
}

/** Esta mídia é servida pelo decodificador (e não pelo `<video>`)? */
export function decodes(mediaId: string): boolean {
  return decoders.get(mediaId)?.state === 'ok';
}

/**
 * Todo quadro necessário para desenhar `t` já está decodificado?
 *
 * Layer cuja mídia não decodifica não conta: ela vai pelo `<video>`, e quem
 * decide se aquele elemento está pronto é o `videosParkedAt`.
 */
export function framesReadyAt(project: Project, t: number): boolean {
  for (const layer of visibleAt(project, t)) {
    // `decoderFor`, não `decoders.get`: é esta chamada que abre o arquivo na
    // primeira vez. Só consultar criava um impasse — ninguém pedia quadro
    // porque não havia decodificador, e não havia decodificador porque
    // ninguém pedia quadro.
    const d = decoderFor(layer.mediaId);
    if (d.state === 'unsupported') continue;   // vai pelo <video>
    if (d.state === 'opening') return false;   // espera: ainda pode dar certo
    if (!d.sampleAt(sourceTimeFor(layer, t))) return false;
  }
  return true;
}

/**
 * Pede os quadros de `t` — e alguns adiante, que é o que sustenta a reprodução.
 *
 * Resolve quando todos estiverem em mãos. Quem chama repinta então: o desenho é
 * síncrono e não pode esperar, então a sequência é "não deu, segura a imagem,
 * repinta quando chegar".
 */
export async function requestFramesAt(project: Project, t: number): Promise<void> {
  await Promise.all(
    visibleAt(project, t).map(l => ensureFrame(l.mediaId, sourceTimeFor(l, t))),
  );
}

/** Solta tudo — troca de projeto. */
export function releaseDecoders(): void {
  for (const d of decoders.values()) d.dispose();
  decoders.clear();
  blobs.clear();
}
