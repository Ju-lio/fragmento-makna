import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeProject, deserializeProject, mediaIdsOf, ProjectFormatError, PROJECT_FORMAT,
} from '../src/engine/serialize.ts';
import { project, textLayer, videoLayer, imageLayer, fakeVideo, fakeImage } from './fixtures.ts';
import type { TextLayer, VideoLayer } from '../src/engine/types.ts';

/** Resolve qualquer id — o caso em que toda a mídia continua disponível. */
const anyMedia = () => fakeVideo();
/** Resolve nenhum — o caso em que o armazenamento perdeu os arquivos. */
const noMedia = () => null;

// --- ida e volta --------------------------------------------------------

test('um projeto de texto sobrevive à ida e volta', () => {
  const original = project([
    textLayer({ id: 7, name: 'Título', text: 'OI\nMUNDO', size: 88, color: '#f00', start: 1.5 }),
  ]);

  const { project: back, missingMedia } = deserializeProject(serializeProject(original), anyMedia);

  assert.deepEqual(back.layers, original.layers, 'layer idêntica');
  assert.equal(back.width, original.width);
  assert.equal(back.fps, original.fps);
  assert.equal(back.background, original.background);
  assert.deepEqual(missingMedia, []);
});

test('o elemento de vídeo é trocado pelo mediaId e devolvido pelo resolvedor', () => {
  // É o ponto de todo o arquivo: elemento de DOM não vira JSON.
  const elemento = fakeVideo();
  const original = project([videoLayer({ mediaId: 'abc', trimStart: 2, sourceDuration: 30 })]);

  const raw = serializeProject(original);
  assert.equal(JSON.stringify(raw).includes('blob:'), false, 'nenhum blob: vazou pro arquivo');

  const { project: back } = deserializeProject(raw, id => (id === 'abc' ? elemento : null));
  const layer = back.layers[0] as VideoLayer;

  assert.equal(layer.video, elemento, 'o elemento veio do resolvedor');
  assert.equal(layer.mediaId, 'abc');
  assert.equal(layer.trimStart, 2, 'o trim sobreviveu');
  assert.equal(layer.sourceDuration, 30);
});

test('imagem também passa pelo mediaId', () => {
  const img = fakeImage();
  const raw = serializeProject(project([imageLayer({ mediaId: 'img1', fit: 0.5 })]));
  const { project: back } = deserializeProject(raw, () => img);

  assert.equal(back.layers[0]?.type, 'image');
  assert.equal((back.layers[0] as { img: unknown }).img, img);
});

test('efeitos atravessam inteiros', () => {
  const original = project([textLayer({
    effects: [{
      name: 'meu', duration: 0.8, delay: 0.1, anchor: 'end', loop: true,
      tracks: [{ prop: 'scale', keys: [[0, 0.5], [1, 1]], ease: 'outBack' }],
    }],
  })]);

  const { project: back } = deserializeProject(serializeProject(original), anyMedia);
  assert.deepEqual(back.layers[0]?.effects, original.layers[0]?.effects);
});

// --- mídia que sumiu ----------------------------------------------------

test('layer sem mídia é reportada, não some calada', () => {
  // Some uma layer em silêncio e a pessoa acha que o editor corrompeu tudo.
  const raw = serializeProject(project([
    textLayer({ name: 'Título' }),
    videoLayer({ name: 'clipe.mp4' }),
  ]));

  const { project: back, missingMedia } = deserializeProject(raw, noMedia);

  assert.equal(back.layers.length, 1, 'a de vídeo não entrou');
  assert.equal(back.layers[0]?.type, 'text', 'a de texto continua lá');
  assert.deepEqual(missingMedia, ['clipe.mp4'], 'e quem chamou pode avisar');
});

// --- versão do formato --------------------------------------------------

test('formato do futuro é recusado com explicação', () => {
  // Abrir e perder metade das layers em silêncio é bem pior que não abrir.
  assert.throws(
    () => deserializeProject({ format: PROJECT_FORMAT + 1, layers: [] }, anyMedia),
    (e: unknown) => e instanceof ProjectFormatError && /mais nova/.test((e as Error).message),
  );
});

test('arquivo sem versão é recusado', () => {
  assert.throws(() => deserializeProject({ layers: [] }, anyMedia), ProjectFormatError);
});

test('entrada que nem é objeto é recusada', () => {
  assert.throws(() => deserializeProject('nada disso', anyMedia), ProjectFormatError);
  assert.throws(() => deserializeProject(null, anyMedia), ProjectFormatError);
});

// --- arquivo corrompido ou mexido à mão ---------------------------------

const load = (over: Record<string, unknown>) =>
  deserializeProject({ format: PROJECT_FORMAT, layers: [], ...over }, anyMedia).project;

test('campos ausentes caem em padrões utilizáveis', () => {
  const p = load({});
  assert.equal(p.width, 1920);
  assert.equal(p.height, 1080);
  assert.equal(p.fps, 30);
  assert.deepEqual(p.layers, []);
});

test('campos com tipo errado não contaminam a engine', () => {
  // Sem isso, um `width: "muito"` viraria NaN e o canvas inteiro sumiria.
  const p = load({ width: 'muito', fps: null, background: 42 });
  assert.equal(p.width, 1920);
  assert.equal(p.fps, 30);
  assert.equal(p.background, '#151021');
});

test('layers que não são objeto são descartadas', () => {
  assert.equal(load({ layers: [null, 'oi', 42] }).layers.length, 0);
});

test('layer de tipo desconhecido é descartada', () => {
  assert.equal(load({ layers: [{ type: 'audio', name: 'x' }] }).layers.length, 0);
});

test('track com prop inválida é jogada fora, o resto do efeito fica', () => {
  const p = load({
    layers: [{
      type: 'text', name: 'T',
      effects: [{
        duration: 1,
        tracks: [
          { prop: 'inventada', keys: [[0, 1]] },
          { prop: 'scale', keys: [[0, 0], [1, 1]] },
        ],
      }],
    }],
  });

  const tracks = p.layers[0]?.effects[0]?.tracks;
  assert.equal(tracks?.length, 1, 'só a válida sobrou');
  assert.equal(tracks?.[0]?.prop, 'scale');
});

test('efeito que fica sem nenhuma track válida é descartado', () => {
  const p = load({
    layers: [{ type: 'text', name: 'T', effects: [{ tracks: [{ prop: 'zzz', keys: [[0, 1]] }] }] }],
  });
  assert.deepEqual(p.layers[0]?.effects, []);
});

test('keys malformadas não passam', () => {
  const p = load({
    layers: [{
      type: 'text', name: 'T',
      effects: [{ tracks: [{ prop: 'x', keys: [['a', 'b'], [0, 5], [1]] }] }],
    }],
  });
  assert.deepEqual(p.layers[0]?.effects[0]?.tracks[0]?.keys, [[0, 5]], 'só o par numérico');
});

test('efeitos ausentes viram lista vazia, não undefined', () => {
  // `resolveState` itera isso todo quadro; undefined ali quebraria o render.
  assert.deepEqual(load({ layers: [{ type: 'text', name: 'T' }] }).layers[0]?.effects, []);
});

// --- quais mídias um projeto usa ----------------------------------------

test('mediaIdsOf lê os ids sem precisar resolver a mídia', () => {
  // Roda ANTES de carregar os arquivos, pra descartar os órfãos primeiro.
  const raw = serializeProject(project([
    textLayer(),
    videoLayer({ mediaId: 'a' }),
    imageLayer({ mediaId: 'b' }),
  ]));

  assert.deepEqual([...mediaIdsOf(raw)].sort(), ['a', 'b']);
});

test('mediaIdsOf não engasga com lixo', () => {
  assert.equal(mediaIdsOf(null).size, 0);
  assert.equal(mediaIdsOf('texto').size, 0);
  assert.equal(mediaIdsOf({ layers: 'nada disso' }).size, 0);
  assert.equal(mediaIdsOf({ layers: [null, {}, { mediaId: 42 }, { mediaId: '' }] }).size, 0);
});

// --- migração de formato ------------------------------------------------

test('projeto do formato 1 ganha faixas pelo índice do array', () => {
  // No formato 1 uma layer era uma faixa e a ordem do array era a de desenho,
  // então essa é a migração que preserva exatamente o que se via na tela.
  const antigo = {
    format: 1,
    width: 1920, height: 1080, fps: 30, background: '#000',
    layers: [
      { type: 'text', name: 'fundo', text: 'A' },
      { type: 'text', name: 'meio', text: 'B' },
      { type: 'text', name: 'frente', text: 'C' },
    ],
  };

  const { project: p } = deserializeProject(antigo, anyMedia);
  assert.deepEqual(p.layers.map(l => l.track), [0, 1, 2]);
  assert.equal(p.layers[2]?.name, 'frente', 'a última do array continua no topo');
});

test('a faixa salva vence o índice quando existe', () => {
  const { project: p } = deserializeProject({
    format: PROJECT_FORMAT,
    layers: [{ type: 'text', name: 'A', track: 4 }, { type: 'text', name: 'B', track: 4 }],
  }, anyMedia);

  assert.deepEqual(p.layers.map(l => l.track), [4, 4], 'duas layers dividem a faixa');
});

test('faixa inválida no arquivo não vira NaN circulando pela engine', () => {
  const { project: p } = deserializeProject({
    format: PROJECT_FORMAT,
    layers: [{ type: 'text', name: 'A', track: 'muito' }, { type: 'text', name: 'B', track: -3 }],
  }, anyMedia);

  assert.equal(p.layers[0]?.track, 0, 'cai no índice do array');
  assert.equal(p.layers[1]?.track, 0, 'negativa é presa em zero');
});

test('a faixa sobrevive à ida e volta', () => {
  const original = project([textLayer({ track: 3 }), textLayer({ id: 9, track: 3, start: 6 })]);
  const { project: back } = deserializeProject(serializeProject(original), anyMedia);
  assert.deepEqual(back.layers.map(l => l.track), [3, 3]);
});

// --- contorno e sombra do texto -----------------------------------------

test('contorno e sombra sobrevivem à ida e volta', () => {
  const layer = textLayer({
    stroke: '#112233', strokeWidth: 6, shadow: '#445566', shadowBlur: 9, shadowOffset: 3,
  });
  const { project: back } = deserializeProject(
    serializeProject(project([layer])), () => null,
  );
  const t = back.layers[0] as TextLayer;
  assert.equal(t.stroke, '#112233');
  assert.equal(t.strokeWidth, 6);
  assert.equal(t.shadow, '#445566');
  assert.equal(t.shadowBlur, 9);
  assert.equal(t.shadowOffset, 3);
});

test('projeto antigo abre com contorno e sombra desligados', () => {
  // É exatamente como ele já se desenhava — não há informação a recuperar.
  const antigo = serializeProject(project([textLayer()])) as unknown as {
    format: number; layers: Record<string, unknown>[];
  };
  antigo.format = 4;
  for (const l of antigo.layers) {
    delete l.stroke; delete l.strokeWidth;
    delete l.shadow; delete l.shadowBlur; delete l.shadowOffset;
  }

  const { project: back } = deserializeProject(antigo as never, () => null);
  const t = back.layers[0] as TextLayer;
  assert.equal(t.strokeWidth, 0, 'sem contorno');
  assert.equal(t.shadowBlur, 0, 'sem sombra');
  assert.equal(t.shadowOffset, 0);
  assert.ok(t.stroke.length > 0, 'mas com uma cor pronta pra quando você ligar');
});

test('largura de contorno negativa é recusada', () => {
  // `lineWidth` negativo é ignorado pelo canvas em silêncio — o texto sairia
  // sem contorno nenhum e ninguém saberia por quê.
  const ruim = serializeProject(project([textLayer()])) as unknown as {
    layers: Record<string, unknown>[];
  };
  (ruim.layers[0] as Record<string, unknown>).strokeWidth = -5;
  const { project: back } = deserializeProject(ruim as never, () => null);
  assert.equal((back.layers[0] as TextLayer).strokeWidth, 0);
});
