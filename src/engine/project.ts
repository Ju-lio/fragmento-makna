import { PRESETS } from './presets.ts';
import { DISPLAY_FONT } from './renderer.ts';
import type {
  AudioLayer, Effect, ImageLayer, Layer, LayerPatch, LayerType, Project, TextLayer,
  TimeSpan, VideoLayer, VisualLayer,
} from './types.ts';

export type { MediaAsset } from './types.ts';

export type {
  Effect, ImageLayer, Layer, LayerPatch, Project, TextLayer, VideoLayer,
} from './types.ts';

export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

/** Um preset sempre existe — o índice literal já garante isso em tempo de tipo. */
const preset = (name: keyof typeof PRESETS): Effect => clone(PRESETS[name]);

/** Composition sizes. Layers are positioned from the centre, so most of a
 *  project survives a resolution swap without being rebuilt. */
export interface Resolution {
  id: string;
  label: string;
  w: number;
  h: number;
  note: string;
}

export const RESOLUTIONS: Resolution[] = [
  { id: '1080p',    label: '1920x1080', w: 1920, h: 1080, note: 'YouTube 16:9' },
  { id: 'vertical', label: '1080x1920', w: 1080, h: 1920, note: 'Reels / Shorts' },
  { id: 'square',   label: '1080x1080', w: 1080, h: 1080, note: 'Feed 1:1' },
  { id: '720p',     label: '1280x720',  w: 1280, h: 720,  note: 'Leve' },
];

let _id = 1;
export const nextId = () => _id++;

export function makeTextLayer(overrides: Partial<TextLayer> = {}): TextLayer {
  return {
    id: nextId(),
    type: 'text',
    name: 'Texto',
    start: 0,
    duration: 3,
    text: 'NOVO TEXTO',
    size: 110,
    color: '#f7efdc',
    font: DISPLAY_FONT,
    x: 0,
    y: 0,
    rotate: 0,
    track: 0,
    // Nasce sem contorno nem sombra: um texto que já se lê não precisa deles, e
    // ligá-los por padrão mudaria a cara de todo projeto que já existe.
    stroke: '#171021',
    strokeWidth: 0,
    shadow: '#171021',
    shadowBlur: 0,
    shadowOffset: 0,
    effects: [preset('fade-up')],
    ...overrides,
  };
}

/**
 * Longest a layer can run given how much source material is left after the trim.
 *
 * Recebe `TrimTarget`, não `VideoLayer`: texto não tem material de origem e o
 * limite dele é infinito, então a mesma conta serve pros três tipos de layer.
 */
export function maxDuration(layer: TrimTarget): number {
  if (!Number.isFinite(layer.sourceDuration)) return Infinity;
  return Math.max(MIN_CLIP, (layer.sourceDuration as number) - (layer.trimStart || 0));
}

export const MIN_CLIP = 0.1;

/**
 * Até onde um clipe pode se esticar sem invadir os vizinhos da mesma faixa.
 *
 * Passou a fazer falta quando uma faixa deixou de ter um clipe só: sem isso,
 * arrastar a alça direita comeria o clipe seguinte, e a faixa perderia a
 * invariante de nunca ter dois clipes no mesmo instante.
 */
export interface TrimBounds {
  /** O clipe não pode começar antes disso — o fim do vizinho anterior. */
  minStart?: number;
  /** Nem terminar depois disso — o começo do próximo. */
  maxEnd?: number;
}

/** A janela livre em volta de um clipe, dentro da faixa dele. */
export function freeWindow(layers: readonly Layer[], target: Layer): Required<TrimBounds> {
  let minStart = 0;
  let maxEnd = Infinity;

  for (const l of layers) {
    // Mesma faixa E mesmo tipo: a faixa 0 do áudio não é a faixa 0 do vídeo.
    if (l.id === target.id || l.track !== target.track || trackKind(l) !== trackKind(target)) continue;
    const end = l.start + l.duration;
    if (end <= target.start) minStart = Math.max(minStart, end);
    else if (l.start >= target.start + target.duration) maxEnd = Math.min(maxEnd, l.start);
  }

  return { minStart, maxEnd };
}

/**
 * Dragging a clip's right edge just changes how long it plays.
 * Returns a patch, or null when the drag is a no-op.
 */
export function trimRight(
  layer: TrimTarget,
  deltaSec: number,
  { maxEnd = Infinity }: TrimBounds = {},
): LayerPatch | null {
  const wanted = layer.duration + deltaSec;
  const ceiling = Math.min(maxDuration(layer), maxEnd - layer.start);
  const duration = Math.max(MIN_CLIP, Math.min(wanted, ceiling));
  return duration === layer.duration ? null : { duration: round(duration) };
}

/**
 * Dragging the left edge moves the clip AND the point it starts reading from,
 * so the footage under the cursor stays put instead of sliding.
 */
export function trimLeft(
  layer: TrimTarget,
  deltaSec: number,
  { minStart = 0 }: TrimBounds = {},
): LayerPatch | null {
  const trimStart = layer.trimStart || 0;
  let d = deltaSec;

  // Can't read before the start of the source...
  if (Number.isFinite(layer.sourceDuration)) d = Math.max(d, -trimStart);
  // ...can't push the clip off the front of the timeline, nem por cima do
  // vizinho anterior da mesma faixa...
  d = Math.max(d, minStart - layer.start);
  // ...and can't shrink past the minimum length.
  d = Math.min(d, layer.duration - MIN_CLIP);

  if (Math.abs(d) < 1e-4) return null;

  const patch: LayerPatch = {
    start: round(layer.start + d),
    duration: round(layer.duration - d),
  };
  if (Number.isFinite(layer.sourceDuration)) patch.trimStart = round(trimStart + d);
  return patch;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

// --- faixas -------------------------------------------------------------

/**
 * Ordem de desenho: faixa menor no fundo, maior por cima.
 *
 * Memoriza por referência do projeto, como `signatureOf`. Ordenar dentro do
 * `drawFrame` seria correto e alocaria um array por quadro — 60 vezes por
 * segundo, no caminho quente que o resto do editor faz questão de manter
 * limpo. Como o projeto é imutável, uma ordenação por edição basta.
 *
 * A ordenação é estável, então clipes na mesma faixa mantêm a ordem do array.
 * Não importa qual: eles não se sobrepõem, logo nunca há dois no mesmo quadro.
 */
const drawOrders = new WeakMap<Project, VisualLayer[]>();

export function drawOrder(project: Project): VisualLayer[] {
  let order = drawOrders.get(project);
  if (!order) {
    order = project.layers
      .filter((l): l is VisualLayer => l.type !== 'audio')
      .sort((a, b) => a.track - b.track);
    drawOrders.set(project, order);
  }
  return order;
}

/**
 * Vídeo e áudio têm espaços de faixa SEPARADOS.
 *
 * Era um espaço só, e isso deixava o modelo ambíguo: a faixa 2 podia ter um
 * clipe de vídeo e um de áudio ao mesmo tempo, sem que nada os distinguisse.
 * Funcionava porque a ordem de desenho já ignora áudio — mas a timeline não
 * tinha como agrupar o som embaixo, e a numeração não queria dizer a mesma
 * coisa nos dois casos (no vídeo é profundidade; no áudio, nada).
 *
 * Com dois espaços, "faixa 0" passa a significar uma coisa só dentro de cada
 * tipo, e as duas perguntas que o editor faz o tempo todo — quem colide comigo,
 * qual é a faixa de cima — ficam bem definidas.
 */
export type TrackKind = 'visual' | 'audio';

export const trackKind = (layer: { type: LayerType }): TrackKind =>
  (layer.type === 'audio' ? 'audio' : 'visual');

/** Só as layers que dividem espaço de faixa com esta. */
export function layersOfKind(layers: readonly Layer[], kind: TrackKind): Layer[] {
  return layers.filter(l => trackKind(l) === kind);
}

/** A faixa mais alta em uso. -1 quando não há layer nenhuma. */
export function topTrack(layers: readonly Layer[]): number {
  return layers.reduce((max, l) => Math.max(max, l.track), -1);
}

/** A faixa mais alta em uso DENTRO de um tipo — que é o que quase todo mundo quer. */
export function topTrackOf(layers: readonly Layer[], kind: TrackKind): number {
  return topTrack(layersOfKind(layers, kind));
}

/** Piso da duração. Um projeto vazio ainda precisa de régua pra soltar o primeiro clipe. */
export const MIN_PROJECT = 1;

/**
 * Quanto dura o projeto: onde termina o último clipe.
 *
 * Era um campo que você digitava, e isso tinha dois defeitos que se somavam.
 * O primeiro: clipe que passasse do número ficava **fora do export**, sem nada
 * avisar — você montava 12s, o campo dizia 8, e o arquivo saía cortado. O
 * segundo: o número não era serializado, então reabrir um projeto de 60s o
 * devolvia com 8 e encolhia a régua inteira.
 *
 * Derivar mata os dois de uma vez, e não há informação a perder — não existe
 * projeto cujo tamanho certo seja "menor que o próprio conteúdo".
 */
export function projectDuration(layers: readonly Layer[]): number {
  const end = layers.reduce((max, l) => Math.max(max, l.start + l.duration), 0);
  return Math.max(MIN_PROJECT, round(end));
}

/**
 * Sobra de régua depois do fim do conteúdo — a "pista" pra onde arrastar.
 *
 * Sem ela a duração derivada vira uma armadilha circular: o arrasto prende o
 * clipe dentro da duração, e a duração vem dos clipes, então o projeto nunca
 * poderia crescer. É por isso que a régua da timeline é mais longa que o
 * projeto, e por isso que as duas medidas são coisas separadas — quem exporta e
 * quem dá loop usa o CONTEÚDO; só o desenho da timeline usa a pista.
 */
const TAIL_MIN = 1;
const TAIL_MAX = 5;
const TAIL_SHARE = 0.15;

/**
 * Até onde a régua da timeline vai: o conteúdo, mais a pista.
 *
 * A pista é proporcional, com piso e teto. Fixa em 5s ela sufocava projeto
 * curto — num de 8s seriam 38% da régua em vazio — e sumia em projeto longo.
 * Assim ela é sempre visível e nunca domina.
 */
export function rulerDuration(layers: readonly Layer[]): number {
  const content = projectDuration(layers);
  const tail = Math.max(TAIL_MIN, Math.min(TAIL_MAX, content * TAIL_SHARE));
  return round(content + tail);
}

/**
 * Renumera as faixas pra 0..n-1, eliminando as que ficaram vazias.
 *
 * Sem isso, arrastar o único clipe de uma faixa pra outra deixaria uma faixa
 * fantasma pra trás, e o editor iria acumulando linhas vazias a cada gesto.
 * A ordem relativa entre faixas é preservada — compactar não pode reordenar
 * o que está na tela.
 */
export function compactTracks(layers: readonly Layer[]): Layer[] {
  // Um mapa POR TIPO: renumerar os dois juntos misturaria os espaços de volta,
  // e uma faixa de áudio passaria a depender de quantas faixas de vídeo existem.
  const renumber = new Map<TrackKind, Map<number, number>>();

  for (const kind of ['visual', 'audio'] as const) {
    const used = [...new Set(layersOfKind(layers, kind).map(l => l.track))].sort((a, b) => a - b);
    renumber.set(kind, new Map(used.map((track, i) => [track, i])));
  }

  return layers.map(l => {
    const track = renumber.get(trackKind(l))?.get(l.track) ?? l.track;
    return track === l.track ? l : { ...l, track };
  });
}

/** Dois clipes ocupam o mesmo pedaço da mesma faixa? */
export function overlaps(a: TimeSpan, b: TimeSpan): boolean {
  // Estrito nas duas pontas: um clipe terminando exatamente onde o outro
  // começa é o caso NORMAL (é o que um corte produz), não uma colisão.
  return a.start < b.start + b.duration && b.start < a.start + a.duration;
}

/**
 * Onde encaixar um clipe colado, no instante `at`.
 *
 * Colar é diferente de duplicar: duplicar sabe pra onde ir (logo depois do
 * original), colar tem que achar lugar. A faixa não aceita sobreposição, então
 * "colar no cursor" pode simplesmente não caber — e recusar seria a pior
 * resposta possível, porque a pessoa acabou de mandar colar.
 *
 * Procura de baixo pra cima a partir da faixa preferida (a de origem, pra que
 * colar perto mantenha a camada), e abre uma faixa nova no topo se nenhuma
 * servir. Sempre cabe em algum lugar, e o lugar é previsível.
 */
export function pasteSlot(
  layers: readonly Layer[],
  span: TimeSpan,
  preferredTrack: number,
  kind: TrackKind = 'visual',
): { start: number; track: number } {
  // Só o próprio tipo entra na conta: um áudio nunca cai numa faixa de vídeo.
  const mesmas = layersOfKind(layers, kind);
  const top = topTrack(mesmas);
  const livre = (track: number) =>
    !mesmas.some(l => l.track === track && overlaps(l, span));

  for (let track = Math.max(0, preferredTrack); track <= top; track++) {
    if (livre(track)) return { start: span.start, track };
  }
  // Nenhuma serve: faixa nova, que por definição está vazia.
  return { start: span.start, track: top + 1 };
}

// --- corte --------------------------------------------------------------

/**
 * Divide um clipe no instante `t`, como o Ctrl+B do CapCut.
 *
 * Devolve `null` quando o corte não faz sentido — fora do clipe, ou tão perto
 * da ponta que uma das metades nasceria menor que `MIN_CLIP`. Recusar é melhor
 * que produzir um clipe de 3ms que você não consegue nem pegar pra apagar.
 */
export function splitLayer(layer: Layer, t: number): [Layer, Layer] | null {
  const head = t - layer.start;
  const tail = layer.start + layer.duration - t;
  if (head < MIN_CLIP || tail < MIN_CLIP) return null;

  const left: Layer = { ...layer, duration: round(head) };

  const right: Layer = {
    ...layer,
    id: nextId(),
    start: round(t),
    duration: round(tail),
    // Os efeitos são copiados, não compartilhados: as metades viram clipes
    // independentes, e editar os efeitos de uma não pode mexer na outra.
    effects: clone(layer.effects),
  };

  // Só vídeo tem material de origem pra avançar. A segunda metade precisa
  // começar a ler o arquivo onde a primeira parou, senão ela repetiria o
  // trecho que acabou de passar.
  if (right.type === 'video') right.trimStart = round(right.trimStart + head);

  return [left, right];
}

/** O recorte de uma layer que o corte de bordas realmente lê. */
export interface TrimTarget {
  start: number;
  duration: number;
  trimStart?: number;
  sourceDuration?: number;
}

export function makeVideoLayer(
  video: HTMLVideoElement,
  mediaId: string,
  overrides: Partial<VideoLayer> = {},
): VideoLayer {
  const sourceDuration = video.duration;
  return {
    id: nextId(),
    type: 'video',
    name: 'Vídeo',
    start: 0,
    duration: Math.min(sourceDuration, 5),
    trimStart: 0,
    sourceDuration,
    video,
    mediaId,
    volume: 1,
    mute: false,
    x: 0,
    y: 0,
    rotate: 0,
    track: 0,
    fit: 1,
    effects: [],
    ...overrides,
  };
}

export function makeAudioLayer(
  audio: HTMLAudioElement,
  mediaId: string,
  overrides: Partial<AudioLayer> = {},
): AudioLayer {
  const sourceDuration = audio.duration;
  return {
    id: nextId(),
    type: 'audio',
    name: 'Áudio',
    start: 0,
    // Áudio costuma ser música de fundo: entra inteiro, ao contrário do vídeo
    // (que é limitado a 5s pra você não cobrir a composição sem querer).
    duration: sourceDuration,
    trimStart: 0,
    sourceDuration,
    audio,
    mediaId,
    x: 0,
    y: 0,
    rotate: 0,
    track: 0,
    volume: 1,
    mute: false,
    effects: [],
    ...overrides,
  };
}

export function makeImageLayer(
  img: HTMLImageElement,
  mediaId: string,
  overrides: Partial<ImageLayer> = {},
): ImageLayer {
  return {
    id: nextId(),
    type: 'image',
    name: 'Imagem',
    start: 0,
    duration: 3,
    x: 0,
    y: 0,
    rotate: 0,
    track: 0,
    fit: 0.8,
    img,
    mediaId,
    effects: [preset('blur-in')],
    ...overrides,
  };
}

export function defaultProject(): Project {
  return {
    width: 1920,
    height: 1080,
    /** Taxa de quadros da composição. Tudo se alinha nela: o preview, o cache
     *  e (futuramente) o export — assim um frame é sempre o mesmo frame. */
    fps: 30,
    background: '#151021',
    media: [],
    layers: [
      makeTextLayer({
        name: 'Título', track: 2, start: 0.2, duration: 4.5,
        text: 'POWERED BY THE SUN', size: 150, y: -90,
        color: '#f7efdc',
        effects: [preset('zoom-punch'), preset('fade-out-down')],
      }),
      makeTextLayer({
        name: 'Subtítulo', track: 1, start: 0.75, duration: 4.2,
        text: '559.872 km rodados', size: 64, y: 70,
        color: '#f0c04a',
        effects: [
          { ...preset('slide-track'), delay: 0.1 },
          preset('fade-out-down'),
        ],
      }),
      makeTextLayer({
        name: 'Selo', track: 0, start: 5.0, duration: 3.0,
        text: '100% PIXEL PERFECT', size: 96, y: 0,
        color: '#64c48a',
        effects: [preset('spring-pop'), preset('float-loop')],
      }),
    ],
  };
}
