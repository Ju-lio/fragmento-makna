import test from 'node:test';
import assert from 'node:assert/strict';
import { clipDragPlan, flipOrder } from '../src/engine/trackDrag.ts';
import type { Occupant } from '../src/engine/trackDrag.ts';

/** Um gesto parado: 100px por segundo, faixas de 28px, clipe de 2s em t=1. */
const base = {
  dx: 0, dy: 0,
  pxPerSecond: 100,
  trackPitch: 28,
  start: 1,
  track: 2,
  span: 2,
  duration: 10,
  maxTrack: 3,
  others: [] as Occupant[],
};

const drag = (over: Partial<typeof base> = {}) => clipDragPlan({ ...base, ...over });

// --- movimento no tempo -------------------------------------------------

test('parado, o plano é exatamente onde o clipe já está', () => {
  assert.deepEqual(drag(), { start: 1, track: 2, valid: true });
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
  assert.equal(drag({ dy: 10 }).track, 2, 'menos de meia faixa não conta');
  assert.equal(drag({ dy: 15 }).track, 3, 'passou da metade, muda');
  assert.equal(drag({ dy: 28 }).track, 3, 'uma faixa exata');
  assert.equal(drag({ dy: -28 }).track, 1);
});

test('a faixa é limitada às que aceitam o clipe', () => {
  assert.equal(drag({ dy: -9999 }).track, 0, 'não desce da faixa 0');
  assert.equal(drag({ dy: 9999 }).track, 3, 'nem passa da mais alta permitida');
});

test('as duas direções valem no mesmo gesto', () => {
  // É o ponto da feature: reposicionar no tempo e trocar de faixa de uma vez.
  assert.deepEqual(drag({ dx: 100, dy: 28 }), { start: 2, track: 3, valid: true });
});

// --- colisão ------------------------------------------------------------

const ocupante = (over: Partial<Occupant> = {}): Occupant =>
  ({ track: 2, start: 5, duration: 2, ...over });

test('cair em cima de outro clipe da mesma faixa é inválido', () => {
  // Sem isso, dois clipes ocupariam o mesmo instante e a faixa deixaria de
  // ter um dono por quadro — que é a invariante que sustenta a ordem de desenho.
  const plan = drag({ dx: 450, others: [ocupante()] });   // clipe vai pra 5.5..7.5
  assert.equal(plan.valid, false);
});

test('o mesmo lugar em outra faixa é livre', () => {
  const plan = drag({ dx: 450, dy: -28, others: [ocupante({ track: 2 })] });
  assert.equal(plan.track, 1);
  assert.equal(plan.valid, true, 'a colisão é por faixa, não por instante');
});

test('encostar exatamente na ponta do vizinho é válido', () => {
  // É o caso NORMAL: é o que um corte produz, e o que empilhar clipes exige.
  const vizinho = ocupante({ start: 3, duration: 2 });   // ocupa 3..5
  assert.equal(drag({ dx: 400, others: [vizinho] }).valid, true, 'clipe começa em 5');

  const antes = ocupante({ start: 3, duration: 2 });
  assert.equal(drag({ dx: 0, others: [antes] }).valid, true, 'clipe 1..3 encosta em 3');
});

test('sobreposição de um instante só já invalida', () => {
  const vizinho = ocupante({ start: 2.9, duration: 2 });
  assert.equal(drag({ dx: 0, others: [vizinho] }).valid, false, 'clipe 1..3 invade 2.9');
});

test('o plano de posição é calculado mesmo quando inválido', () => {
  // A interface precisa mostrar ONDE cairia pra explicar por que não pode.
  const plan = drag({ dx: 450, others: [ocupante()] });
  assert.equal(plan.start, 5.5);
  assert.equal(plan.track, 2);
  assert.equal(plan.valid, false);
});

// --- ordem de desenho vs. ordem visual ----------------------------------

test('flipOrder espelha: a faixa mais alta é a linha de cima', () => {
  // 4 linhas na tela (faixas 0..3): a faixa 3 desenha na frente e aparece em cima.
  assert.equal(flipOrder(3, 4), 0);
  assert.equal(flipOrder(0, 4), 3);
});

test('flipOrder é a própria inversa', () => {
  // É o que permite uma função só pros dois sentidos, sem risco de trocá-las.
  for (const i of [0, 1, 2, 3]) assert.equal(flipOrder(flipOrder(i, 4), 4), i);
});
