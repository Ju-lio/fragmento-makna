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
 * dinâmico — ver `videoDemuxer.ts` — ou seja, só quando um vídeo é de fato
 * aberto.
 *
 * ## Um decodificador por CLIPE
 *
 * A chave do registro é o `id` da LAYER, e não o `mediaId`. O porquê, e o que
 * decorre disso (armar antes do corte, prender o lookahead ao clipe, fechar o
 * mais antigo), está em `framePlan.ts` — aqui fica só a parte que toca o
 * navegador.
 */

import { createVideoFrameProvider } from '@elah/core';
import type { DemuxerFactory } from '@elah/core';
import {
  framePlanAt, frameServes, highWaterAfterAim, providersToDrop, sourceFrameOf,
  MARCA_DESCONHECIDA,
} from './framePlan.ts';
import { coversAt } from './timeSpan.ts';
import type { FrameTarget, PlanLimits, VideoClip } from './framePlan.ts';
import type { Project, VideoLayer } from './types.ts';

export { sourceFrameOf, sourceTimeOf } from './framePlan.ts';

/**
 * Quanto cada decodificador pode adiantar, com que antecedência um clipe é
 * armado, e quantos podem existir ao mesmo tempo.
 *
 * O teto de vivos é o número que impede a correção de virar outro defeito: sem
 * ele, um remix de vinte fatias abriria vinte decodificadores — vinte
 * `VideoDecoder`, vinte demuxers e vinte caches de quadro — pra mostrar quatro
 * segundos de linha do tempo. Oito cobre o clipe na tela, os que o `PRE_ARM`
 * está preparando e uma margem pra voltar atrás sem reabrir nada.
 */
const LIMITES: PlanLimits = { lookahead: 12, minLookahead: 4, preArm: 0.6 };
const MAX_VIVOS = 8;

/** O que `getCurrent` devolve: os dois desenham com `ctx.drawImage`. */
export type DecodedFrame = VideoFrame | ImageBitmap;

interface Provider {
  getCurrent(sourceFrame: number): DecodedFrame | null;
  setPlayhead(sourceFrame: number, opts?: { lookaheadFrames?: number }): void;
  markIdle(): void;
  markActive(): void;
  dispose(): void;
  /**
   * Fora da interface publicada pelo `@elah/core`, mas presente em todos os
   * provedores dele: é o que avisa que o tempo de ociosidade acabou. Opcional
   * no tipo de propósito — sem ele o teto de vivos ainda segura a memória.
   */
  setIdleCallback?(cb: (() => void) | null): void;
}

/** Um decodificador aberto, mais o que a política precisa saber sobre ele. */
interface Vivo {
  provider: Provider;
  /** De qual arquivo ele lê. Trocar a mídia da layer invalida o decodificador. */
  mediaId: string;
  /** Está marcado como ativo no `@elah/core`? Ver `idleUnused`. */
  ativo: boolean;
  /** Ordem do último uso, pra escolher quem fecha primeiro. */
  usadoEm: number;
  /**
   * Maior índice que ESTE decodificador já entregou **desde o último salto pra
   * trás**.
   *
   * É o que responde "o quadro exato ainda vem?" — ver `frameServes`. O
   * `@elah/core` não publica esse número; sabemos dele porque todo quadro passa
   * pelo nosso `frameConverter` antes de entrar no cache.
   *
   * O "desde o último salto" não é detalhe: ver `highWaterAfterAim`.
   */
  maiorEntregue: number;
  /** Último quadro mirado, pra saber quando o cursor andou pra TRÁS. */
  ultimoAlvo: number;
  /**
   * Sobe a cada salto pra trás. Uma conversão que começou antes do salto não
   * pode levantar a marca depois dele — ela descreve o trecho que acabou de ser
   * abandonado, e reerguer a marca reabriria o vizinho justamente no gesto que
   * esta correção veio proteger.
   */
  geracao: number;
}

/** Chave: `id` da layer. Ver `framePlan.ts`. */
const provedores = new Map<number, Vivo>();
const urls = new Map<string, string>();

/**
 * De qual índice é cada bitmap que sai do conversor.
 *
 * `WeakMap` porque a vida do bitmap é do `@elah/core`: quando ele evicta e
 * fecha, a entrada some junto, sem ninguém precisar lembrar de limpar.
 */
const indiceDoQuadro = new WeakMap<ImageBitmap, number>();

/** Relógio de USO, não de parede: só a ordem importa. */
let uso = 0;

// --- o demuxer, sob demanda ---------------------------------------------

let fabrica: DemuxerFactory | null = null;
let carregando: Promise<void> | null = null;

/**
 * A fábrica de demuxers, ou `null` enquanto ela ainda está vindo pela rede.
 *
 * Devolver `null` não é falha: é o mesmo contrato de "o quadro ainda não
 * chegou" que o resto do arquivo já tem. O preview segura a imagem por alguns
 * quadros, o `awaitFrames` continua tentando, e o primeiro `aimAt` depois que o
 * módulo pousa abre os decodificadores.
 *
 * O `import()` fica aqui — no primeiro clipe de vídeo que de fato pede quadro —
 * e não no `registerSource`, que também roda pra imagem e som: um projeto sem
 * vídeo nenhum não tem por que baixar um demuxer.
 */
function demuxerFactory(): DemuxerFactory | null {
  if (fabrica) return fabrica;
  carregando ??= import('./videoDemuxer.ts')
    .then(m => { fabrica = m.demuxerFactory; })
    .catch(err => {
      console.warn('[videoFrames] demuxer não pôde ser carregado:', err);
      // Zera pra que a próxima tentativa não fique presa numa promessa morta.
      carregando = null;
    });
  return null;
}

/**
 * Diz de onde ler os bytes de uma mídia. Chamado onde a `blob:` URL nasce.
 *
 * Guardar a URL em vez do `Blob` é de propósito: é o que o provedor aceita, e
 * o `mediaStore` já mantém uma URL estável por arquivo — criar outra vazaria
 * uma cópia por chamada.
 */
export function registerSource(mediaId: string, url: string): void {
  if (urls.get(mediaId) === url) return;
  // Trocou de fonte: todo decodificador aberto sobre ela lê bytes que não
  // valem mais — e agora são vários, um por clipe.
  for (const [id, vivo] of [...provedores]) {
    if (vivo.mediaId === mediaId) fechar(id);
  }
  urls.set(mediaId, url);
}

function fechar(id: number): void {
  provedores.get(id)?.provider.dispose();
  provedores.delete(id);
}

/**
 * O decodificador deste clipe, aberto agora se ainda não existir.
 *
 * Devolve o `Vivo`, e não só o provedor: quem chama precisa da marca d'água e
 * do último alvo pra saber se o cursor andou pra trás. Ver `highWaterAfterAim`.
 */
function provedorDe(alvo: FrameTarget, fps: number): Vivo | null {
  const existente = provedores.get(alvo.id);
  if (existente) {
    // A layer trocou de mídia sem trocar de id (o `mediaId` é editável). O
    // decodificador antigo aponta pro arquivo errado.
    if (existente.mediaId === alvo.mediaId) {
      existente.usadoEm = ++uso;
      return existente;
    }
    fechar(alvo.id);
  }

  const url = urls.get(alvo.mediaId);
  if (!url) return null;

  const factory = demuxerFactory();
  if (!factory) return null;

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
  // Preenchido logo abaixo; o conversor precisa dele antes de existir provedor.
  const vivo = {
    mediaId: alvo.mediaId, ativo: true, usadoEm: ++uso,
    maiorEntregue: MARCA_DESCONHECIDA, ultimoAlvo: alvo.sourceFrame, geracao: 0,
  } as Vivo;

  const p = createVideoFrameProvider(url, {
    fps,
    lookaheadFrames: LIMITES.lookahead,
    demuxerFactory: factory,
    /**
     * SEM `flipY`. O conversor padrão do `@elah/core` inverte o Y porque o
     * renderer deles é WebGL, onde a textura tem a origem embaixo. O nosso é
     * Canvas 2D, cuja origem já é em cima — herdar a inversão põe o vídeo de
     * cabeça pra baixo, e foi o que aconteceu.
     *
     * É também por onde sabemos QUAL quadro é cada bitmap. O `getCurrent` do
     * `@elah/core` pode devolver um vizinho, e a única identificação confiável
     * é o `timestamp` do `VideoFrame` — lido antes do `await`, porque quem
     * fecha o quadro é o `@elah/core`, assim que este conversor termina.
     */
    frameConverter: async (frame: VideoFrame) => {
      const indice = Math.round((frame.timestamp / 1e6) * fps);
      // Lida ANTES do await: é a geração em que este quadro foi produzido.
      const geracao = vivo.geracao;
      const bitmap = await createImageBitmap(frame);
      indiceDoQuadro.set(bitmap, indice);
      // O índice do bitmap vale sempre; a MARCA, só se o cursor não saltou pra
      // trás no meio da conversão. Ver `geracao`.
      if (geracao === vivo.geracao && indice > vivo.maiorEntregue) {
        vivo.maiorEntregue = indice;
      }
      return bitmap;
    },
  }) as Provider;

  vivo.provider = p;
  provedores.set(alvo.id, vivo);

  /**
   * Ocioso por tempo demais: fecha sozinho.
   *
   * É o par do teto de vivos, e cobre o caso que o teto não cobre — poucos
   * clipes, muito tempo parado. Sem isto, sair do vídeo e ficar meia hora
   * editando um título mantinha decodificador e cache de quadros abertos.
   *
   * A checagem de identidade importa: entre o `markIdle` e o disparo, a mesma
   * layer pode ter reaberto um decodificador novo (trocou de mídia, por
   * exemplo), e fechar por id fecharia o novo.
   */
  p.setIdleCallback?.(() => {
    if (provedores.get(alvo.id) === vivo) fechar(alvo.id);
  });

  return vivo;
}

/**
 * Aperta o teto de quadros guardados por ESTE decodificador.
 *
 * ## Por que precisa existir, e por que é feio
 *
 * O `createVideoFrameProvider` não repassa `maxFrames`: todo provedor nasce
 * guardando até **30 quadros**. Trinta é um teto sensato pra um decodificador
 * e é demais pra oito — a 1080p um `ImageBitmap` custa ~8 MB, então oito
 * decodificadores cheios seriam ~2 GB. Trocar o engasgo por isso é trocar um
 * defeito por outro.
 *
 * E o cache **enche mesmo** quando não devia: pra mostrar o quadro 51, o
 * decodificador precisa começar no keyframe anterior e decodificar tudo no
 * caminho — cinquenta quadros que ninguém vai ver entram no cache antes do
 * primeiro que interessa. Medido no traço do `@elah/core`: `cacheSize: 30` com
 * o alvo ainda a vinte quadros de distância.
 *
 * Prender o pedido ao tamanho do clipe (ver `framePlan.ts`) não resolve isso:
 * limita o que se PEDE, não o que a subida até o keyframe deixa pelo caminho.
 *
 * Daí mexer num campo privado de dependência, que é feio e é assumido: o teto é
 * a única peça do ciclo de vida que a API publicada não alcança. Falha em
 * segurança — se a estrutura interna mudar, volta a valer o 30 do `@elah/core` —
 * e AVISA, porque o modo de falha desta fase foi justamente uma degradação
 * silenciosa que passou por duas verificações.
 */
let avisouDoTeto = false;

function apertarTeto(p: Provider, quadros: number): void {
  const cache = (p as unknown as { _cache?: { _maxFrames?: number } })._cache;
  if (!cache || typeof cache._maxFrames !== 'number') {
    if (!avisouDoTeto) {
      avisouDoTeto = true;
      console.warn(
        '[videoFrames] o cache do @elah/core mudou de forma: cada decodificador ' +
        'volta a guardar 30 quadros. Ver apertarTeto().',
      );
    }
    return;
  }
  cache._maxFrames = quadros;
}

/**
 * Folga de quadros guardados ATRÁS do pedido.
 *
 * Não é enfeite: o `getCurrent` do `@elah/core` aceita um quadro até dois atrás
 * do pedido, e voltar alguns quadros no cursor é o gesto mais comum que existe
 * num editor. Zerar a folga faria cada passo pra trás redecodificar desde o
 * keyframe.
 */
const FOLGA_ATRAS = 6;

/** Só o que o plano precisa ler das layers. */
function clipesDe(project: Project): VideoClip[] {
  return project.layers.filter((l): l is VideoLayer => l.type === 'video');
}

/**
 * Avisa onde o cursor está, pra decodificação correr à frente.
 *
 * Barato e idempotente: pode (e deve) ser chamado a cada quadro. É o que
 * transforma "decodifica quando pedirem" em "já estava pronto".
 *
 * Arma e SOLTA na mesma passada. Separar as duas metades em duas chamadas foi
 * o que fez o `idleUnused` existir escrito e nunca ser chamado: quem arma é o
 * laço do preview, quem exporta é outro caminho, e a metade que solta ficou
 * sem dono. Aqui não há como esquecer.
 */
export function aimAt(project: Project, t: number): void {
  const fps = project.fps;
  const plano = framePlanAt(clipesDe(project), t, fps, LIMITES);

  for (const alvo of plano) {
    const vivo = provedorDe(alvo, fps);
    if (!vivo) continue;

    /**
     * Voltar invalida o que sabíamos sobre a entrega — ver `highWaterAfterAim`.
     * A geração sobe junto porque as conversões que já estavam em voo descrevem
     * o trecho abandonado, e deixá-las reerguer a marca reabriria o vizinho.
     */
    if (alvo.sourceFrame < vivo.ultimoAlvo) vivo.geracao++;
    vivo.maiorEntregue = highWaterAfterAim(
      vivo.ultimoAlvo, alvo.sourceFrame, vivo.maiorEntregue,
    );
    vivo.ultimoAlvo = alvo.sourceFrame;

    // O teto acompanha o clipe: uma fatia de 0,2s não guarda o mesmo que um
    // clipe inteiro. Reaplicado a cada quadro porque arrastar a borda do clipe
    // muda o tamanho dele — e é barato, é uma atribuição.
    apertarTeto(vivo.provider, alvo.lookahead + FOLGA_ATRAS);
    vivo.provider.setPlayhead(alvo.sourceFrame, { lookaheadFrames: alvo.lookahead });
  }

  soltar(project, plano);
}

/**
 * O quadro de uma layer neste instante, se já estiver decodificado.
 *
 * Síncrono e sem efeito colateral de espera: é chamado de dentro do desenho, e
 * `drawFrame` é função pura de (projeto, tempo, quadros) — não pode aguardar
 * nada. Devolver o quadro vizinho quando o certo não chegou seria repetir, com
 * outro mecanismo, o defeito do `<video>`.
 *
 * Só CONSULTA: quem abre decodificador é o `aimAt`. Abrir um aqui adiantaria
 * nada (o quadro não estaria pronto neste instante mesmo) e escondia a conta —
 * um desenho avulso, como o "salvar PNG", passaria a abrir arquivos.
 */
export function frameFor(project: Project, t: number) {
  const fps = project.fps;
  return (layer: VideoLayer): DecodedFrame | null => {
    const vivo = provedores.get(layer.id);
    if (!vivo || vivo.mediaId !== layer.mediaId) return null;

    const pedido = sourceFrameOf(layer, t, fps);
    const quadro = vivo.provider.getCurrent(pedido);
    if (!quadro) return null;

    /**
     * Conferir QUAL quadro veio, e não só que veio um. Ver `frameServes`: o
     * `getCurrent` do `@elah/core` entrega um vizinho de até dois atrás quando
     * o exato ainda não está no cache, e foi assim que o export gravou quadro
     * repetido no arquivo final.
     */
    const entregue = indiceDoQuadro.get(quadro as ImageBitmap);
    if (entregue === undefined && !avisouDoIndice) {
      avisouDoIndice = true;
      console.warn(
        '[videoFrames] quadro sem índice conhecido: o conversor do @elah/core ' +
        'deixou de passar por aqui, e o quadro vizinho volta a ser aceito.',
      );
    }
    return frameServes(pedido, entregue, vivo.maiorEntregue) ? quadro : null;
  };
}

let avisouDoIndice = false;

/** As layers de vídeo que aparecem neste instante. Ver `timeSpan.ts`. */
function visiveisEm(project: Project, t: number): VideoLayer[] {
  return project.layers.filter(
    (l): l is VideoLayer => l.type === 'video' && coversAt(l, t),
  );
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

/**
 * Solta o decodificador de quem não está sendo usado agora.
 *
 * Exportado pra ser testável e pra quem quiser soltar sem armar; o caminho
 * normal é o `aimAt`, que já faz as duas coisas.
 */
export function idleUnused(project: Project, t: number): void {
  soltar(project, framePlanAt(clipesDe(project), t, project.fps, LIMITES));
}

function soltar(project: Project, plano: readonly FrameTarget[]): void {
  const emUso = new Set(plano.map(a => a.id));

  /**
   * `markIdle` só na TRANSIÇÃO, nunca a cada quadro.
   *
   * O `markIdle` do `@elah/core` reinicia o cronômetro de ociosidade a cada
   * chamada. Chamado 60 vezes por segundo, ele adia o próprio disparo pra
   * sempre: o decodificador ficaria marcado como ocioso e não fecharia nunca —
   * um vazamento que se pareceria exatamente com "o idleUnused está ligado".
   */
  for (const [id, vivo] of provedores) {
    const querido = emUso.has(id);
    if (querido === vivo.ativo) continue;
    if (querido) vivo.provider.markActive();
    else vivo.provider.markIdle();
    vivo.ativo = querido;
  }

  const existentes = new Set(clipesDe(project).map(c => c.id));
  const vivos = [...provedores].map(([id, v]) => ({ id, usedAt: v.usadoEm }));
  for (const id of providersToDrop(vivos, { keep: emUso, existing: existentes, max: MAX_VIVOS })) {
    fechar(id);
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
  for (const vivo of provedores.values()) vivo.provider.dispose();
  provedores.clear();
  urls.clear();
}
