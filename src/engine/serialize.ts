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
import { compactTracks, healLayerIds } from './project.ts';
import type {
  AnimProp, AudioLayer, CountUp, Effect, ImageLayer, Layer, LayerType, MediaAsset, Project,
  TextLayer, Track, VideoLayer,
} from './types.ts';

/**
 * 1 → 2: cada layer ganhou `track`. No formato 1 uma layer era uma faixa, e a
 * ordem do array era a ordem de desenho — então a migração é `track = índice`,
 * o que preserva exatamente o que o projeto mostrava.
 */
/**
 * 2 → 3: layers de som ganharam `volume`/`mute`, e existe o tipo `audio`. Um
 * projeto do formato 2 não tinha som nenhum, então a migração é só o padrão
 * (volume cheio, sem mudo) — não há informação a recuperar.
 */
/**
 * 3 → 4: o projeto passou a guardar o acervo de mídia (`media`), em vez de ele
 * existir só implicitamente nas layers. A migração deriva o acervo das layers
 * que já existem — o que preserva exatamente o material que o projeto tinha.
 */
/**
 * 4 → 5: texto ganhou contorno e sombra (`TextDecor`), e toda layer ganhou
 * `rotate` de base — o campo onde o gizmo escreve ao girar. Nos dois casos um
 * projeto do formato 4 vira o padrão desligado, que é exatamente como ele já
 * era desenhado.
 */
/**
 * 5 → 6: vídeo e áudio passaram a ter espaços de faixa SEPARADOS. Num projeto
 * do formato 5 a numeração era compartilhada, então uma faixa de áudio podia
 * ser a 3 só porque existiam três faixas de vídeo. `compactTracks` renumera
 * cada tipo por conta própria — o que é literalmente a tradução pro modelo
 * novo, e não move clipe nenhum no tempo.
 */
/**
 * 6 → 7: texto ganhou `countUp` (contador numérico animado), opcional.
 * Ausente = como já era — texto estático, nada a migrar. O bump existe pelo
 * mesmo motivo do 4 → 5: não porque o dado antigo quebra (não quebra), mas
 * pra que um `.frag` com contador não seja aberto silenciosamente numa build
 * mais velha e perca a animação sem aviso — `deserializeProject` já recusa
 * formato futuro com mensagem explícita.
 */
export const PROJECT_FORMAT = 7;

export interface SerializedProject {
  format: number;
  width: number;
  height: number;
  fps: number;
  background: string;
  media: MediaAsset[];
  layers: SerializedLayer[];
}

interface SerializedBase {
  id: number;
  name: string;
  start: number;
  duration: number;
  x: number;
  y: number;
  rotate: number;
  track: number;
  effects: Effect[];
}

interface SerializedSound {
  volume: number;
  mute: boolean;
  mediaId: string;
  trimStart: number;
  sourceDuration: number;
}

export type SerializedLayer =
  | (SerializedBase & SerializedDecor & {
    type: 'text'; text: string; size: number; color: string; font: string; countUp?: CountUp;
  })
  | (SerializedBase & { type: 'image'; fit: number; mediaId: string })
  | (SerializedBase & SerializedSound & { type: 'video'; fit: number })
  | (SerializedBase & SerializedSound & { type: 'audio' });

/** Contorno e sombra do texto. Ver `TextDecor`. */
interface SerializedDecor {
  stroke: string;
  strokeWidth: number;
  shadow: string;
  shadowBlur: number;
  shadowOffset: number;
}

/** Um elemento pronto pra uma layer de mídia, resolvido a partir do id. */
export type MediaElement = HTMLImageElement | HTMLVideoElement | HTMLAudioElement;
/**
 * Entrega o elemento de uma layer. Recebe o TIPO junto, não só o id.
 *
 * Não é detalhe: separar o áudio de um clipe produz uma layer `audio` cujo
 * `mediaId` aponta pra um arquivo de VÍDEO. Resolvendo só pelo id, ela receberia
 * de volta o `<video>` — e passaria a disputar o cursor com a imagem, que é
 * justamente o que separar veio desfazer. Com o tipo, quem resolve sabe que
 * precisa de um `<audio>` próprio sobre a mesma fonte.
 */
export type MediaResolver = (mediaId: string, type: LayerType) => MediaElement | null;

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
    media: project.media,
    layers: project.layers.map(serializeLayer),
  };
}

function serializeLayer(l: Layer): SerializedLayer {
  const base: SerializedBase = {
    id: l.id, name: l.name,
    start: l.start, duration: l.duration,
    x: l.x, y: l.y,
    rotate: l.rotate,
    track: l.track,
    effects: l.effects,
  };

  if (l.type === 'text') {
    return {
      ...base, type: 'text', text: l.text, size: l.size, color: l.color, font: l.font,
      stroke: l.stroke, strokeWidth: l.strokeWidth,
      shadow: l.shadow, shadowBlur: l.shadowBlur, shadowOffset: l.shadowOffset,
      // Espalhado condicionalmente, não `countUp: l.countUp` direto: a chave
      // presente com valor `undefined` sai igual no JSON, mas no objeto em
      // memória `assert.deepEqual({countUp: undefined}, {})` é FALSO — um
      // projeto sem contador deixaria de bater com uma layer construída sem
      // tocar no campo.
      ...(l.countUp ? { countUp: l.countUp } : {}),
    };
  }
  if (l.type === 'image') {
    return { ...base, type: 'image', fit: l.fit, mediaId: l.mediaId };
  }

  const sound: SerializedSound = {
    volume: l.volume, mute: l.mute, mediaId: l.mediaId,
    trimStart: l.trimStart, sourceDuration: l.sourceDuration,
  };

  if (l.type === 'audio') return { ...base, ...sound, type: 'audio' };
  return { ...base, ...sound, type: 'video', fit: l.fit };
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
  const data = raw as Record<string, unknown>;

  // O ACERVO é a verdade sobre o que guardar. Um arquivo importado e ainda não
  // usado em layer nenhuma continua sendo do projeto — varrer só as layers o
  // apagaria no próximo carregamento.
  for (const m of Array.isArray(data.media) ? (data.media as unknown[]) : []) {
    if (typeof m !== 'object' || m === null) continue;
    const id = (m as Record<string, unknown>).id;
    if (typeof id === 'string' && id) ids.add(id);
  }

  // Formato antigo, sem acervo: as layers são a única fonte.
  for (const l of Array.isArray(data.layers) ? (data.layers as unknown[]) : []) {
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

  const incoming = Array.isArray(data.layers) ? data.layers : [];
  incoming.forEach((raw, index) => {
    // O índice é a faixa padrão: é exatamente o que o formato 1 significava,
    // quando uma layer era uma faixa e a ordem do array era a de desenho.
    const layer = readLayer(raw, index, resolve, missingMedia);
    if (layer) layers.push(layer);
  });

  /**
   * Compacta as faixas na leitura — é a migração 5 → 6 acontecendo.
   *
   * Num projeto do formato 5 a numeração era compartilhada entre vídeo e áudio,
   * então uma faixa de áudio podia ser a 3 só porque existiam três de vídeo. A
   * compactação por tipo traduz isso pro modelo novo sem mover clipe nenhum no
   * tempo. É idempotente, então rodar em projeto já novo não custa nada.
   */
  const tracked = compactTracks(layers);

  return {
    project: {
      width: num(data.width, 1920),
      height: num(data.height, 1080),
      fps: num(data.fps, 30),
      background: str(data.background, '#151021'),
      media: readMedia(data.media, tracked),
      // Última etapa da leitura: ids únicos, e o contador acima do maior deles.
      // Ver `healLayerIds` — sem isto, a primeira layer nova da sessão podia
      // nascer com o id de uma layer restaurada e ficar "interligada" a ela.
      layers: healLayerIds(tracked),
    },
    missingMedia,
  };
}

/**
 * O acervo do arquivo, ou — pra projetos do formato 3 e anteriores — derivado
 * das layers.
 *
 * A derivação é a migração: antes o material existia só enquanto uma layer o
 * usasse, então as layers SÃO o acervo daquele projeto.
 */
function readMedia(raw: unknown, layers: readonly Layer[]): MediaAsset[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item): MediaAsset[] => {
      if (typeof item !== 'object' || item === null) return [];
      const m = item as Record<string, unknown>;
      const id = str(m.id, '');
      if (!id) return [];
      return [{
        id,
        name: str(m.name, 'mídia'),
        type: str(m.type, ''),
        duration: num(m.duration, 0),
      }];
    });
  }

  const seen = new Map<string, MediaAsset>();
  for (const l of layers) {
    if (l.type === 'text') continue;
    if (seen.has(l.mediaId)) continue;
    seen.set(l.mediaId, {
      id: l.mediaId,
      name: l.name,
      type: l.type === 'image' ? 'image/*' : l.type === 'video' ? 'video/*' : 'audio/*',
      duration: l.type === 'image' ? 0 : l.sourceDuration,
    });
  }
  return [...seen.values()];
}

function readLayer(
  raw: unknown,
  defaultTrack: number,
  resolve: MediaResolver,
  missing: string[],
): Layer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const l = raw as Record<string, unknown>;

  const base = {
    id: num(l.id, 0),
    name: str(l.name, 'Layer'),
    start: num(l.start, 0),
    duration: num(l.duration, 1),
    x: num(l.x, 0),
    y: num(l.y, 0),
    // Ausente num projeto antigo: sem rotação é como ele já se desenhava.
    rotate: num(l.rotate, 0),
    track: Math.max(0, Math.round(num(l.track, defaultTrack))),
    effects: readEffects(l.effects),
  };

  if (l.type === 'text') {
    const countUp = readCountUp(l.countUp);
    return {
      ...base, type: 'text',
      text: str(l.text, ''),
      size: num(l.size, 100),
      color: str(l.color, '#f7efdc'),
      font: str(l.font, 'sans-serif'),
      // Ausentes num projeto antigo: o padrão é desligado, que é como ele já
      // se desenhava.
      stroke: str(l.stroke, '#171021'),
      strokeWidth: Math.max(0, num(l.strokeWidth, 0)),
      shadow: str(l.shadow, '#171021'),
      shadowBlur: Math.max(0, num(l.shadowBlur, 0)),
      shadowOffset: num(l.shadowOffset, 0),
      // Espalhado condicionalmente — mesmo motivo de `serializeLayer`: um
      // projeto do formato 6 (sem `countUp`) tem que voltar IDÊNTICO a uma
      // layer que nunca tocou no campo, não com uma chave `undefined` a mais.
      ...(countUp ? { countUp } : {}),
    } satisfies TextLayer;
  }

  if (l.type !== 'image' && l.type !== 'video' && l.type !== 'audio') return null;

  const mediaId = str(l.mediaId, '');
  const element = mediaId ? resolve(mediaId, l.type) : null;
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

  const media = element as HTMLMediaElement;
  const sound = {
    mediaId,
    trimStart: num(l.trimStart, 0),
    // Sem a duração da fonte o trim perde o limite e a layer pode ser
    // esticada além do arquivo; o próprio elemento sabe responder isso.
    sourceDuration: num(l.sourceDuration, media.duration || 0),
    // Preso em 0..1: um volume fora da faixa é recusado pelo elemento com uma
    // exceção, que derrubaria a abertura do projeto inteiro.
    volume: Math.max(0, Math.min(1, num(l.volume, 1))),
    mute: l.mute === true,
  };

  if (l.type === 'audio') {
    return { ...base, ...sound, type: 'audio', audio: element as HTMLAudioElement } satisfies AudioLayer;
  }

  return {
    ...base, ...sound, type: 'video',
    fit: num(l.fit, 1),
    video: element as HTMLVideoElement,
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

/**
 * Igual em espírito a `readEffects`: garante só a FORMA, com cada campo tendo
 * um padrão — a entrada pode vir de um `.frag` editado à mão. `from`/`to` são
 * os únicos obrigatórios; sem eles não há contador nenhum pra ler, e `undefined`
 * (não uma exceção) é o que deixa o texto continuar estático.
 */
function readCountUp(raw: unknown): CountUp | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.from !== 'number' || typeof c.to !== 'number') return undefined;

  const cu: CountUp = { from: c.from, to: c.to };
  if (typeof c.duration === 'number') cu.duration = c.duration;
  if (typeof c.delay === 'number') cu.delay = c.delay;
  if (c.anchor === 'end' || c.anchor === 'start') cu.anchor = c.anchor;
  if (typeof c.loop === 'boolean') cu.loop = c.loop;
  // Não validado contra `EASE_NAMES`, igual ao `ease` de `readEffects`: um
  // nome desconhecido cai em `linear` na hora de usar (ver `countUp.ts`), não
  // na hora de ler.
  if (typeof c.ease === 'string') cu.ease = c.ease as CountUp['ease'];
  if (typeof c.decimals === 'number') cu.decimals = Math.max(0, Math.round(c.decimals));
  if (typeof c.separator === 'boolean') cu.separator = c.separator;
  if (typeof c.prefix === 'string') cu.prefix = c.prefix;
  if (typeof c.suffix === 'string') cu.suffix = c.suffix;
  return cu;
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' ? v : fallback;
