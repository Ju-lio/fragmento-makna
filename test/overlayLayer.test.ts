import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeProject, deserializeProject, mediaIdsOf, PROJECT_FORMAT } from '../src/engine/serialize.ts';
import { renderSignature } from '../src/engine/frameCache.ts';
import { makeOverlayLayer, semArquivo, drawOrder, trackKind } from '../src/engine/project.ts';
import { layerBox } from '../src/engine/gizmo.ts';
import { project, textLayer, videoLayer, fakeVideo } from './fixtures.ts';
import type { OverlayLayer } from '../src/engine/types.ts';

const overlay = (o: Partial<OverlayLayer> = {}) => makeOverlayLayer({
  id: 42,
  name: 'Raio',
  html: '<div class="raio"></div>',
  css: '.raio{filter:drop-shadow(0 0 8px var(--p-cor))}',
  schema: { cor: { tipo: 'cor', padrao: '#4a7cff' } },
  values: { cor: '#ff0000' },
  ...o,
});

const anyMedia = () => fakeVideo();

// --- o modelo -----------------------------------------------------------

test('um overlay nasce sem efeitos de transformação', () => {
  // A layer de texto nasce com `fade-up`; o overlay não. Ele já traz a própria
  // animação em @keyframes, e empilhar um fade por cima seria o editor
  // discordando do autor na criação.
  assert.deepEqual(makeOverlayLayer().effects, []);
});

test('overlay divide espaço de faixa com as visuais, não com áudio', () => {
  assert.equal(trackKind(overlay()), 'visual');
});

test('overlay entra na ordem de desenho', () => {
  const p = project([textLayer({ track: 0 }), overlay({ track: 1 })]);
  assert.deepEqual(drawOrder(p).map(l => l.type), ['text', 'overlay']);
});

test('semArquivo cobre texto E overlay', () => {
  // A pergunta existe pra ser feita num lugar só: antes, quem varria layers
  // atrás de mediaId escrevia `type !== 'text'`, o que virou armadilha no dia
  // em que o overlay entrou.
  assert.equal(semArquivo(overlay()), true);
  assert.equal(semArquivo(textLayer()), true);
  assert.equal(semArquivo(videoLayer()), false);
});

test('a moldura do overlay é a composição inteira', () => {
  const p = project([overlay()]);
  const box = layerBox(overlay(), p, () => 0, 0);
  assert.deepEqual(box, { w: p.width, h: p.height });
});

// --- ida e volta --------------------------------------------------------

test('o pacote inteiro sobrevive à ida e volta', () => {
  const original = project([overlay()]);
  const { project: back, missingMedia } = deserializeProject(serializeProject(original), anyMedia);
  assert.deepEqual(back.layers, original.layers);
  assert.deepEqual(missingMedia, []);
});

test('o overlay NÃO vira mídia fantasma no acervo', () => {
  // `readMedia` pulava só `text` e depois lia `mediaId`. Um overlay caía ali e
  // registrava um asset de id vazio.
  const raw = serializeProject(project([overlay()]));
  assert.deepEqual([...mediaIdsOf(raw)], []);
  const { project: back } = deserializeProject(raw, anyMedia);
  assert.deepEqual(back.media, []);
});

test('overlay e vídeo convivem no mesmo projeto', () => {
  const original = project([videoLayer({ mediaId: 'abc' }), overlay({ track: 1 })]);
  const raw = serializeProject(original);
  assert.deepEqual([...mediaIdsOf(raw)], ['abc'], 'só o vídeo aparece no acervo');
  const { project: back } = deserializeProject(raw, anyMedia);
  assert.equal(back.layers.length, 2);
});

test('nenhum blob: nem elemento de DOM vaza pro arquivo', () => {
  const raw = JSON.stringify(serializeProject(project([overlay()])));
  assert.equal(raw.includes('blob:'), false);
  assert.equal(raw.includes('[object'), false);
});

test('o formato do projeto subiu', () => {
  assert.equal(PROJECT_FORMAT, 8);
});

// --- entrada malformada -------------------------------------------------

test('schema inválido não descarta a layer — só os controles', () => {
  // Perder o efeito inteiro por causa de um descritor errado seria pior que
  // ficar sem os campos: o CSS não precisa do schema pra desenhar.
  const raw = serializeProject(project([overlay()]));
  (raw.layers[0] as { schema: unknown }).schema = { 'nome invalido': { tipo: 'num', padrao: 1 } };
  const { project: back } = deserializeProject(raw, anyMedia);
  const l = back.layers[0] as OverlayLayer;
  assert.equal(l.type, 'overlay');
  assert.equal(l.css.length > 0, true, 'o CSS continua lá');
  assert.deepEqual(l.schema, {}, 'o schema quebrado virou vazio');
});

test('campos ausentes viram vazio em vez de derrubar a abertura', () => {
  const raw = serializeProject(project([overlay()]));
  const cru = raw.layers[0] as Record<string, unknown>;
  delete cru.html; delete cru.css; delete cru.values; delete cru.schema;
  const { project: back } = deserializeProject(raw, anyMedia);
  const l = back.layers[0] as OverlayLayer;
  assert.deepEqual([l.html, l.css, l.schema, l.values], ['', '', {}, {}]);
});

// --- assinatura do cache ------------------------------------------------

test('editar o CSS invalida os quadros guardados', () => {
  // O modo de falha mais desagradável de um cache: a tela mostrar uma coisa e
  // o arquivo salvo ter outra.
  const a = renderSignature(project([overlay()]));
  const b = renderSignature(project([overlay({ css: '.raio{opacity:.5}' })]));
  assert.notEqual(a, b);
});

test('editar o HTML invalida', () => {
  const a = renderSignature(project([overlay()]));
  const b = renderSignature(project([overlay({ html: '<div class="outro"></div>' })]));
  assert.notEqual(a, b);
});

test('mexer num controle invalida', () => {
  const a = renderSignature(project([overlay()]));
  const b = renderSignature(project([overlay({ values: { cor: '#00ff00' } })]));
  assert.notEqual(a, b);
});

test('mudar o NOME não invalida — nome não desenha pixel', () => {
  const a = renderSignature(project([overlay()]));
  const b = renderSignature(project([overlay({ name: 'Outro nome' })]));
  assert.equal(a, b);
});

test('o schema sozinho não invalida — ele descreve o painel, não o desenho', () => {
  const a = renderSignature(project([overlay()]));
  const b = renderSignature(project([overlay({
    schema: { cor: { tipo: 'cor', padrao: '#4a7cff', rotulo: 'Cor do raio' } },
  })]));
  assert.equal(a, b);
});
