/**
 * Mantém as trilhas de som alinhadas ao relógio do player.
 *
 * Duas regras carregam este arquivo, e as duas custaram bug:
 *
 * 1. **Um elemento por arquivo, não por layer.** Cortar um clipe (`splitLayer`)
 *    copia a layer com spread, então as duas metades apontam pro MESMO
 *    `<audio>`/`<video>` — e o acervo faz o mesmo ao reaproveitar um arquivo.
 *    Deixar cada layer conduzir o elemento fazia a metade inativa pausar o que
 *    a ativa tinha acabado de soltar. Ver `soundOwners`, e `ownersByElement`
 *    pro caso em que dois clipes do mesmo arquivo têm elementos diferentes.
 *
 * 2. **Corrige por velocidade, não por seek.** Era o contrário, na premissa de
 *    que mudar a velocidade desafina. Não desafina: `preservesPitch` é o padrão
 *    dos navegadores há anos, e ±4% de andamento com o tom preservado é
 *    inaudível. Já o seek num elemento que está tocando é um corte no som toda
 *    vez — e como cada correção chegava atrasada da própria latência do seek,
 *    ele se repetia. Seek agora é só pra evento (loop, scrub, clipe entrando).
 *
 * A outra diferença pro vídeo: som só existe durante a reprodução. Não há
 * "scrub sonoro" — arrastar o cursor tocando pedacinhos de áudio é ruído, não
 * informação, e nenhum editor faz isso.
 */

import { effectiveGain, isSoundActive, soundLayers, sourceTimeOf } from './audioMix.ts';
import { ownersByElement, ownerChanged } from './mediaOwner.ts';
import type { Layer, SoundLayer } from './types.ts';

/**
 * Deriva a partir da qual vale corrigir.
 *
 * ~45ms é onde o ouvido começa a perceber o som atrasado em relação à imagem
 * (ITU-R BT.1359), e foi o primeiro valor aqui. Mas uma zona morta DE 45ms não
 * garante 45ms de erro — garante que o erro passeia livremente até lá antes de
 * alguém reagir, e medindo deu uma serra entre 0 e -87ms.
 *
 * O limiar do que se ouve é o teto do erro tolerável, não o ponto onde começar
 * a agir. Corrigir bem antes, com o andamento (que não corta nada), é de graça.
 */
const DRIFT_TOLERANCE = 0.02;

/**
 * Desvio a partir do qual a velocidade não alcança mais e só um seek resolve.
 *
 * Era 0,4s, na ideia de que só um evento (loop, scrub, decoder engasgado)
 * justificaria o corte. O que a medição mostrou é que o caso comum já nasce
 * grande: **soltar o `play()` custa latência variável**, e a faixa entrava
 * entre 1 e 157ms atrasada, diferente a cada reprodução. Com o limiar em 0,4s
 * isso caía na correção por andamento, que a 4% leva ~3s pra fechar 120ms — ou
 * seja, o clipe inteiro tocava fora de sincronia, e de um jeito diferente cada
 * vez que você apertava play.
 *
 * Baixo agora pra pouco acima do limiar do que se ouve (~45ms, ITU-R BT.1359),
 * com margem. A troca é deliberada: **um corte curto no primeiro instante é
 * menos ruim que segundos de desencontro**. Abaixo disso continua valendo o
 * andamento, que não corta nada.
 */
const RESYNC_THRESHOLD = 0.09;

/**
 * Teto do ajuste de andamento. 4% com o tom preservado não se percebe nem em
 * música; acima disso a faixa começa a soar apressada, que é trocar um defeito
 * por outro.
 */
const MAX_RATE_TRIM = 0.04;

/** Ganho da correção: 45ms de atraso já saturam o teto acima. */
const RATE_GAIN = 1.0;

/** O que um elemento de som deve fazer neste instante. */
export interface SoundPlan {
  seekTo: number | null;
  play: boolean;
  volume: number;
  /** Andamento — o mecanismo de correção durante a reprodução. */
  rate: number;
}

export interface SoundElementState {
  playing: boolean;
  currentTime: number;
  paused?: boolean;
  seeking?: boolean;
  /** Este elemento acabou de trocar de clipe? Ver `ownerChanged`. */
  switched?: boolean;
}

/**
 * Decide o que fazer com uma trilha — puro, testável sem DOM.
 *
 * Volume sempre é aplicado, mesmo com a trilha parada: você ajusta o volume com
 * o vídeo pausado e espera que valga no play seguinte, sem ter que tocar de novo.
 */
export function soundSyncPlan(
  layer: SoundLayer,
  t: number,
  { playing, currentTime, paused = true, seeking = false, switched = false }: SoundElementState,
): SoundPlan {
  const volume = effectiveGain(layer);
  const silent = { seekTo: null, play: false, volume, rate: 1 };

  // Parado, ou fora do trecho do clipe: silêncio. Não posiciona nada — um seek
  // com o player pausado só gastaria decoder pra ninguém ouvir.
  if (!playing || !isSoundActive(layer, t)) return silent;

  const want = sourceTimeOf(layer, t);
  // O clipe pode ter sido esticado além do arquivo; pedir tempo que não existe
  // deixa o elemento num estado de erro do qual ele não sai sozinho.
  if (want < 0 || want >= layer.sourceDuration) return silent;

  /**
   * Trocou de clipe: isto é um CORTE, e corte se resolve pulando.
   *
   * É o caso do remix — várias fatias do mesmo arquivo em ordem trocada,
   * dividindo um `<audio>` só. O salto entre elas pode ser de poucos
   * milissegundos no arquivo; tratado como deriva, viraria ajuste de andamento,
   * que nunca resolve uma descontinuidade, e a faixa seguia lendo em linha reta.
   */
  if (switched) return { seekTo: want, play: true, volume, rate: 1 };

  // Correção em voo: empilhar outra só multiplica os cortes no som.
  if (seeking) return { seekTo: null, play: true, volume, rate: 1 };

  // Entrando agora: posiciona exato antes de soltar, que é quando o seek não
  // custa nada porque ninguém está ouvindo ainda.
  if (paused) return { seekTo: want, play: true, volume, rate: 1 };

  const error = want - currentTime;          // > 0: o elemento está atrasado
  const drift = Math.abs(error);

  // Perdido de vez: velocidade não alcança mais. Ver RESYNC_THRESHOLD.
  if (drift > RESYNC_THRESHOLD) return { seekTo: want, play: true, volume, rate: 1 };

  if (drift > DRIFT_TOLERANCE) {
    const trim = Math.max(-MAX_RATE_TRIM, Math.min(MAX_RATE_TRIM, error * RATE_GAIN));
    return { seekTo: null, play: true, volume, rate: +(1 + trim).toFixed(3) };
  }

  return { seekTo: null, play: true, volume, rate: 1 };
}

/** O elemento de mídia de uma layer com som. */
export function soundElement(layer: SoundLayer): HTMLMediaElement {
  return layer.type === 'audio' ? layer.audio : layer.video;
}

/** Esta layer deve estar produzindo som audível neste instante? */
function audibleAt(layer: SoundLayer, t: number): boolean {
  if (!isSoundActive(layer, t) || effectiveGain(layer) === 0) return false;
  const want = sourceTimeOf(layer, t);
  return want >= 0 && want < layer.sourceDuration;
}

/**
 * Uma layer por ARQUIVO — a que de fato conduz o elemento neste instante.
 * Ver `ownersByElement` pro porquê da disputa existir; aqui só entra o critério
 * de "em uso", que pra som é estar soando.
 *
 * Sobreposição real de dois clipes do MESMO arquivo continua tocando só um —
 * isso é limite do elemento, não escolha. É o mesmo motivo de o export usar
 * `OfflineAudioContext`, onde cada clipe tem fonte própria.
 */
export function soundOwners(layers: readonly Layer[], t: number): SoundLayer[] {
  return ownersByElement(soundLayers(layers), soundElement, layer => audibleAt(layer, t));
}

/**
 * Prepara um elemento de áudio recém-criado.
 *
 * Diferente do vídeo, aqui NÃO se força `muted` — é o ponto da layer. O preço
 * é que o navegador pode recusar o primeiro `play()` sem gesto do usuário, o
 * que é aceitável porque tocar sempre parte de um clique ou da barra de espaço.
 */
export function attachAudioElement(audio: HTMLAudioElement): HTMLAudioElement {
  audio.preload = 'auto';
  // Explícito porque a correção de deriva depende disso: é o que separa "4% mais
  // rápido" de "meio semitom acima". É o padrão dos navegadores, mas um padrão
  // que a gente assume calado é um padrão que muda sem ninguém perceber.
  audio.preservesPitch = true;
  return audio;
}

export interface SyncSoundOptions {
  /**
   * Também conduzir os elementos de VÍDEO (tocar, pausar, posicionar).
   *
   * Ligado quando a imagem sai do cache de quadros. Nessa situação o `<video>`
   * deixa de ser a fonte da imagem mas continua sendo a fonte do **som**, e
   * ninguém mais está cuidando dele — o loop de desenho nem chega a chamar o
   * `videoSync`. Foi exatamente esse buraco que fazia o pré-render reproduzir
   * mudo.
   *
   * Desligado na reprodução ao vivo, onde o `videoSync` já conduz o elemento
   * com regra mais exigente (a imagem denuncia desvio que o ouvido não pega).
   */
  driveVideo?: boolean;
}

/** Aplica o plano a todas as trilhas do projeto. */
export function syncSoundLayers(
  layers: readonly Layer[],
  t: number,
  playing: boolean,
  { driveVideo = false }: SyncSoundOptions = {},
): void {
  // Uma layer por elemento: ver `soundOwners`.
  for (const layer of soundOwners(layers, t)) {
    const el = soundElement(layer);
    if (!el) continue;

    // Só registra a posse quando de fato conduz o elemento: em reprodução ao
    // vivo quem manda no `<video>` é o `videoSync`, e marcar aqui roubaria dele
    // a troca de clipe.
    const drives = layer.type === 'audio' || driveVideo;

    const plan = soundSyncPlan(layer, t, {
      playing,
      currentTime: el.currentTime,
      paused: el.paused,
      seeking: el.seeking,
      switched: drives && ownerChanged(el, layer.id),
    });

    if (drives) {
      // Trilha em silêncio não precisa rolar: com a imagem vindo do cache, um
      // <video> mudo tocando só gasta decoder pra ninguém.
      const wanted = plan.play && plan.volume > 0;

      if (wanted && plan.seekTo !== null) el.currentTime = plan.seekTo;
      if (el.playbackRate !== plan.rate) el.playbackRate = plan.rate;

      if (wanted && el.paused) {
        el.play().catch(() => { /* autoplay barrado: volta no próximo gesto */ });
      } else if (!wanted && !el.paused) {
        el.pause();
      }
    }

    if (el.volume !== plan.volume) el.volume = plan.volume;
    // `muted` fica sempre falso: o silêncio vem do volume 0 que o plano já
    // resolveu. Dois interruptores pro mesmo efeito só criam estado
    // contraditório — um elemento mudo com volume 1, e ninguém sabe por quê.
    if (el.muted) el.muted = false;
  }
}

/**
 * Cala tudo — usado quando a reprodução para.
 *
 * Zera o andamento junto: a correção de deriva deixa o elemento fora de 1, e
 * quem vier depois (o próximo play, o export) não tem por que herdar o resíduo
 * da reprodução anterior. É o mesmo cuidado que `pauseAllVideo` toma.
 */
export function stopAllSound(layers: readonly Layer[]): void {
  for (const layer of layers) {
    if (layer.type !== 'audio') continue;
    const el = layer.audio;
    if (!el) continue;
    el.playbackRate = 1;
    if (!el.paused) el.pause();
  }
}
