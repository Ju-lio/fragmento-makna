import test from 'node:test';
import assert from 'node:assert/strict';
import { applySelection, rangeOnTrack } from '../src/engine/selection.ts';
import { textLayer, audioLayer } from './fixtures.ts';
import type { Layer } from '../src/engine/types.ts';

/** Três textos na MESMA faixa, encostados no tempo — o caso do SHIFT. */
const tresNaFaixa = (): Layer[] => [
  textLayer({ id: 1, track: 1, start: 0, duration: 2 }),
  textLayer({ id: 2, track: 1, start: 2, duration: 2 }),
  textLayer({ id: 3, track: 1, start: 4, duration: 2 }),
];

test('replace seleciona só o clicado', () => {
  assert.deepEqual(applySelection([1, 2], 3, 'replace', tresNaFaixa()), [3]);
});

test('replace com null desseleciona tudo', () => {
  assert.deepEqual(applySelection([1, 2], null, 'replace', tresNaFaixa()), []);
});

test('toggle adiciona o clicado ao fim (vira principal)', () => {
  assert.deepEqual(applySelection([1], 2, 'toggle', tresNaFaixa()), [1, 2]);
});

test('toggle remove o clicado sem reordenar o resto', () => {
  assert.deepEqual(applySelection([1, 2, 3], 2, 'toggle', tresNaFaixa()), [1, 3]);
});

test('toggle com null não mexe na seleção', () => {
  assert.deepEqual(applySelection([1, 2], null, 'toggle', tresNaFaixa()), [1, 2]);
});

test('range seleciona o trecho contíguo na mesma faixa, clicado por último', () => {
  // Âncora no começo, clicado no fim: os três entram, e o 3 vira principal.
  assert.deepEqual(applySelection([1], 3, 'range', tresNaFaixa()), [1, 2, 3]);
});

test('range também funciona de trás pra frente', () => {
  assert.deepEqual(applySelection([3], 1, 'range', tresNaFaixa()), [2, 3, 1]);
});

test('range troca o trecho, não acumula com a seleção anterior', () => {
  assert.deepEqual(applySelection([9, 1], 2, 'range', tresNaFaixa()), [1, 2]);
});

test('range sem âncora seleciona só o clicado', () => {
  assert.deepEqual(applySelection([], 2, 'range', tresNaFaixa()), [2]);
});

test('range com clicado igual à âncora seleciona só ele', () => {
  assert.deepEqual(applySelection([2], 2, 'range', tresNaFaixa()), [2]);
});

test('range entre faixas diferentes seleciona só o clicado', () => {
  const layers = [...tresNaFaixa(), textLayer({ id: 9, track: 2, start: 0, duration: 2 })];
  assert.deepEqual(applySelection([1], 9, 'range', layers), [9]);
});

test('range entre espaços diferentes não existe: faixa 1 de vídeo ≠ faixa 1 de áudio', () => {
  const layers = [...tresNaFaixa(), audioLayer({ id: 5, track: 1, start: 0, duration: 2 })];
  assert.deepEqual(applySelection([1], 5, 'range', layers), [5]);
});

test('rangeOnTrack devolve null quando não há trecho a desenhar', () => {
  assert.equal(rangeOnTrack(1, 99, tresNaFaixa()), null, 'clicado inexistente');
  assert.equal(rangeOnTrack(99, 1, tresNaFaixa()), null, 'âncora inexistente');
  const outraFaixa = [...tresNaFaixa(), textLayer({ id: 9, track: 2, start: 0, duration: 2 })];
  assert.equal(rangeOnTrack(1, 9, outraFaixa), null, 'faixas diferentes');
});
