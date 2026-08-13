/**
 * Mantém as trilhas de som alinhadas ao relógio do player.
 *
 * Parece o `videoSync`, mas a correção de deriva é o **oposto** — e de
 * propósito. Lá, corrigir por seek fazia a imagem voltar um quadro, e a saída
 * foi ajustar `playbackRate`. Aqui isso seria pior: mudar a velocidade de uma
 * faixa muda o tom dela, e meio semitom de desafinação é muito mais audível
 * que um quadro repetido é visível. Então som corrige por **seek**, com uma
 * tolerância folgada — o pulo de um seek de áudio é um clique curto, e abaixo
 * de ~150ms a deriva não se percebe.
 *
 * A outra diferença: som só existe durante a reprodução. Não há "scrub
 * sonoro" — arrastar o cursor tocando pedacinhos de áudio é ruído, não
 * informação, e nenhum editor faz isso.
 */

import { effectiveGain, isSoundActive, sourceTimeOf } from './audioMix.ts';
import type { Layer, SoundLayer } from './types.ts';

/**
 * Deriva tolerada antes de corrigir. Bem mais folgada que a do vídeo: cada
 * correção é um clique audível, então corrigir demais é pior que derivar um
 * pouco.
 */
const DRIFT_TOLERANCE = 0.15;

/** O que um elemento de som deve fazer neste instante. */
export interface SoundPlan {
  seekTo: number | null;
  play: boolean;
  volume: number;
}

export interface SoundElementState {
  playing: boolean;
  currentTime: number;
  paused?: boolean;
  seeking?: boolean;
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
  { playing, currentTime, paused = true, seeking = false }: SoundElementState,
): SoundPlan {
  const volume = effectiveGain(layer);

  // Parado, ou fora do trecho do clipe: silêncio. Não posiciona nada — um seek
  // com o player pausado só gastaria decoder pra ninguém ouvir.
  if (!playing || !isSoundActive(layer, t)) return { seekTo: null, play: false, volume };

  const want = sourceTimeOf(layer, t);
  // O clipe pode ter sido esticado além do arquivo; pedir tempo que não existe
  // deixa o elemento num estado de erro do qual ele não sai sozinho.
  if (want < 0 || want >= layer.sourceDuration) return { seekTo: null, play: false, volume };

  // Correção em voo: empilhar outra só multiplica os cliques.
  if (seeking) return { seekTo: null, play: true, volume };

  // Entrando agora: posiciona exato antes de soltar, que é quando o seek não
  // custa nada porque ninguém está ouvindo ainda.
  if (paused) return { seekTo: want, play: true, volume };

  const drift = Math.abs(currentTime - want);
  return { seekTo: drift > DRIFT_TOLERANCE ? want : null, play: true, volume };
}

/** O elemento de mídia de uma layer com som. */
export function soundElement(layer: SoundLayer): HTMLMediaElement {
  return layer.type === 'audio' ? layer.audio : layer.video;
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
  return audio;
}

/** Aplica o plano a todas as trilhas do projeto. */
export function syncSoundLayers(layers: readonly Layer[], t: number, playing: boolean): void {
  for (const layer of layers) {
    if (layer.type !== 'audio' && layer.type !== 'video') continue;

    const el = soundElement(layer);
    if (!el) continue;

    const plan = soundSyncPlan(layer, t, {
      playing,
      currentTime: el.currentTime,
      paused: el.paused,
      seeking: el.seeking,
    });

    // Vídeo é posicionado pelo `videoSync`, que tem regra própria (e mais
    // exigente, porque a imagem denuncia). Aqui só o som dele é tocado.
    if (layer.type === 'audio') {
      if (plan.seekTo !== null) el.currentTime = plan.seekTo;
      if (plan.play && el.paused) {
        el.play().catch(() => { /* autoplay barrado: volta no próximo gesto */ });
      } else if (!plan.play && !el.paused) {
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

/** Cala tudo — usado quando a reprodução para. */
export function stopAllSound(layers: readonly Layer[]): void {
  for (const layer of layers) {
    if (layer.type !== 'audio') continue;
    const el = layer.audio;
    if (el && !el.paused) el.pause();
  }
}
