/**
 * De onde vem o pixel de uma layer de vídeo.
 *
 * ## Por que não é mais o `<video>`
 *
 * Um `<video>` é um tocador, não um leitor de quadros: você pede uma posição e
 * ele chega lá **quando chegar**, mostrando o quadro anterior no meio do
 * caminho. Serve pra assistir e é errado pra editar — parar em cima de um corte
 * e ver o quadro de antes dele vinha exatamente disso, e não tinha conserto por
 * ajuste de tolerância. É o que o elemento **é**.
 *
 * Aqui a pergunta muda de "leve o elemento até t" para **"me dê o quadro N"**.
 *
 * ## Por que este arquivo é uma casca fina
 *
 * A primeira tentativa foi escrever o produtor de quadros à mão, sobre
 * WebCodecs. Ela funcionou no teste e falhou no uso real, de seis jeitos
 * diferentes — todos já resolvidos, e melhor, no `@elah/core` (Apache-2.0):
 *
 *  - **Fome do pool.** Um decodificador por hardware tem um punhado de quadros
 *    de saída. Guardar `VideoFrame` vivos num anel trava o decodificador; a
 *    saída é copiar pra `ImageBitmap` e fechar o `VideoFrame` na hora.
 *  - **Cão-de-guarda.** Sem detectar "pedi e o decodificador não avança", um
 *    engasgo vira tela congelada em silêncio. Lá, N ticks sem avanço reiniciam
 *    o fluxo sozinho.
 *  - **Recuperação de erro.** Decodificador que morre precisa ser reaberto, não
 *    apenas registrado.
 *  - **Corrida.** Dois pedidos simultâneos não podem puxar do mesmo fluxo.
 *  - **Salto pra trás.** Scrub para trás é o caso comum e o mais fácil de
 *    tratar mal.
 *  - **Fronteira de quadro em ponto flutuante.** Pedir por índice INTEIRO faz o
 *    problema deixar de existir; pedir por segundos exige epsilon e ainda erra.
 *
 * Custo medido: 24,8 kB (6,7 kB comprimido). O demuxer entra por `import()`
 * dinâmico, ou seja, só quando um vídeo é de fato aberto.
 */

import { createDefaultDemuxerFactory, createVideoFrameProvider } from '@elah/core';
import type { Project, VideoLayer, VideoTiming } from './types.ts';

/** O que `getCurrent` devolve: os dois desenham com `ctx.drawImage`. */
export type DecodedFrame = VideoFrame | ImageBitmap;

/** Quantos quadros manter decodificados à frente do cursor. */
const LOOKAHEAD = 16;

interface Provider {
  getCurrent(sourceFrame: number): DecodedFrame | null;
  setPlayhead(sourceFrame: number, opts?: { lookaheadFrames?: number }): void;
  markIdle(): void;
  markActive(): void;
  dispose(): void;
}

const provedores = new Map<string, Provider>();
const urls = new Map<string, string>();

/**
 * Diz de onde ler os bytes de uma mídia. Chamado onde a `blob:` URL nasce.
 *
 * Guardar a URL em vez do `Blob` é de propósito: é o que o provedor aceita, e
 * o `mediaStore` já mantém uma URL estável por arquivo — criar outra vazaria
 * uma cópia por chamada.
 */
export function registerSource(mediaId: string, url: string): void {
  if (urls.get(mediaId) === url) return;
  // Trocou de fonte: o provedor antigo aponta pra bytes que não valem mais.
  provedores.get(mediaId)?.dispose();
  provedores.delete(mediaId);
  urls.set(mediaId, url);
}

function provedorDe(mediaId: string, fps: number): Provider | null {
  const existente = provedores.get(mediaId);
  if (existente) return existente;

  const url = urls.get(mediaId);
  if (!url) return null;

  /**
   * O `demuxerFactory` NÃO é opcional na prática.
   *
   * Sem ele, `createVideoFrameProvider` devolve um gerador SINTÉTICO — um
   * padrão de teste com o número do quadro e o fundo trocando — e sequer olha
   * a `src`. Todo vídeo importado virava esse padrão.
   *
   * E o modo como isso passou é a lição: as duas verificações que fiz checavam
   * que o quadro CHEGOU e que quadros consecutivos eram DIFERENTES. O sintético
   * satisfaz as duas com folga. Verificar entrega não é verificar conteúdo.
   */
  const p = createVideoFrameProvider(url, {
    fps,
    lookaheadFrames: LOOKAHEAD,
    demuxerFactory: createDefaultDemuxerFactory(),
    /**
     * SEM `flipY`. O conversor padrão do `@elah/core` inverte o Y porque o
     * renderer deles é WebGL, onde a textura tem a origem embaixo. O nosso é
     * Canvas 2D, cuja origem já é em cima — herdar a inversão põe o vídeo de
     * cabeça pra baixo, e foi o que aconteceu.
     */
    frameConverter: (frame: VideoFrame) => createImageBitmap(frame),
  }) as Provider;
  provedores.set(mediaId, p);
  return p;
}

/**
 * Instante do arquivo que corresponde a `t` na linha do tempo, preso ao que o
 * arquivo tem. O trim desloca a leitura, não a posição.
 */
export function sourceTimeOf(layer: VideoTiming, t: number): number {
  const bruto = (layer.trimStart || 0) + (t - layer.start);
  // `Number.isFinite` não estreita o tipo, daí o cast.
  const max = Number.isFinite(layer.sourceDuration) ? (layer.sourceDuration as number) : bruto;
  return Math.max(0, Math.min(bruto, max));
}

/**
 * Índice do quadro do arquivo, na grade do projeto.
 *
 * Inteiro, e é o ponto todo: pedir por segundos põe a fronteira do quadro à
 * mercê do ponto flutuante — o quadro 61 a 30fps começa em 2,0333333…, e um
 * pedido um bilionésimo abaixo devolve o 60. Índice inteiro não tem fronteira.
 */
export function sourceFrameOf(layer: VideoTiming, t: number, fps: number): number {
  return Math.round(sourceTimeOf(layer, t) * fps);
}

/** As layers de vídeo que aparecem neste instante. */
function visiveisEm(project: Project, t: number): VideoLayer[] {
  return project.layers.filter(
    (l): l is VideoLayer => l.type === 'video' && t >= l.start && t <= l.start + l.duration,
  );
}

/**
 * Avisa onde o cursor está, pra decodificação correr à frente.
 *
 * Barato e idempotente: pode (e deve) ser chamado a cada quadro. É o que
 * transforma "decodifica quando pedirem" em "já estava pronto".
 */
export function aimAt(project: Project, t: number): void {
  const fps = project.fps;
  for (const layer of visiveisEm(project, t)) {
    provedorDe(layer.mediaId, fps)?.setPlayhead(sourceFrameOf(layer, t, fps));
  }
}

/**
 * O quadro de uma layer neste instante, se já estiver decodificado.
 *
 * Síncrono e sem efeito colateral de espera: é chamado de dentro do desenho, e
 * `drawFrame` é função pura de (projeto, tempo, quadros) — não pode aguardar
 * nada. Devolver o quadro vizinho quando o certo não chegou seria repetir, com
 * outro mecanismo, o defeito do `<video>`.
 */
export function frameFor(project: Project, t: number) {
  const fps = project.fps;
  return (layer: VideoLayer): DecodedFrame | null =>
    provedorDe(layer.mediaId, fps)?.getCurrent(sourceFrameOf(layer, t, fps)) ?? null;
}

/** Todo quadro necessário pra desenhar `t` já está em mãos? */
export function framesReadyAt(project: Project, t: number): boolean {
  const pegar = frameFor(project, t);
  return visiveisEm(project, t).every(l => pegar(l) !== null);
}

/**
 * Espera os quadros de `t` ficarem prontos. Usado pelo pré-render e pelo
 * export, que podem esperar — o preview, não.
 *
 * O limite existe porque um arquivo que este navegador não decodifica nunca
 * ficaria pronto, e um export não pode ficar preso pra sempre. Estourado o
 * limite, quem chama desenha com o que tiver e marca o quadro como degradado.
 */
export async function awaitFrames(project: Project, t: number, limiteMs = 3000): Promise<boolean> {
  aimAt(project, t);
  if (framesReadyAt(project, t)) return true;

  const fim = performance.now() + limiteMs;
  while (performance.now() < fim) {
    await new Promise(r => setTimeout(r, 8));
    aimAt(project, t);
    if (framesReadyAt(project, t)) return true;
  }
  return false;
}

/** Solta o decodificador de quem não está sendo usado agora. */
export function idleUnused(project: Project, t: number): void {
  const emUso = new Set(visiveisEm(project, t).map(l => l.mediaId));
  for (const [id, p] of provedores) {
    if (emUso.has(id)) p.markActive();
    else p.markIdle();
  }
}

/**
 * O provedor concreto, pro `prerender` e pro export. Ver `FrameProvider` lá:
 * eles recebem isto por parâmetro pra não arrastar o browser pros testes.
 */
export const frameProvider = {
  stage: (project: Project, t: number) => awaitFrames(project, t),
  frameFor: (project: Project, t: number) => frameFor(project, t),
};

/** Solta tudo — troca de projeto. */
export function releaseFrames(): void {
  for (const p of provedores.values()) p.dispose();
  provedores.clear();
  urls.clear();
}
