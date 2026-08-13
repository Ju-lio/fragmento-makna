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
 * Bitrate a partir de quantos pixels por segundo o vídeo tem.
 *
 * O fator (~0,1 bit por pixel por quadro) é a régua usada pra H.264 em
 * qualidade de entrega: dá ~6 Mbps em 1080p30, que é a ordem de grandeza do
 * que o YouTube recomenda pra upload. Escala sozinho com resolução e fps, que
 * é o ponto — um projeto vertical curto e um 4K não podem usar o mesmo número.
 */
export function chooseBitrate({ width, height }: Dimensions, fps: number): number {
  const raw = width * height * fps * 0.1;
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, raw)));
}

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
