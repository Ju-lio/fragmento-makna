import { player } from './player.ts';
import { clockLayer } from './audioSync.ts';
import { ownersByElement, ownerChanged } from './mediaOwner.ts';
import type { Project, VideoLayer, VideoProbe, VideoTiming } from './types.ts';

/** O que `videoSyncPlan` decide para um único elemento, num único quadro. */
export interface VideoPlan {
  /** Instante do arquivo pra onde saltar, ou null pra não tocar no elemento. */
  seekTo: number | null;
  play: boolean;
  /** Velocidade de reprodução — o mecanismo de correção durante o play. */
  rate: number;
}

/** O estado do elemento que o plano leva em conta. */
export interface VideoElementState {
  playing: boolean;
  currentTime: number;
  paused?: boolean;
  seeking?: boolean;
  /** Este elemento acabou de trocar de clipe? Ver `ownerChanged`. */
  switched?: boolean;
  /** Esta layer é a que dita o relógio da reprodução? Ver `clockLayer`. */
  master?: boolean;
}

/** Só layers de vídeo com elemento carregado — o que a sincronia de fato mexe. */
type LoadedVideoLayer = VideoLayer & { video: HTMLVideoElement };

function videoLayers(project: Project): LoadedVideoLayer[] {
  return project.layers.filter(
    (l): l is LoadedVideoLayer => l.type === 'video' && Boolean(l.video),
  );
}

/**
 * Uma layer por arquivo — a que conduz o `<video>` neste instante.
 *
 * Ver `ownersByElement`: cortar um clipe deixa as duas metades apontando pro
 * mesmo elemento, e deixar as duas escreverem fazia a metade inativa pausar o
 * que a ativa tinha soltado. Na imagem isso aparecia como o clipe piscando ou
 * congelando logo depois de um corte.
 */
export function videoOwners(project: Project, t: number): LoadedVideoLayer[] {
  return ownersByElement(videoLayers(project), l => l.video, layer => isLayerActive(layer, t));
}

/**
 * Keeps every <video> element aligned with the player's clock.
 *
 * Two regimes, because they have opposite requirements:
 *
 *  - PLAYING: let the element run on its own clock e corrige pela VELOCIDADE.
 *    Ver `videoSyncPlan` — durante a reprodução um seek é justamente o que
 *    faz a imagem voltar um quadro e depois pular pra frente.
 *
 *  - PAUSED / SCRUBBING: write `currentTime` directly. Seeking is async, so
 *    the element fires 'seeked' later — that listener repaints the canvas,
 *    otherwise a scrub would leave the previous frame on screen.
 */

/**
 * Desvio a partir do qual vale começar a corrigir.
 *
 * Eram 80ms, herdados de quando corrigir significava **seek**: ali a zona morta
 * larga era o que impedia uma tempestade de cortes na imagem. Com a correção
 * por `playbackRate`, que é contínua e invisível, essa zona morta deixou de
 * comprar alguma coisa e passou a custar: medindo a reprodução, o elemento
 * ficava parado em -36..-47ms de atraso, dentro da faixa e portanto **nunca
 * corrigido**. Isso não incomodava enquanto o som saía do mesmo elemento que a
 * imagem (os dois erravam juntos); com o áudio numa faixa própria, virou
 * desencontro audível entre o que se vê e o que se ouve.
 */
const DRIFT_TOLERANCE = 0.025;

/**
 * Desvio a partir do qual a velocidade não alcança mais e só um seek resolve.
 *
 * Meio segundo não é um número tímido de propósito: nesta faixa não estamos
 * mais falando de deriva, e sim de um evento (o vídeo travou, o loop voltou
 * ao início, você arrastou o cursor durante a reprodução). Aí o corte é o mal
 * menor — abaixo disso ele é o próprio defeito.
 */
const RESYNC_THRESHOLD = 0.5;

/**
 * Teto da correção de velocidade. Acima de ~12% o movimento fica visivelmente
 * acelerado, que é trocar um defeito por outro.
 */
const MAX_RATE_TRIM = 0.12;

/** Ganho da correção: 100ms de atraso viram +10% de velocidade (~1s pra zerar). */
const RATE_GAIN = 1.0;

const SEEK_EPSILON = 0.01;      // below this, a seek costs more than it fixes

/**
 * Quem está no comando dos elementos `<video>` neste momento.
 *
 * Existe um único conjunto de elementos, e mais de um interessado em
 * posicioná-los: o loop do preview (que os leva ao cursor) e o pré-render
 * (que os leva ao instante exato de cada quadro e espera o `seeked`). Se os
 * dois mexerem ao mesmo tempo, o pré-render grava quadros com o vídeo no
 * lugar errado — e a reprodução sai pulando pra frente e voltando.
 *
 * A trava fica aqui, e não em quem chama, pra que um chamador novo não
 * reintroduza o problema por esquecimento.
 */
let owner: object | null = null;

export function claimVideoElements(who: object): void { owner = who; }
export function releaseVideoElements(who: object): void { if (owner === who) owner = null; }
export function videoElementsOwner(): object | null { return owner; }

/** Timeline time -> position inside the source file. */
export function sourceTimeAt(layer: VideoTiming, t: number): number {
  return (layer.trimStart || 0) + (t - layer.start);
}

export function isLayerActive(layer: { start: number; duration: number }, t: number): boolean {
  return t >= layer.start && t <= layer.start + layer.duration;
}

/** Wires an element up so async seeks repaint the preview when parked. */
export function attachVideoElement(video: HTMLVideoElement): HTMLVideoElement {
  /**
   * NÃO entra mudo.
   *
   * Era `muted = true` enquanto o editor não sabia lidar com som — o que
   * significava que o áudio do próprio clipe era descartado em silêncio, e o
   * arquivo exportado saía sem a fala que estava no vídeo. Quem cala agora é o
   * volume da layer, que você controla.
   *
   * O preço: o navegador pode recusar o primeiro `play()` sem gesto do
   * usuário. Aceitável, porque tocar sempre parte de um clique ou da barra de
   * espaço — e o `catch` no `play()` já cobre o caso.
   */
  video.playsInline = true;
  video.preload = 'auto';
  // A correção de deriva daqui mexe no `playbackRate`, e o clipe tem fala
  // dentro. Sem isto, ±12% de velocidade seriam ~2 semitons de desafinação.
  video.preservesPitch = true;

  /**
   * Repintar quando o quadro EXISTIR, não quando o seek disser que acabou.
   *
   * `seeked` sozinho não basta, e o `seekVideoTo` do pré-render já documentava
   * isso: em alguns casos ele dispara antes do `readyState` subir, e desenhar
   * nessa janela pinta **o quadro anterior**. O pré-render se protegia
   * esperando `loadeddata`; aqui não havia proteção nenhuma.
   *
   * O estrago era silencioso e permanente: parado, este era o único repaint
   * agendado. Se ele caísse na janela ruim, a tela ficava com o quadro errado
   * e **nada mais repintava** — você parava em cima de um corte e via o frame
   * de antes dele, sem nenhum sinal de que era mentira. Era o pior caso
   * possível pra quem corta com precisão.
   */
  const repaint = () => { if (!player.playing) player.invalidate(); };
  video.addEventListener('seeked', repaint);
  // Os DOIS eventos, e não só `seeked`: quando ele chega cedo, é o `loadeddata`
  // que marca o quadro existindo de verdade. Cobre também a primeira carga do
  // arquivo, em que não houve seek nenhum pra disparar o repaint.
  video.addEventListener('loadeddata', repaint);
  return video;
}

/**
 * Todo `<video>` que aparece em `t` já pousou no quadro pedido?
 *
 * É a pergunta que separa uma composição fiel de uma composição plausível.
 * Enquanto a resposta for não, o que está dentro do elemento é o quadro
 * ANTERIOR, e compor com ele produz uma imagem que o export nunca vai gerar.
 *
 * O teste é `seeking` + `readyState`, e **não** comparar `currentTime` com o
 * instante pedido — essa comparação parece mais rigorosa e é uma armadilha. O
 * navegador pousa no quadro decodificável mais próximo, não no valor exato:
 * pedir 5,000 num arquivo a 29,97fps deixa o `currentTime` em 4,9967 pra
 * sempre. Como condição de repintar, isso nunca ficaria satisfeito e a tela
 * congelaria de vez. É pelo mesmo motivo que o `seekVideoTo` do pré-render usa
 * essa comparação só como atalho de saída, e espera o EVENTO no caso geral.
 *
 * `readyState >= 2` (HAVE_CURRENT_DATA) é a régua do pré-render, não uma mais
 * frouxa: o preview não pode aceitar como pronto um quadro que o export
 * esperaria.
 */
export function videosParkedAt(project: Project, t: number): boolean {
  for (const layer of videoOwners(project, t)) {
    if (!isLayerActive(layer, t)) continue;
    const v: VideoProbe = layer.video;
    // Arquivo quebrado: não vem quadro nenhum, nunca. Esperar por ele deixaria
    // o palco em branco pra sempre — inclusive os títulos por cima, que não têm
    // nada a ver com o vídeo que falhou. Melhor compor sem ele e seguir.
    if (v.error) continue;
    if (v.seeking || v.readyState < 2) return false;
  }
  return true;
}

/**
 * Decides what a single video element should do — pure, so it can be tested
 * without a DOM. `syncVideoLayers` below is the thin part that carries it out.
 *
 * A regra central: **com o elemento rolando, nunca corrija por seek.**
 *
 * Um seek num `<video>` que está tocando não é instantâneo, e o elemento não
 * congela esperando: ele continua avançando no próprio relógio até o seek
 * pousar. Então corrigir uma deriva de 80ms desenha, em sequência, o quadro
 * onde o elemento já tinha chegado, o quadro do seek (que está ATRÁS dele) e
 * o quadro seguinte — a imagem volta um e pula dois. Pior: cada seek custa
 * decoder, o que aumenta a deriva, que dispara o próximo seek.
 *
 * A saída é corrigir por `playbackRate`, que é contínuo e sem latência: o
 * elemento anda um pouco mais rápido (ou mais devagar) até encostar no
 * relógio, sem nunca desenhar um quadro fora de ordem.
 *
 * Returns { seekTo: number|null, play: boolean, rate: number }.
 */
export function videoSyncPlan(
  layer: VideoTiming,
  t: number,
  { playing, currentTime, paused = true, seeking = false, switched = false, master = false }: VideoElementState,
): VideoPlan {
  if (!isLayerActive(layer, t)) return { seekTo: null, play: false, rate: 1 };

  const want = clampToSource(layer, sourceTimeAt(layer, t));
  const error = want - currentTime;          // > 0: o elemento está atrasado
  const drift = Math.abs(error);

  // Parado: pousa exatamente no quadro, ignorando o que não dá pra ver.
  if (!playing) return { seekTo: drift > SEEK_EPSILON ? want : null, play: false, rate: 1 };

  /**
   * Trocou de clipe: isto é um CORTE, e corte se resolve pulando.
   *
   * Vem ANTES do `seeking` de propósito — um seek em voo mirava o clipe
   * anterior, e insistir nele deixaria o elemento no lugar errado. E vem antes
   * da deriva porque um remix pode saltar poucos milissegundos no arquivo: como
   * "deriva" isso viraria ajuste de velocidade, que nunca resolve uma
   * descontinuidade.
   */
  if (switched) return { seekTo: drift > SEEK_EPSILON ? want : null, play: true, rate: 1 };

  // Já tem correção em voo. Empilhar outra só afunda mais o decoder — e é
  // assim que uma correção isolada vira tempestade de seeks.
  if (seeking) return { seekTo: null, play: true, rate: 1 };

  // Ainda parado, prestes a entrar: aqui o seek é invisível, porque não há
  // movimento na tela pra ele interromper. É o único momento da reprodução em
  // que vale posicionar exato — e é justamente o que evita começar torto.
  if (paused) return { seekTo: drift > SEEK_EPSILON ? want : null, play: true, rate: 1 };

  /**
   * É a trilha deste clipe que dita o relógio: não se corrige contra si mesma.
   *
   * Acontece quando o som que está tocando é o do próprio vídeo. `t` é derivado
   * do `currentTime` DESTE elemento, então "corrigir" aqui seria perseguir o
   * arredondamento da grade de quadros e frear a reprodução inteira. Mesma
   * razão detalhada em `soundSyncPlan`.
   */
  if (master) return { seekTo: null, play: true, rate: 1 };

  // Rolando e perdido de vez: velocidade não alcança mais. Ver RESYNC_THRESHOLD.
  if (drift > RESYNC_THRESHOLD) return { seekTo: want, play: true, rate: 1 };

  if (drift > DRIFT_TOLERANCE) {
    const trim = Math.max(-MAX_RATE_TRIM, Math.min(MAX_RATE_TRIM, error * RATE_GAIN));
    return { seekTo: null, play: true, rate: +(1 + trim).toFixed(3) };
  }

  return { seekTo: null, play: true, rate: 1 };
}

export function syncVideoLayers(project: Project, t: number): void {
  // Outro dono está posicionando os elementos: não disputa.
  if (owner !== null) return;

  // Quem dita o relógio pode ser o som DESTE vídeo — ver o caso `master` no
  // plano. Eleito uma vez, fora do laço: a resposta é a mesma pra todos.
  const master = player.playing ? clockLayer(project.layers, t) : null;

  // Uma layer por elemento: ver `videoOwners`.
  for (const layer of videoOwners(project, t)) {
    const video = layer.video;
    const plan = videoSyncPlan(layer, t, {
      playing: player.playing,
      currentTime: video.currentTime,
      paused: video.paused,
      seeking: video.seeking,
      switched: ownerChanged(video, layer.id),
      master: master !== null && master.type === 'video' && master.id === layer.id,
    });

    if (plan.seekTo !== null) video.currentTime = plan.seekTo;
    if (video.playbackRate !== plan.rate) video.playbackRate = plan.rate;

    if (plan.play && video.paused) {
      video.play().catch(() => { /* autoplay blocked; preview keeps stepping frames */ });
    } else if (!plan.play && !video.paused) {
      video.pause();
    }
  }
}

export interface BusyState {
  busy: boolean;
  /** Rótulo pra UI, ou null quando nada está pendente. */
  reason: string | null;
}

/**
 * O preview está esperando alguma layer de vídeo ficar pronta?
 *
 * ⚠️ **SEM USO desde que a imagem saiu do `<video>`.** Quem responde isso hoje
 * é `framesReadyAt`, no `videoFrames.ts` — ver o `onTick` do `Stage`. Esta
 * versão mede o elemento, que só toca som e é buscado a cada corte: ela
 * acendia a barra em toda emenda com a imagem perfeita, e ficava apagada
 * quando o decodificador de quadros é que estava atrasado.
 *
 * Fica aqui, junto com `syncVideoLayers` e `videosParkedAt` — também sem
 * chamador —, pra sair de uma vez na limpeza deste arquivo. Não volte a
 * chamá-la.
 *
 * Dois casos distintos, ambos percebidos como "travou":
 *  - `seeking`: você arrastou o cursor do tempo e o decoder ainda está
 *    remontando aquele frame (num H.264, isso significa decodificar desde o
 *    keyframe anterior — pode ser meio segundo de trabalho).
 *  - `readyState < HAVE_CURRENT_DATA`: o arquivo ainda nem tem frame pra
 *    mostrar naquele ponto.
 *
 * Só olha layers ativas no instante `t` — vídeo fora da faixa atual pode
 * estar buffering à vontade que não afeta o que você está vendo.
 */
export function previewBusyState(project: Project, t: number): BusyState {
  for (const layer of videoLayers(project)) {
    if (!isLayerActive(layer, t)) continue;

    const v: VideoProbe = layer.video;
    if (v.seeking) return { busy: true, reason: 'decodificando' };
    if (v.readyState < 2) return { busy: true, reason: 'carregando' };
  }
  return { busy: false, reason: null };
}

/** Existe alguma layer de vídeo aparecendo neste instante? */
export function hasActiveVideo(project: Project, t: number): boolean {
  return videoLayers(project).some(layer => isLayerActive(layer, t));
}

/**
 * Pauses everything — used when the whole project stops.
 *
 * Também zera a velocidade: a correção de deriva deixa o elemento num rate
 * ligeiramente fora de 1, e quem vier depois (scrub, pré-render, o próximo
 * play) não tem por que herdar o resíduo da reprodução anterior.
 */
export function pauseAllVideo(project: Project): void {
  for (const layer of videoLayers(project)) {
    layer.video.playbackRate = 1;
    if (!layer.video.paused) layer.video.pause();
  }
}

function clampToSource(layer: VideoTiming, time: number): number {
  const max = Number.isFinite(layer.sourceDuration) ? (layer.sourceDuration as number) : time;
  return Math.max(0, Math.min(time, max));
}
