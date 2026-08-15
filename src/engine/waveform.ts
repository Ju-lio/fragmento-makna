/**
 * A forma de onda de um arquivo, reduzida ao que cabe numa timeline.
 *
 * Existe porque cortar no ritmo é impossível olhando um retângulo colorido: o
 * que se procura é a batida, o silêncio entre as frases, o ponto onde a voz
 * entra. Isso está no envelope do sinal, não no nome do arquivo.
 *
 * Duas etapas, de propósito, porque têm custos muito diferentes:
 *
 *  1. **Uma vez por arquivo** — `computePeaks` varre os samples e guarda um
 *     envelope de resolução fixa. É a parte cara (um MP3 de 3 min são milhões
 *     de amostras), e é a que não pode se repetir.
 *  2. **A cada desenho** — `barsFor` recorta a janela do clipe e reamostra pro
 *     número de barras que cabem na largura atual. É aritmética sobre um array
 *     pequeno, então dar zoom pode redesenhar à vontade.
 *
 * Guardar o envelope em vez do PCM é o que torna isso viável de manter na
 * memória: 120 baldes por segundo contra 48000 amostras é 400x menos, e a
 * diferença não aparece numa faixa de 24 pixels de altura.
 */

/** Baldes por segundo do envelope guardado. ~8ms cada — mais fino que um pixel. */
export const PEAKS_PER_SECOND = 120;

/** Envelope de um arquivo: o vale e o pico de cada balde. */
export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  perSecond: number;
  /** Maior amplitude do arquivo inteiro. Alimenta `viewScale`. */
  peak: number;
}

/** Um trecho de envelope pronto pra desenhar, uma entrada por barra. */
export interface Bars {
  min: Float32Array;
  max: Float32Array;
}

const EMPTY: Bars = { min: new Float32Array(0), max: new Float32Array(0) };

/**
 * Reduz os samples a um envelope de vale e pico por balde.
 *
 * Vale **e** pico, não a média nem o RMS: é o extremo que dá a silhueta que se
 * reconhece como som. Uma média tende a zero em qualquer sinal simétrico e
 * desenharia uma linha reta pra música e pra silêncio igualmente.
 *
 * Os canais são combinados pelo extremo, não somados — somar estouraria a
 * faixa em material já normalizado, e o que interessa aqui é a forma.
 */
export function computePeaks(
  channels: readonly Float32Array[],
  sampleRate: number,
  perSecond: number = PEAKS_PER_SECOND,
): Peaks {
  const first = channels[0];
  if (!first || !sampleRate || perSecond <= 0) {
    return { min: new Float32Array(0), max: new Float32Array(0), perSecond, peak: 0 };
  }

  const perBucket = Math.max(1, Math.round(sampleRate / perSecond));
  const buckets = Math.ceil(first.length / perBucket);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  let peak = 0;

  for (let b = 0; b < buckets; b++) {
    const start = b * perBucket;
    const end = Math.min(start + perBucket, first.length);
    let lo = 0;
    let hi = 0;

    for (const channel of channels) {
      for (let i = start; i < end; i++) {
        const v = channel[i] as number;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }

    min[b] = lo;
    max[b] = hi;
    if (-lo > peak) peak = -lo;
    if (hi > peak) peak = hi;
  }

  return { min, max, perSecond, peak };
}

/**
 * Quanto ampliar a onda pra ela caber na altura disponível.
 *
 * A onda é normalizada **pela escala do arquivo**, não desenhada em valor
 * absoluto. Numa faixa de 24 pixels o absoluto falha justamente onde importa:
 * material de fala ou não masterizado costuma ter pico em -18 dB, o que dá
 * menos de um pixel de altura — uma linha reta, exatamente quando você precisa
 * enxergar onde a voz entra.
 *
 * Silêncio interno continua sendo silêncio (a divisão é pelo pico do arquivo,
 * não por trecho), então o que se ganha é contraste, não uma mentira. O piso
 * evita o outro extremo: um arquivo quase mudo seria amplificado até virar
 * ruído de fundo desenhado como se fosse conteúdo.
 */
const VIEW_FLOOR = 0.05;   // ~-26 dB

export function viewScale(peaks: Pick<Peaks, 'peak'>): number {
  return 1 / Math.max(peaks.peak, VIEW_FLOOR);
}

/**
 * Recorta o trecho `from..to` (em segundos do ARQUIVO) em `count` barras.
 *
 * Reamostra pelo extremo de cada intervalo, de novo: encolher pegando um balde
 * a cada N faria a onda cintilar a cada passo de zoom, porque a barra desenhada
 * passaria a ser um balde diferente e arbitrário. Pelo extremo, a silhueta é
 * estável — ampliar revela detalhe, nunca troca o desenho por outro.
 */
export function barsFor(peaks: Peaks, from: number, to: number, count: number): Bars {
  const total = peaks.min.length;
  if (!total || count <= 0 || !(to > from)) return EMPTY;

  // Presos ao que o arquivo tem: um clipe esticado além da fonte pediria
  // baldes que não existem, e ler fora do array devolve `undefined`.
  const firstBucket = Math.max(0, Math.floor(from * peaks.perSecond));
  const lastBucket = Math.min(total, Math.ceil(to * peaks.perSecond));
  const span = lastBucket - firstBucket;
  if (span <= 0) return EMPTY;

  const min = new Float32Array(count);
  const max = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const start = firstBucket + Math.floor((i * span) / count);
    // Pelo menos um balde por barra: com o clipe muito ampliado, `span` é menor
    // que `count` e o intervalo fecharia vazio, desenhando buracos.
    const end = Math.max(start + 1, firstBucket + Math.floor(((i + 1) * span) / count));

    let lo = 0;
    let hi = 0;
    for (let b = start; b < end && b < total; b++) {
      const l = peaks.min[b] as number;
      const h = peaks.max[b] as number;
      if (l < lo) lo = l;
      if (h > hi) hi = h;
    }

    min[i] = lo;
    max[i] = hi;
  }

  return { min, max };
}

/**
 * O trecho do arquivo que um clipe mostra.
 *
 * Trivial, e é justamente por isso que vive aqui: a mesma conta feita de novo
 * dentro do componente é como a onda passa a discordar do que o clipe toca
 * depois de um trim — o erro clássico, e invisível olhando a onda.
 */
export function clipWindow(
  layer: { trimStart: number; duration: number },
): { from: number; to: number } {
  const from = layer.trimStart || 0;
  return { from, to: from + layer.duration };
}
