/**
 * Projeto ↔ JSON.
 *
 * O nó do problema: uma layer de mídia carrega um `HTMLVideoElement` vivo, e
 * elemento de DOM não vira JSON. Pior, o `src` dele é um `blob:` — uma URL
 * válida só enquanto a aba está aberta. Salvar isso produziria um arquivo que
 * *parece* certo e abre quebrado amanhã, que é o pior resultado possível.
 *
 * Então a serialização guarda um **mediaId** no lugar do elemento, e quem
 * reabre o projeto é responsável por trocar cada id pelo elemento
 * correspondente (ver `mediaStore.ts`). Este arquivo não toca em DOM nem em
 * IndexedDB de propósito: é só a tradução, e por isso roda inteiro em teste.
 *
 * Compatibilidade: todo arquivo carrega `format`. Ler um formato futuro é
 * recusado explicitamente em vez de tentar adivinhar — abrir um projeto novo
 * numa versão velha e perder metade das layers em silêncio é o tipo de coisa
 * que faz alguém desistir do editor.
 */

import { BASE_STATE } from './effects.ts';
import type {
  AnimProp, Effect, ImageLayer, Layer, Project, TextLayer, Track, VideoLayer,
} from './types.ts';

export const PROJECT_FORMAT = 1;

export interface SerializedProject {
  format: number;
  width: number;
  height: number;
  fps: number;
  background: string;
  layers: SerializedLayer[];
}

interface SerializedBase {
  id: number;
  name: string;
  start: number;
  duration: number;
  x: number;
  y: number;
  effects: Effect[];
}

export type SerializedLayer =
  | (SerializedBase & { type: 'text'; text: string; size: number; color: string; font: string })
  | (SerializedBase & { type: 'image'; fit: number; mediaId: string })
  | (SerializedBase & {
      type: 'video'; fit: number; mediaId: string;
      trimStart: number; sourceDuration: number;
    });

/** Um elemento pronto pra uma layer de mídia, resolvido a partir do id. */
export type MediaResolver = (mediaId: string) => HTMLImageElement | HTMLVideoElement | null;

export interface LoadResult {
  project: Project;
  /**
   * Layers descartadas por falta da mídia. Quem chama AVISA o usuário — some
   * uma layer em silêncio e a pessoa acha que o editor corrompeu o projeto.
   */
  missingMedia: string[];
}

export class ProjectFormatError extends Error {}

// --- escrita ------------------------------------------------------------

export function serializeProject(project: Project): SerializedProject {
  return {
    format: PROJECT_FORMAT,
    width: project.width,
    height: project.height,
    fps: project.fps,
    background: project.background,
    layers: project.layers.map(serializeLayer),
  };
}

function serializeLayer(l: Layer): SerializedLayer {
  const base: SerializedBase = {
    id: l.id, name: l.name,
    start: l.start, duration: l.duration,
    x: l.x, y: l.y,
    effects: l.effects,
  };

  if (l.type === 'text') {
    return { ...base, type: 'text', text: l.text, size: l.size, color: l.color, font: l.font };
  }
  if (l.type === 'image') {
    return { ...base, type: 'image', fit: l.fit, mediaId: l.mediaId };
  }
  return {
    ...base, type: 'video', fit: l.fit, mediaId: l.mediaId,
    trimStart: l.trimStart, sourceDuration: l.sourceDuration,
  };
}

/**
 * Quais mídias um projeto salvo referencia — lido do JSON cru, sem precisar
 * desserializar.
 *
 * Serve pra descartar o que sobrou antes de abrir: excluir uma layer não apaga
 * o arquivo (o undo pode trazê-la de volta), então a mídia órfã se acumula
 * durante a sessão. Na hora de reabrir não há mais histórico que a alcance, e
 * carregar tudo faria o editor decodificar vídeos que ninguém usa a cada
 * abertura.
 */
export function mediaIdsOf(raw: unknown): Set<string> {
  const ids = new Set<string>();
  if (typeof raw !== 'object' || raw === null) return ids;

  // Tratado como JSON cru, não como `SerializedProject`: a entrada vem do
  // disco e pode não ter a forma que o tipo promete.
  const layers = (raw as Record<string, unknown>).layers;
  for (const l of Array.isArray(layers) ? (layers as unknown[]) : []) {
    if (typeof l !== 'object' || l === null) continue;
    const id = (l as Record<string, unknown>).mediaId;
    if (typeof id === 'string' && id) ids.add(id);
  }
  return ids;
}

// --- leitura ------------------------------------------------------------

/**
 * O oposto exato de `serializeProject`, mas **defensivo**: a entrada é um
 * arquivo que pode ter sido editado à mão, truncado ou gerado por outra
 * versão. Cada campo tem um padrão, e o que não dá pra recuperar é reportado
 * em vez de virar `undefined` circulando pela engine.
 */
export function deserializeProject(raw: unknown, resolve: MediaResolver): LoadResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new ProjectFormatError('Arquivo de projeto inválido: não é um objeto JSON.');
  }

  const data = raw as Partial<SerializedProject>;

  if (typeof data.format !== 'number') {
    throw new ProjectFormatError('Arquivo de projeto sem versão de formato.');
  }
  if (data.format > PROJECT_FORMAT) {
    throw new ProjectFormatError(
      `Este projeto foi salvo numa versão mais nova (formato ${data.format}, esta lê até ${PROJECT_FORMAT}).`,
    );
  }

  const missingMedia: string[] = [];
  const layers: Layer[] = [];

  for (const raw of Array.isArray(data.layers) ? data.layers : []) {
    const layer = readLayer(raw, resolve, missingMedia);
    if (layer) layers.push(layer);
  }

  return {
    project: {
      width: num(data.width, 1920),
      height: num(data.height, 1080),
      fps: num(data.fps, 30),
      background: str(data.background, '#151021'),
      layers,
    },
    missingMedia,
  };
}

function readLayer(raw: unknown, resolve: MediaResolver, missing: string[]): Layer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const l = raw as Record<string, unknown>;

  const base = {
    id: num(l.id, 0),
    name: str(l.name, 'Layer'),
    start: num(l.start, 0),
    duration: num(l.duration, 1),
    x: num(l.x, 0),
    y: num(l.y, 0),
    effects: readEffects(l.effects),
  };

  if (l.type === 'text') {
    return {
      ...base, type: 'text',
      text: str(l.text, ''),
      size: num(l.size, 100),
      color: str(l.color, '#f7efdc'),
      font: str(l.font, 'sans-serif'),
    } satisfies TextLayer;
  }

  if (l.type !== 'image' && l.type !== 'video') return null;

  const mediaId = str(l.mediaId, '');
  const element = mediaId ? resolve(mediaId) : null;
  if (!element) {
    // O arquivo original sumiu do armazenamento. Reportar em vez de inventar
    // uma layer vazia que desenharia nada e confundiria mais.
    missing.push(base.name);
    return null;
  }

  if (l.type === 'image') {
    return {
      ...base, type: 'image',
      fit: num(l.fit, 0.8),
      mediaId,
      img: element as HTMLImageElement,
    } satisfies ImageLayer;
  }

  return {
    ...base, type: 'video',
    fit: num(l.fit, 1),
    mediaId,
    video: element as HTMLVideoElement,
    trimStart: num(l.trimStart, 0),
    // Sem a duração da fonte o trim perde o limite e a layer pode ser
    // esticada além do arquivo; o próprio elemento sabe responder isso.
    sourceDuration: num(l.sourceDuration, (element as HTMLVideoElement).duration || 0),
  } satisfies VideoLayer;
}

/**
 * Efeitos vêm do JSON e podem ter sido escritos à mão — é o ponto do formato.
 * Aqui só se garante a forma; uma `prop` desconhecida é descartada, porque
 * `resolveState` a ignoraria de qualquer jeito e mantê-la só engana quem for
 * ler o arquivo depois.
 */
function readEffects(raw: unknown): Effect[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<string>(Object.keys(BASE_STATE()));

  return raw.flatMap((item): Effect[] => {
    if (typeof item !== 'object' || item === null) return [];
    const e = item as Record<string, unknown>;
    if (!Array.isArray(e.tracks)) return [];

    const tracks = e.tracks.flatMap((t): Track[] => {
      if (typeof t !== 'object' || t === null) return [];
      const tr = t as Record<string, unknown>;
      if (typeof tr.prop !== 'string' || !valid.has(tr.prop)) return [];
      if (!Array.isArray(tr.keys)) return [];

      const keys = tr.keys.filter(
        (k): k is [number, number] =>
          Array.isArray(k) && k.length === 2 && typeof k[0] === 'number' && typeof k[1] === 'number',
      );
      if (!keys.length) return [];

      const track: Track = { prop: tr.prop as AnimProp, keys };
      if (typeof tr.ease === 'string') track.ease = tr.ease as Track['ease'];
      return [track];
    });

    if (!tracks.length) return [];

    const effect: Effect = { tracks };
    if (typeof e.name === 'string') effect.name = e.name;
    if (typeof e.duration === 'number') effect.duration = e.duration;
    if (typeof e.delay === 'number') effect.delay = e.delay;
    if (e.anchor === 'end' || e.anchor === 'start') effect.anchor = e.anchor;
    if (typeof e.loop === 'boolean') effect.loop = e.loop;
    return [effect];
  });
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' ? v : fallback;
