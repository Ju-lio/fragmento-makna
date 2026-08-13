import { frameIndexAt, timeAtFrameIndex } from './frameCache.ts';

export interface FrameSourceInput {
  /** Tempo bruto do relógio (rAF). */
  rawT: number;
  /** Taxa de quadros da composição. */
  fps: number;
  playing: boolean;
  /** Esta reprodução foi iniciada a partir do cache. */
  fromCache: boolean;
  hasCached: (index: number) => boolean;
}

export interface FrameChoice {
  index: number;
  /** Instante da GRADE, não o bruto — ver o comentário abaixo. */
  t: number;
  useCache: boolean;
}

/**
 * Decide, para um instante do relógio, QUAL quadro mostrar e DE ONDE tirá-lo.
 *
 * Vive aqui, fora do componente, porque é a regra que determina se o preview
 * anda pra frente de forma estável — e por isso precisa ser testável sem
 * navegador. Não desenha nada: só devolve a decisão.
 *
 */
export function pickFrameSource(
  { rawT, fps, playing, fromCache, hasCached }: FrameSourceInput,
): FrameChoice {
  const index = frameIndexAt(rawT, fps);
  const t = timeAtFrameIndex(index, fps);

  // Reproduzindo, ou tudo sai do cache ou nada sai: alternar as duas origens
  // quadro a quadro faz a imagem pular pra frente e voltar, porque o quadro ao
  // vivo mostra o <video> onde ele estiver, não no instante exato da grade.
  const mayUseCache = !playing || fromCache;

  return { index, t, useCache: mayUseCache && hasCached(index) };
}
