import { frameIndexAt, timeAtFrameIndex } from './frameCache.ts';

/**
 * O cache de quadros compostos alimenta o preview?
 *
 * **Desligado durante a estabilização do motor de vídeo.** Ligar de volta é
 * trocar este `false` por `true` — nada mais foi removido.
 *
 * ## Por que sai do caminho agora
 *
 * Duas razões, e a segunda é a séria.
 *
 * 1. É uma SEGUNDA fonte de imagem. Enquanto o preview puder mostrar pixel
 *    vindo do cache, olhar a tela não diz nada sobre o decodificador — um
 *    quadro guardado esconde defeito do decodificador, e um quadro guardado
 *    errado se parece com defeito do decodificador. Verificar o motor com ele
 *    ligado é verificar entrega, não conteúdo.
 *
 * 2. O cache guarda quadros **em que o vídeo não foi desenhado**. `drawFrame`
 *    marca `degraded` por dois motivos que não têm nada a ver um com o outro:
 *    o desfoque foi pulado (aproximação cosmética, ótima durante a reprodução)
 *    ou `drawVideo` devolveu `false` porque o quadro não chegou — e aí o que
 *    foi guardado é uma composição SEM o clipe. Como `allowDegraded` é
 *    `player.playing`, esse quadro é aceito de volta justamente reproduzindo.
 *    Na troca de clipe é quando o quadro costuma não estar pronto, então a
 *    piscada cai sempre na emenda.
 *
 * O (2) é defeito de verdade e tem conserto: separar "aproximado" de
 * "incompleto" em duas etiquetas, e nunca servir a segunda. Fica pra depois do
 * motor estar de pé — misturar as duas correções é o erro de método que já
 * custou uma sessão aqui.
 *
 * A assinatura do cache (`signatureOf`) captura o PROJETO, não a versão do
 * motor. Numa fase em que o motor muda a cada etapa, um cache cheio pelo código
 * antigo continua parecendo válido — mais um motivo pra ele ficar fora agora.
 */
export const PREVIEW_CACHE_ENABLED = false;

export interface FrameSourceInput {
  /** Tempo bruto do relógio (rAF). */
  rawT: number;
  /** Taxa de quadros da composição. */
  fps: number;
  playing: boolean;
  /** Esta reprodução foi iniciada a partir do cache. */
  fromCache: boolean;
  hasCached: (index: number) => boolean;
  /**
   * O cache pode servir de fonte? Ver `PREVIEW_CACHE_ENABLED`, de onde vem o
   * padrão. Injetável pra que as regras de origem continuem sendo exercidas
   * pelos testes enquanto o interruptor está desligado — apagá-los enquanto o
   * cache dorme seria perder justamente o que garante que ele volta certo.
   */
  cacheEnabled?: boolean;
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
  { rawT, fps, playing, fromCache, hasCached, cacheEnabled = PREVIEW_CACHE_ENABLED }: FrameSourceInput,
): FrameChoice {
  const index = frameIndexAt(rawT, fps);
  const t = timeAtFrameIndex(index, fps);

  // Reproduzindo, ou tudo sai do cache ou nada sai: alternar as duas origens
  // quadro a quadro faz a imagem pular pra frente e voltar, porque o quadro ao
  // vivo mostra o <video> onde ele estiver, não no instante exato da grade.
  const mayUseCache = cacheEnabled && (!playing || fromCache);

  return { index, t, useCache: mayUseCache && hasCached(index) };
}
