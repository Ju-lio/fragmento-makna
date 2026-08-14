/**
 * O modelo de domínio, num arquivo só de tipos.
 *
 * Fica separado de propósito: `effects.ts` precisa saber o que é uma Layer e
 * `project.ts` precisa saber o que é um Effect. Com as duas definições aqui,
 * os dois lados se referenciam sem ninguém importar o runtime do outro — e o
 * arquivo desaparece inteiro na compilação, então não existe ciclo em tempo
 * de execução pra dar errado.
 */

import type { EaseName } from './easings.ts';

// --- efeitos ------------------------------------------------------------

/** As únicas propriedades que um efeito pode animar. Ver SCHEMA_DOC. */
export type AnimProp =
  | 'x' | 'y' | 'scale' | 'rotate'
  | 'opacity' | 'blur' | 'brightness' | 'letterSpacing';

/** Estado animado completo de uma layer num instante. */
export type LayerState = Record<AnimProp, number>;

/** Par [tempo normalizado 0..1, valor]. */
export type Keyframe = readonly [number, number];

export interface Track {
  prop: AnimProp;
  keys: Keyframe[];
  ease?: EaseName;
}

export interface Effect {
  name?: string;
  /** Segundos. Ausente = 1. */
  duration?: number;
  /** `'end'` ancora no fim da layer — é como se escreve uma animação de saída. */
  anchor?: 'start' | 'end';
  delay?: number;
  loop?: boolean;
  tracks: Track[];
}

// --- layers -------------------------------------------------------------

export type LayerType = 'text' | 'image' | 'video' | 'audio';

/**
 * O que uma layer com som carrega.
 *
 * Vale pra vídeo e pra áudio: um clipe de vídeo tem trilha própria, e tratá-la
 * como "áudio de segunda classe" obrigaria a duplicar volume, mudo e mixagem
 * em dois caminhos diferentes.
 */
export interface Audible {
  /** Ganho, 0..1. */
  volume: number;
  mute: boolean;
}

/** O mínimo pra situar algo na linha do tempo — o que a maioria da engine lê. */
export interface TimeSpan {
  start: number;
  duration: number;
}

interface LayerBase extends TimeSpan {
  id: number;
  name: string;
  x: number;
  y: number;
  effects: Effect[];
  /**
   * Faixa da timeline. Número maior desenha por cima.
   *
   * Vários clipes dividem a mesma faixa desde que **não se sobreponham no
   * tempo** — é essa invariante que faz a ordem de desenho dentro de uma faixa
   * não importar, porque nunca há dois ativos no mesmo instante.
   */
  track: number;
}

/**
 * Como o texto se destaca do que está atrás.
 *
 * Existe porque título claro sobre imagem clara simplesmente some, e é o caso
 * mais comum de todos: legenda por cima de footage. Contorno e sombra são as
 * duas saídas clássicas, e servem a situações diferentes — o contorno segura
 * sobre fundo agitado, a sombra é mais discreta sobre fundo liso.
 *
 * Fora do vocabulário de efeitos de propósito: `prop` é fechado e mapeia pra
 * CSS/canvas, e isto aqui é aparência fixa da layer, não algo que anima.
 */
export interface TextDecor {
  /** Cor do contorno. Largura 0 desliga, e é o padrão. */
  stroke: string;
  /** Espessura VISÍVEL do contorno, em pixels do projeto. */
  strokeWidth: number;
  /** Cor da sombra. Sem desfoque nem deslocamento, não desenha nada. */
  shadow: string;
  shadowBlur: number;
  /** Deslocamento vertical. Sombra projetada é sempre pra baixo. */
  shadowOffset: number;
}

export interface TextLayer extends LayerBase, TextDecor {
  type: 'text';
  text: string;
  size: number;
  color: string;
  font: string;
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  /** Fração da composição que a mídia ocupa antes dos efeitos. */
  fit: number;
  img: HTMLImageElement;
  /**
   * Chave do arquivo no `mediaStore`. É o que sobrevive a um recarregamento:
   * o elemento e o `blob:` do `src` morrem junto com a aba, o id não.
   */
  mediaId: string;
}

export interface VideoLayer extends LayerBase, Audible {
  type: 'video';
  fit: number;
  video: HTMLVideoElement;
  /** Ver `mediaId` em ImageLayer. */
  mediaId: string;
  /** Ponto do arquivo em que o clipe começa a ler. */
  trimStart: number;
  sourceDuration: number;
}

/**
 * Uma trilha de áudio. Ocupa faixa e tempo como qualquer outra layer, mas não
 * desenha nada — e é isso que a torna interessante pro cache: mexer no volume
 * não muda um pixel, então o trecho pré-renderizado continua valendo. Ver
 * `renderSignature`.
 */
export interface AudioLayer extends LayerBase, Audible {
  type: 'audio';
  audio: HTMLAudioElement;
  /** Ver `mediaId` em ImageLayer. */
  mediaId: string;
  /** Ponto do arquivo em que o clipe começa a tocar. */
  trimStart: number;
  sourceDuration: number;
}

export type Layer = TextLayer | ImageLayer | VideoLayer | AudioLayer;

/** Layers que desenham pixels. O que sobra é áudio. */
export type VisualLayer = TextLayer | ImageLayer | VideoLayer;

/** Layers que produzem som. */
export type SoundLayer = VideoLayer | AudioLayer;

/** Layers com material de origem — as que têm trim e duração limitada. */
export type MediaLayer = ImageLayer | VideoLayer | AudioLayer;

/** Patch parcial aplicado por `updateLayer`. O `id` nunca muda. */
export type LayerPatch = Partial<Omit<TextLayer, 'id' | 'type'>>
  & Partial<Omit<ImageLayer, 'id' | 'type'>>
  & Partial<Omit<VideoLayer, 'id' | 'type'>>
  & Partial<Omit<AudioLayer, 'id' | 'type'>>;

/**
 * Um arquivo importado no projeto.
 *
 * Existe SEPARADO das layers de propósito. Antes, mídia só existia enquanto
 * alguma layer a usasse: apagar o clipe apagava o arquivo, e reimportar o
 * mesmo vídeo guardava uma segunda cópia dos mesmos bytes. Com o acervo, o
 * arquivo pertence ao projeto e as layers apenas o referenciam — que é o que
 * permite usar o mesmo material em vários pontos da linha do tempo.
 */
export interface MediaAsset {
  /** O mesmo `mediaId` que as layers referenciam. */
  id: string;
  name: string;
  /** MIME do arquivo: decide se vira imagem, vídeo ou som. */
  type: string;
  /** Segundos. Zero para imagem. */
  duration: number;
}

export interface Project {
  width: number;
  height: number;
  /** Taxa de quadros da composição: preview, cache e export se alinham nela. */
  fps: number;
  background: string;
  layers: Layer[];
  /** Os arquivos importados neste projeto, usados ou não. */
  media: MediaAsset[];
}

// --- recortes estruturais -----------------------------------------------
// A engine lê pedaços de uma layer, não a layer inteira. Pedir só o pedaço
// mantém as funções puras testáveis com objetos mínimos, sem cast.

/** O que `sourceTimeAt` / `videoSyncPlan` precisam saber sobre o clipe. */
export interface VideoTiming extends TimeSpan {
  trimStart?: number;
  sourceDuration?: number;
}

/** O que a sonda de atividade lê de um `<video>` — nada além disso. */
export interface VideoProbe {
  seeking: boolean;
  readyState: number;
}
