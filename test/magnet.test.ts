/**
 * O ímã da timeline.
 *
 * O teste que carrega este arquivo é o do encaixe: grudar o fim de um clipe no
 * início do vizinho tem que produzir um pouso VÁLIDO. Um ímã que gruda e
 * colide é pior que ímã nenhum — ele recusa o gesto exatamente onde o usuário
 * mirou, e a interface não tem como explicar por quê.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { magnetize, magnetTargets } from '../src/engine/magnet.ts';
import { overlaps } from '../src/engine/project.ts';
import { clipDragPlan } from '../src/engine/trackDrag.ts';

test('perto do alvo, gruda; longe, não encosta', () => {
  const alvos = [2];
  assert.equal(magnetize({ start: 1.98, span: 1, targets: alvos, radius: 0.05 }).start, 2);
  assert.equal(magnetize({ start: 1.8, span: 1, targets: alvos, radius: 0.05 }).start, 1.8);
});

test('a borda FINAL também atrai — é o gesto de emendar dois cortes', () => {
  // Clipe de 1s querendo terminar em 2,0: o início tem que ir pra 1,0.
  const r = magnetize({ start: 1.02, span: 1, targets: [2], radius: 0.05 });
  assert.equal(r.start, 1);
  assert.equal(r.edge, 'end');
  assert.equal(r.snappedTo, 2);
});

test('entre duas bordas, vence a mais próxima', () => {
  // Início a 0,03 de 1,0; fim a 0,01 de 3,0. Ganha o fim.
  const r = magnetize({ start: 1.03, span: 1.96, targets: [1, 3], radius: 0.05 });
  assert.equal(r.edge, 'end');
  assert.equal(r.start, +(3 - 1.96).toFixed(3));
});

test('raio zero desliga o ímã — é como se segura o clipe onde ele está', () => {
  const r = magnetize({ start: 1.98, span: 1, targets: [2], radius: 0 });
  assert.equal(r.start, 1.98);
  assert.equal(r.snappedTo, null);
});

test('grudar o fim nunca joga o clipe pra antes do zero', () => {
  // Clipe de 5s cujo fim é atraído por 2,0: o início daria -3.
  const r = magnetize({ start: 0.02, span: 5, targets: [2], radius: 3 });
  assert.ok(r.start >= 0, `start=${r.start}`);
});

test('o resultado pousa na grade de milissegundos', () => {
  const r = magnetize({ start: 1.0000000001, span: 1 / 3, targets: [2], radius: 0.7 });
  assert.equal(r.start, +r.start.toFixed(3));
});

// --- o que faz o ímã valer a pena -----------------------------------------

test('ENCAIXE: grudado no vizinho, o pouso é válido, não colisão', () => {
  /**
   * O modo de falha que este arquivo existe pra impedir. O ímã leva o fim do
   * clipe até o início do vizinho; se o resultado saísse um fio adiante, o
   * `overlaps` acusaria invasão e o arrasto seria RECUSADO no ponto exato em
   * que o usuário mirou. Ver `overlaps` — a comparação é na grade, e é por isso
   * que o ímã arredonda.
   */
  const vizinho = { start: 2, duration: 2 };
  const arrastado = magnetize({ start: 1.03, span: 1, targets: magnetTargets([vizinho]), radius: 0.05 });

  assert.equal(arrastado.start, 1);
  assert.equal(
    overlaps({ start: arrastado.start, duration: 1 }, vizinho), false,
    'encostar não pode ser invadir',
  );
});

test('encaixe pelo outro lado: começar exatamente onde o vizinho acaba', () => {
  const vizinho = { start: 0, duration: 2 };
  const r = magnetize({ start: 1.97, span: 1, targets: magnetTargets([vizinho]), radius: 0.05 });

  assert.equal(r.start, 2);
  assert.equal(overlaps({ start: r.start, duration: 1 }, vizinho), false);
});

// --- os alvos --------------------------------------------------------------

test('os alvos são as duas bordas de cada vizinho, mais os extras', () => {
  const alvos = magnetTargets(
    [{ start: 1, duration: 2 }, { start: 5, duration: 1 }],
    [0, 4.2],
  );
  assert.deepEqual(alvos, [0, 1, 3, 4.2, 5, 6]);
});

test('bordas repetidas contam uma vez só', () => {
  // Dois clipes encostados compartilham a borda. Duplicá-la não muda nada, mas
  // suja o plano e o teste.
  const alvos = magnetTargets([{ start: 0, duration: 2 }, { start: 2, duration: 2 }]);
  assert.deepEqual(alvos, [0, 2, 4]);
});

// --- dentro do arrasto -----------------------------------------------------

const base = {
  dy: 0, pxPerSecond: 100, trackPitch: 40, track: 0,
  span: 1, duration: 10, maxTrack: 2, others: [],
};

test('o arrasto usa o ímã e encosta no vizinho', () => {
  const vizinho = { start: 2, duration: 2, track: 0 };
  const plano = clipDragPlan({
    ...base,
    start: 0, dx: 103,            // 1,03s a 100px/s
    others: [vizinho],
    magnet: { targets: magnetTargets([vizinho]), radius: 0.05 },
  });

  assert.equal(plano.start, 1, 'devia ter grudado o fim em 2,0');
  assert.equal(plano.valid, true, 'encostado é válido');
});

test('sem ímã, o mesmo gesto pousa torto — é a diferença que ele faz', () => {
  const plano = clipDragPlan({ ...base, start: 0, dx: 103 });
  assert.equal(plano.start, 1.03);
});

test('o ímã não empurra o clipe pra cima de quem já está lá', () => {
  // Grudar não pode virar invadir nem quando o alvo é a borda ERRADA: um alvo
  // dentro do vizinho continua produzindo colisão, e o plano tem que dizer.
  const vizinho = { start: 1, duration: 2, track: 0 };
  const plano = clipDragPlan({
    ...base,
    start: 0, dx: 150,
    others: [vizinho],
    magnet: { targets: [1.5], radius: 0.2 },
  });

  assert.equal(plano.valid, false);
});
