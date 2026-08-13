import test from 'node:test';
import assert from 'node:assert/strict';
import { player } from '../src/engine/player.ts';

/** O player é singleton; cada teste começa do zero. */
function reset(duration = 10) {
  player.duration = duration;
  player.t = 0;
  player.clearRange();
}

test('sem marcação, o trecho é o projeto inteiro', () => {
  reset(10);
  assert.deepEqual(player.effectiveRange(), { from: 0, to: 10 });
  assert.equal(player.hasRange, false);
});

test('marcar só o início vai daquele ponto até o fim', () => {
  reset(10);
  player.markIn(3);
  assert.deepEqual(player.effectiveRange(), { from: 3, to: 10 });
  assert.equal(player.hasRange, true);
});

test('marcar só o fim vai do começo até ali', () => {
  reset(10);
  player.markOut(4);
  assert.deepEqual(player.effectiveRange(), { from: 0, to: 4 });
});

test('marcar os dois delimita o trecho', () => {
  reset(10);
  player.markIn(2);
  player.markOut(6);
  assert.deepEqual(player.effectiveRange(), { from: 2, to: 6 });
});

test('marcar o início depois do fim solta o fim em vez de inverter', () => {
  reset(10);
  player.markOut(3);
  player.markIn(7);   // inválido como par: o início ficaria depois do fim
  assert.deepEqual(player.effectiveRange(), { from: 7, to: 10 }, 'vale a marcação nova');
});

test('marcar o fim antes do início solta o início', () => {
  reset(10);
  player.markIn(7);
  player.markOut(3);
  assert.deepEqual(player.effectiveRange(), { from: 0, to: 3 });
});

test('marcações são presas aos limites do projeto', () => {
  reset(10);
  player.markIn(-5);
  assert.equal(player.rangeIn, 0, 'não existe tempo negativo');

  player.clearRange();
  player.markOut(999);
  assert.equal(player.rangeOut, 10, 'nem além da duração');
});

test('limpar volta ao projeto inteiro', () => {
  reset(10);
  player.markIn(2);
  player.markOut(6);
  player.clearRange();
  assert.equal(player.hasRange, false);
  assert.deepEqual(player.effectiveRange(), { from: 0, to: 10 });
});

test('marcar usa a posição atual do cursor por padrão', () => {
  reset(10);
  player.t = 4.5;
  player.markIn();
  assert.equal(player.rangeIn, 4.5);
});
