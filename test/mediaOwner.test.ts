import test from 'node:test';
import assert from 'node:assert/strict';
import { ownersByElement } from '../src/engine/mediaOwner.ts';

/**
 * O caso que originou tudo: um clipe cortado ao meio. As duas metades apontam
 * pro mesmo elemento, e o critério de "em uso" é não estarem no mesmo instante.
 */
interface Falsa { id: string; el: object | null; ativa: boolean }

/** As duas metades apontam pro MESMO elemento — é o que o spread do split faz. */
const elemento = { nome: '<audio> da musica' };
const metades: Falsa[] = [
  { id: 'a', el: elemento, ativa: true },
  { id: 'b', el: elemento, ativa: false },
];

const donos = (layers: readonly Falsa[], inUse: (l: Falsa) => boolean = l => l.ativa) =>
  ownersByElement(layers, l => l.el, inUse);

test('um dono por elemento, não por layer', () => {
  assert.equal(donos(metades).length, 1);
});

test('quem está em uso ganha, mesmo vindo antes na lista', () => {
  // O bug: quem vinha depois escrevia por último e ganhava sempre — então a
  // metade inativa pausava o elemento que a ativa tinha acabado de soltar.
  assert.equal(donos(metades)[0]?.id, 'a');
});

test('sem ninguém em uso ainda sobra um dono', () => {
  // De propósito: o plano dele é parar o elemento. Sem dono nenhum, o elemento
  // continuaria rolando depois do fim do último clipe.
  const r = donos(metades, () => false);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.id, 'a', 'o primeiro da lista');
});

test('entre dois em uso, vence o último — que é o que está por cima', () => {
  const r = donos(metades.map(l => ({ ...l, ativa: true })));
  assert.equal(r.length, 1);
  assert.equal(r[0]?.id, 'b');
});

test('elementos diferentes não disputam nada', () => {
  const r = donos([
    { id: 'a', el: { n: 1 }, ativa: false },
    { id: 'b', el: { n: 2 }, ativa: false },
  ]);
  assert.deepEqual(r.map(l => l.id), ['a', 'b']);
});

test('lista vazia devolve lista vazia', () => {
  assert.deepEqual(donos([]), []);
});

test('layer sem elemento não disputa nada', () => {
  // Sem elemento não há cursor pra disputar — e ela não conduz coisa alguma.
  assert.deepEqual(donos([{ id: 'a', el: null, ativa: true }]), []);
});

test('mesmo arquivo em elementos DIFERENTES não se calam', () => {
  // É o caso de destacar o áudio de um clipe: as duas layers apontam pro mesmo
  // `mediaId`, mas para um `<video>` e um `<audio>` distintos. Agrupar por
  // arquivo faria uma calar a outra — o bug do clipe cortado pelo outro lado.
  const r = donos([
    { id: 'video', el: { n: 'v' }, ativa: true },
    { id: 'audio', el: { n: 'a' }, ativa: true },
  ]);
  assert.deepEqual(r.map(l => l.id), ['video', 'audio']);
});

test('a ordem de saída segue a primeira aparição de cada elemento', () => {
  // Não muda comportamento — é pra que a lista seja legível e comparável.
  const x = { n: 'x' };
  const r = donos([
    { id: 'a', el: x, ativa: false },
    { id: 'b', el: { n: 'y' }, ativa: false },
    { id: 'c', el: x, ativa: true },
  ]);
  assert.deepEqual(r.map(l => l.id), ['c', 'b']);
});
