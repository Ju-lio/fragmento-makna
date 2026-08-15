/**
 * Runtime tests for the effect engine — run with `npm test`.
 * No framework: node's built-in runner, so there is nothing to install and
 * nothing to keep up to date.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EASE } from '../src/engine/easings.ts';
import { projectDuration, rulerDuration, MIN_PROJECT } from '../src/engine/project.ts';
import { textLayer } from './fixtures.ts';
import {
  sampleTrack,
  effectProgress,
  resolveState,
  validateEffect,
} from '../src/engine/effects.ts';
import type { Effect, Track } from '../src/engine/types.ts';
import { effect } from './fixtures.ts';

const near = (a: number | null, b: number, msg: string) => {
  assert.ok(a !== null, `${msg}: era pra ter valor, veio null`);
  assert.ok(Math.abs(a - b) < 1e-6, `${msg} (${a} vs ${b})`);
};

/** `validateEffect` devolve null quando passa; nos casos de erro queremos a string. */
const problem = (eff: unknown): string => validateEffect(eff) ?? '(sem problema)';

test('sampleTrack clamps outside the key range', () => {
  const tr: Track = { prop: 'y', keys: [[0, 60], [1, 0]], ease: 'linear' };
  near(sampleTrack(tr, -0.5), 60, 'before first key');
  near(sampleTrack(tr, 0.5), 30, 'linear midpoint');
  near(sampleTrack(tr, 2), 0, 'after last key');
});

test('sampleTrack interpolates across multiple segments', () => {
  const tr: Track = { prop: 'scale', keys: [[0, 0.6], [0.55, 1.06], [1, 1]], ease: 'linear' };
  near(sampleTrack(tr, 0.55), 1.06, 'lands on the middle key');
  near(sampleTrack(tr, 0.275), 0.83, 'midpoint of first segment');
});

test('easing is applied per segment, not globally', () => {
  const tr: Track = { prop: 'x', keys: [[0, 0], [1, 100]], ease: 'outQuint' };
  const v = sampleTrack(tr, 0.5);
  assert.ok(v !== null && v > 90 && v < 99, `outQuint should decelerate hard, got ${v}`);
});

test('every easing is continuous from 0 to 1', () => {
  for (const [name, fn] of Object.entries(EASE)) {
    near(fn(0), 0, `${name}(0)`);
    near(fn(1), 1, `${name}(1)`);
  }
});

test('effectProgress: anchor start, delay and hold', () => {
  const layer = { start: 2, duration: 4 };
  near(effectProgress(effect({ duration: 1 }), layer, 2), 0, 'begins at layer start');
  near(effectProgress(effect({ duration: 1 }), layer, 2.5), 0.5, 'halfway');
  near(effectProgress(effect({ duration: 1 }), layer, 5), 1, 'holds after finishing');
  near(effectProgress(effect({ duration: 1, delay: 0.5 }), layer, 3), 0.5, 'delay shifts start');
});

test('effectProgress: anchor end runs against the layer tail', () => {
  const layer = { start: 2, duration: 4 };   // ends at t=6
  const eff = effect({ duration: 1, anchor: 'end' });
  near(effectProgress(eff, layer, 5), 0, 'starts one second before the end');
  near(effectProgress(eff, layer, 6), 1, 'finishes exactly at layer end');
  assert.equal(effectProgress(eff, layer, 4), null, 'inactive before its window');
});

test('effectProgress: loop wraps forever', () => {
  const layer = { start: 2, duration: 4 };
  near(effectProgress(effect({ duration: 2, loop: true }), layer, 5), 0.5, 't=5 is 3s in, 3%2=1 -> 0.5');
});

test('resolveState composes: x adds, scale multiplies', () => {
  const effects: Effect[] = [
      { duration: 1, tracks: [
        { prop: 'x', keys: [[0, -40], [1, -40]] },
        { prop: 'scale', keys: [[0, 2], [1, 2]] },
      ] },
      { duration: 1, tracks: [
        { prop: 'scale', keys: [[0, 3], [1, 3]] },
        { prop: 'opacity', keys: [[0, 0.5], [1, 0.5]] },
      ] },
  ];
  const st = resolveState({ start: 0, duration: 5, x: 100, y: 0, effects }, 0.5);
  near(st.x, 60, 'x adds onto the base position');
  near(st.scale, 6, 'scale multiplies across both effects');
  near(st.opacity, 0.5, 'opacity multiplies the base');
  near(st.blur, 0, 'untouched props keep their base value');
});

test('validateEffect rejects malformed effects', () => {
  assert.equal(validateEffect({ tracks: [{ prop: 'scale', keys: [[0, 1]] }] }), null, 'valid passes');
  assert.match(problem({}), /tracks/, 'missing tracks');
  assert.match(
    problem({ tracks: [{ prop: 'nope', keys: [[0, 1]] }] }),
    /prop inválida/,
    'unknown prop',
  );
  assert.match(
    problem({ tracks: [{ prop: 'scale', keys: [[0, 1]], ease: 'wat' }] }),
    /ease desconhecido/,
    'unknown ease',
  );
  assert.match(
    problem({ tracks: [{ prop: 'scale', keys: ['bad'] }] }),
    /key inválida/,
    'malformed key',
  );
});

// --- duração do projeto -------------------------------------------------

test('a duração vai até o fim do último clipe', () => {
  // Era um campo digitado, e clipe que passasse do número saía cortado do
  // export sem nada avisar.
  assert.equal(projectDuration([
    textLayer({ start: 0, duration: 4 }),
    textLayer({ start: 8, duration: 4.5 }),
  ]), 12.5);
});

test('o clipe mais longo não precisa ser o último da lista', () => {
  assert.equal(projectDuration([
    textLayer({ start: 20, duration: 2 }),
    textLayer({ start: 0, duration: 1 }),
  ]), 22);
});

test('projeto vazio ainda tem régua', () => {
  // Sem piso não haveria onde soltar o primeiro clipe.
  assert.equal(projectDuration([]), MIN_PROJECT);
});

test('conteúdo minúsculo não encolhe a régua abaixo do piso', () => {
  assert.equal(projectDuration([textLayer({ start: 0, duration: 0.2 })]), MIN_PROJECT);
});

test('a régua da timeline é mais longa que o projeto', () => {
  // Sem a pista, a duração derivada vira armadilha circular: o arrasto prende o
  // clipe dentro da duração, e a duração vem dos clipes.
  const layers = [textLayer({ start: 0, duration: 10 })];
  assert.ok(rulerDuration(layers) > projectDuration(layers));
});

test('a pista é proporcional, com piso e teto', () => {
  // Fixa, sufocava projeto curto e sumia em projeto longo.
  const pista = (segundos: number) => {
    const layers = [textLayer({ start: 0, duration: segundos })];
    return +(rulerDuration(layers) - projectDuration(layers)).toFixed(3);
  };
  assert.equal(pista(2), 1, 'piso de 1s');
  assert.equal(pista(20), 3, '15% no meio da faixa');
  assert.equal(pista(300), 5, 'teto de 5s');
});
