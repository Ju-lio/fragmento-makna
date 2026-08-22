/**
 * As decisões do export que não dependem do navegador.
 *
 * Separadas do `videoExport.ts` porque aquele arquivo só existe dentro de uma
 * aba — ele fala com `VideoEncoder`, canvas e `<video>`. As regras aqui embaixo
 * são aritmética e escolha de parâmetro, e são justamente as que produzem um
 * arquivo silenciosamente errado quando estão erradas: um quadro com dimensão
 * ímpar que o encoder recusa, timestamps que fazem o vídeo sair em câmera
 * lenta, um bitrate que borra tudo.
 */

/**
 * Codecs tentados, em ordem. O primeiro que o navegador aceitar vence.
 *
 * H.264 vem primeiro porque é o que abre em qualquer lugar sem perguntar — a
 * pessoa exporta pra mandar pra alguém, não pra assistir aqui. VP9 fica de
 * reserva pra quando o navegador não traz encoder H.264 (acontece em algumas
 * builds de Linux, onde o codec é licenciado à parte).
 *
 * `muxer` é o nome que o mp4-muxer usa pro mesmo codec — os dois vocabulários
 * não coincidem, e trocar um pelo outro gera um arquivo que não abre.
 */
export const CODEC_CANDIDATES = [
  { codec: 'avc1.640028', muxer: 'avc' as const, label: 'H.264 High' },
  { codec: 'avc1.4d0028', muxer: 'avc' as const, label: 'H.264 Main' },
  { codec: 'avc1.42e01e', muxer: 'avc' as const, label: 'H.264 Baseline' },
  { codec: 'vp09.00.10.08', muxer: 'vp9' as const, label: 'VP9' },
];

/**
 * Codecs de áudio tentados, em ordem. Mesma lógica da lista de vídeo.
 *
 * AAC primeiro porque é o que o MP4 leva por padrão e qualquer player abre. Só
 * que ele é **proprietário, e o encoder não vem em toda build** — no Chromium
 * do Linux, com frequência não vem. Pior: `configure()` de um codec ausente não
 * lança. Ele derruba o encoder em silêncio pelo callback de erro, e quem
 * reclama é o `encode()` seguinte, com "the encoder must be configured first" —
 * uma mensagem que não diz nada sobre codec e aparece depois de a mixagem
 * inteira já ter rodado.
 *
 * Opus é a reserva: livre, presente em todo lugar, e o MP4 aceita.
 */
export const AUDIO_CODEC_CANDIDATES = [
  { codec: 'mp4a.40.2', muxer: 'aac' as const, label: 'AAC-LC' },
  { codec: 'opus', muxer: 'opus' as const, label: 'Opus' },
];

export interface Dimensions { width: number; height: number }

/**
 * Arredonda pra cima até um par, com um mínimo de 2.
 *
 * H.264 guarda croma em metade da resolução (4:2:0), então uma dimensão ímpar
 * simplesmente não existe pro formato: o encoder recusa a configuração, e a
 * mensagem que ele devolve não diz por quê. Um projeto 1080×607 é perfeitamente
 * normal de montar e impossível de exportar sem isto.
 */
export function evenDimensions({ width, height }: Dimensions, scale = 1): Dimensions {
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/**
 * Instante de um quadro no arquivo, em MICROssegundos — a unidade do WebCodecs.
 *
 * Conta a partir do primeiro quadro exportado, não do zero da timeline: quem
 * exporta um trecho de 8s a 12s quer um arquivo de 4s que começa em zero, e não
 * quatro segundos de nada na frente.
 */
export function frameTimestamp(index: number, firstIndex: number, fps: number): number {
  return Math.round(((index - firstIndex) / fps) * 1_000_000);
}

/**
 * De quantos em quantos quadros forçar um keyframe.
 *
 * Dois segundos é o costume: keyframe é caro em bytes, mas é onde o player
 * consegue começar a decodificar. Espaçá-los muito faz o arrasto na barra do
 * player travar; nunca forçá-los deixa o arquivo impossível de navegar.
 */
export function keyFrameInterval(fps: number): number {
  return Math.max(1, Math.round(fps * 2));
}

/** Teto e chão de bitrate. Fora disso não é qualidade, é desperdício ou lama. */
const MIN_BITRATE = 500_000;
const MAX_BITRATE = 40_000_000;

/**
 * Quanto bit por pixel por quadro cada nível de qualidade gasta.
 *
 * O `normal` era 0,1 e virou 0,15 depois de um caso real: um efeito de GRÃO
 * DE FILME exportado a ~6 Mbps saiu com os gradientes lisos quebrados em
 * macroblocos. Medido no arquivo: dentro da região estragada, o salto de
 * luminância nas colunas múltiplas de 16 era **4,38× maior** que nas demais —
 * a assinatura inconfundível da grade do H.264. Fora dela, 0,97×.
 *
 * A causa não é defeito do codificador, é o conteúdo: grão é ruído de alta
 * entropia em cada pixel, e o H.264 não tem síntese de grão. Ele gasta o
 * orçamento inteiro no ruído e não sobra pros degradês. Só existe uma saída
 * de verdade — mais bits.
 *
 * 0,15 dá ~9,3 Mbps em 1080p30, que é a faixa que o YouTube recomenda pra
 * upload em 1080p. `alta` existe pra quem usa grão, película ou desfoque
 * pesado; `rascunho` pra conferir tempo de corte sem esperar.
 */
const BITS_POR_PIXEL = {
  rascunho: 0.06,
  normal: 0.15,
  alta: 0.30,
} as const;

export type Qualidade = keyof typeof BITS_POR_PIXEL;
export const QUALIDADES = Object.keys(BITS_POR_PIXEL) as Qualidade[];

/**
 * Bitrate a partir de quantos pixels por segundo o vídeo tem.
 *
 * Escala sozinho com resolução e fps, que é o ponto — um projeto vertical
 * curto e um 4K não podem usar o mesmo número.
 */
export function chooseBitrate(
  { width, height }: Dimensions,
  fps: number,
  qualidade: Qualidade = 'normal',
): number {
  const raw = width * height * fps * BITS_POR_PIXEL[qualidade];
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, raw)));
}

/** Tamanho aproximado do arquivo, pra UI avisar antes de exportar. */
export const tamanhoAproximado = (bitrate: number, segundos: number): number =>
  Math.round((bitrate / 8) * segundos);

/** Quantos quadros um trecho produz, contando as duas pontas. */
export function frameCount(firstIndex: number, lastIndex: number): number {
  return Math.max(0, lastIndex - firstIndex + 1);
}

/**
 * Nome do arquivo. Leva o trecho no nome porque exportar pedaços diferentes do
 * mesmo projeto é o caso comum, e `video.mp4`, `video (1).mp4`, `video (2).mp4`
 * na pasta de downloads não diz qual é qual.
 */
export function exportFileName(from: number, to: number, extension = 'mp4'): string {
  const s = (t: number) => t.toFixed(1).replace('.', '_');
  return `fragmento_${s(from)}s-${s(to)}s.${extension}`;
}
