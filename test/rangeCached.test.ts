import test from 'node:test';
import assert from 'node:assert/strict';
import { isRangeCached } from '../src/engine/prerender.ts';
import { frameCache, signatureOf, frameIndexAt } from '../src/engine/frameCache.ts';

import { fakeBitmap, project as makeProject, textLayer } from './fixtures.ts';
import type { Project } from '../src/engine/types.ts';

const project = (): Project =>
  makeProject([textLayer({ size: 10 })], { width: 100, height: 100 });

interface FillOptions {
  /** Índice deixado de fora, pra simular um furo no trecho. */
  hole?: number | null;
  degraded?: boolean;
}

/** Preenche o cache do trecho, opcionalmente deixando um buraco. */
function fill(p: Project, from: number, to: number, { hole = null, degraded = false }: FillOptions = {}) {
  const sig = signatureOf(p);
  frameCache.clear();
  frameCache.signature = null;
  frameCache.useSignature(sig, 1);
  for (let i = frameIndexAt(from, p.fps); i <= frameIndexAt(to, p.fps); i++) {
    if (i === hole) continue;
    frameCache.set(sig, i, fakeBitmap(), 10, { degraded });
  }
}

test('trecho totalmente preenchido conta como pronto', () => {
  const p = project();
  fill(p, 0, 2);
  assert.equal(isRangeCached(p, { from: 0, to: 2 }), true);
});

test('um único buraco no meio já reprova o trecho', () => {
  // É esse buraco que causa o engasgo na reprodução — não pode passar batido.
  const p = project();
  fill(p, 0, 2, { hole: frameIndexAt(1, p.fps) });
  assert.equal(isRangeCached(p, { from: 0, to: 2 }), false);
});

test('frames simplificados não contam como prontos', () => {
  // Foram capturados durante a reprodução com o desfoque pulado: reproduzir a
  // partir deles seria liso, mas não fiel.
  const p = project();
  fill(p, 0, 2, { degraded: true });
  assert.equal(isRangeCached(p, { from: 0, to: 2 }), false);
});

test('cache de outro projeto não vale', () => {
  const p = project();
  fill(p, 0, 2);
  const outro = makeProject([textLayer({ size: 10, text: 'MUDOU' })], { width: 100, height: 100 });
  assert.equal(isRangeCached(outro, { from: 0, to: 2 }), false);
});

test('pedir um trecho maior que o preenchido reprova', () => {
  const p = project();
  fill(p, 0, 2);
  assert.equal(isRangeCached(p, { from: 0, to: 3 }), false, 'a cauda não está pronta');
});

test('um sub-trecho do que foi preenchido é aprovado', () => {
  const p = project();
  fill(p, 0, 4);
  assert.equal(isRangeCached(p, { from: 1, to: 2 }), true);
});
