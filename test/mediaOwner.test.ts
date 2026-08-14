import test from 'node:test';
import assert from 'node:assert/strict';
import { ownersByMedia } from '../src/engine/mediaOwner.ts';

/**
 * O caso que originou tudo: um clipe cortado ao meio. As duas metades apontam
 * pro mesmo elemento, e o critério de "em uso" é não estarem no mesmo instante.
 */
const metades = [
  { id: 'a', mediaId: 'musica', ativa: true },
  { id: 'b', mediaId: 'musica', ativa: false },
];

test('um dono por arquivo, não por layer', () => {
  assert.equal(ownersByMedia(metades, l => l.ativa).length, 1);
});

test('quem está em uso ganha, mesmo vindo antes na lista', () => {
  // O bug: quem vinha depois escrevia por último e ganhava sempre — então a
  // metade inativa pausava o elemento que a ativa tinha acabado de soltar.
  assert.equal(ownersByMedia(metades, l => l.ativa)[0]?.id, 'a');
});

test('sem ninguém em uso ainda sobra um dono', () => {
  // De propósito: o plano dele é parar o elemento. Sem dono nenhum, o elemento
  // continuaria rolando depois do fim do último clipe.
  const donos = ownersByMedia(metades, () => false);
  assert.equal(donos.length, 1);
  assert.equal(donos[0]?.id, 'a', 'o primeiro da lista');
});

test('entre dois em uso, vence o último — que é o que está por cima', () => {
  const donos = ownersByMedia(metades.map(l => ({ ...l, ativa: true })), l => l.ativa);
  assert.equal(donos.length, 1);
  assert.equal(donos[0]?.id, 'b');
});

test('arquivos diferentes não disputam nada', () => {
  const donos = ownersByMedia([
    { id: 'a', mediaId: 'musica', ativa: false },
    { id: 'b', mediaId: 'clipe', ativa: false },
  ], l => l.ativa);
  assert.deepEqual(donos.map(l => l.id), ['a', 'b']);
});

test('lista vazia devolve lista vazia', () => {
  assert.deepEqual(ownersByMedia([] as { mediaId: string }[], () => true), []);
});

test('a ordem de saída segue a primeira aparição de cada arquivo', () => {
  // Não muda comportamento — é pra que a lista seja legível e comparável.
  const donos = ownersByMedia([
    { id: 'a', mediaId: 'x', ativa: false },
    { id: 'b', mediaId: 'y', ativa: false },
    { id: 'c', mediaId: 'x', ativa: true },
  ], l => l.ativa);
  assert.deepEqual(donos.map(l => l.id), ['c', 'b']);
});
