import test from 'node:test';
import assert from 'node:assert/strict';
import { clipDragPlan, flipOrder, moveItem } from '../src/engine/trackDrag.ts';

/** Um gesto parado: 100px por segundo, faixas de 28px, clipe de 2s em t=1. */
const base = {
  dx: 0, dy: 0,
  pxPerSecond: 100,
  trackPitch: 28,
  start: 1,
  row: 1,
  span: 2,
  duration: 10,
  lastRow: 3,
};

const drag = (over: Partial<typeof base> = {}) => clipDragPlan({ ...base, ...over });

// --- movimento no tempo -------------------------------------------------

test('parado, o plano é exatamente onde o clipe já está', () => {
  assert.deepEqual(drag(), { start: 1, row: 1 });
});

test('arrastar na horizontal converte pixel em segundo', () => {
  assert.equal(drag({ dx: 250 }).start, 3.5, '250px a 100px/s são 2.5s');
  assert.equal(drag({ dx: -50 }).start, 0.5);
});

test('o clipe não passa do começo da linha', () => {
  assert.equal(drag({ dx: -9999 }).start, 0);
});

test('o clipe não deixa a cauda sair pelo fim', () => {
  // Projeto de 10s, clipe de 2s: o começo dele para em 8s.
  assert.equal(drag({ dx: 9999 }).start, 8);
});

test('clipe maior que o projeto encosta em zero em vez de ir pra negativo', () => {
  assert.equal(drag({ span: 30, dx: 9999 }).start, 0);
});

test('sem escala, o clipe fica onde está em vez de saltar pra zero', () => {
  // Acontece de verdade: a régua ainda não foi medida (largura 0).
  assert.equal(drag({ pxPerSecond: 0, dx: 500 }).start, 1);
});

// --- troca de faixa -----------------------------------------------------

test('a faixa é discreta: encaixa na mais próxima, nunca no meio', () => {
  assert.equal(drag({ dy: 10 }).row, 1, 'menos de meia faixa não conta');
  assert.equal(drag({ dy: 15 }).row, 2, 'passou da metade, cai na de baixo');
  assert.equal(drag({ dy: 28 }).row, 2, 'uma faixa exata');
  assert.equal(drag({ dy: 56 }).row, 3, 'duas faixas');
});

test('arrastar pra cima sobe de faixa', () => {
  assert.equal(drag({ dy: -28 }).row, 0);
});

test('a faixa é limitada às que existem', () => {
  assert.equal(drag({ dy: -9999 }).row, 0, 'não sobe além da primeira');
  assert.equal(drag({ dy: 9999 }).row, 3, 'nem desce além da última');
});

test('as duas direções valem no mesmo gesto', () => {
  // É o ponto da feature: reposicionar no tempo e reordenar de uma vez só.
  assert.deepEqual(drag({ dx: 100, dy: 28 }), { start: 2, row: 2 });
});

test('com uma layer só não há pra onde trocar de faixa', () => {
  assert.equal(drag({ row: 0, lastRow: 0, dy: 999 }).row, 0);
});

// --- ordem de desenho vs. ordem visual ----------------------------------

test('flipOrder espelha a lista: o último a desenhar é a faixa de cima', () => {
  // 4 layers: layers[3] desenha por último (fica na frente) e por isso aparece
  // na faixa 0, a de cima.
  assert.equal(flipOrder(3, 4), 0);
  assert.equal(flipOrder(0, 4), 3);
});

test('flipOrder é a própria inversa', () => {
  // É o que permite uma função só pros dois sentidos, sem risco de trocá-las.
  for (const i of [0, 1, 2, 3]) assert.equal(flipOrder(flipOrder(i, 4), 4), i);
});

// --- reordenação --------------------------------------------------------

test('moveItem empurra o miolo em vez de trocar as pontas', () => {
  // Um swap devolveria [D,B,C,A] e embaralharia o que não foi arrastado.
  assert.deepEqual(moveItem(['A', 'B', 'C', 'D'], 0, 3), ['B', 'C', 'D', 'A']);
  assert.deepEqual(moveItem(['A', 'B', 'C', 'D'], 3, 0), ['D', 'A', 'B', 'C']);
});

test('moveItem para o vizinho troca só os dois', () => {
  assert.deepEqual(moveItem(['A', 'B', 'C'], 1, 2), ['A', 'C', 'B']);
});

test('moveItem no mesmo lugar não altera nada', () => {
  assert.deepEqual(moveItem(['A', 'B', 'C'], 1, 1), ['A', 'B', 'C']);
});

test('moveItem não muta a lista original', () => {
  const orig = ['A', 'B', 'C'];
  moveItem(orig, 0, 2);
  assert.deepEqual(orig, ['A', 'B', 'C'], 'o estado do React não pode ser mutado no lugar');
});

test('moveItem ignora índice de origem inexistente', () => {
  assert.deepEqual(moveItem(['A', 'B'], 5, 0), ['A', 'B']);
});

test('moveItem prende o destino dentro da lista', () => {
  assert.deepEqual(moveItem(['A', 'B', 'C'], 0, 99), ['B', 'C', 'A']);
});

// --- as duas peças juntas -----------------------------------------------

test('soltar na faixa de cima leva a layer pra frente de todas', () => {
  // O caminho completo: a faixa visual vira índice de desenho, e o índice de
  // desenho vira a nova ordem do projeto.
  const layers = ['fundo', 'meio', 'topo'];   // ordem de desenho
  const arrastada = 'fundo';

  const from = layers.indexOf(arrastada);              // 0
  const to = flipOrder(0, layers.length);              // faixa 0 -> índice 2
  assert.deepEqual(moveItem(layers, from, to), ['meio', 'topo', 'fundo']);
});
