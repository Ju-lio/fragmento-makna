/**
 * De quem é cada quadro da linha do tempo.
 *
 * A invariante que estes testes travam é simples de dizer e era falsa: **todo
 * quadro de uma faixa contínua tem exatamente um dono**. Não zero (buraco preto)
 * e não dois (o corte mostrando o clipe errado). Ver `timeSpan.ts` pro relato
 * do defeito.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { coversAt } from '../src/engine/timeSpan.ts';
import { frameIndexAt, lastFrameIndex, timeAtFrameIndex } from '../src/engine/frameCache.ts';
import { splitLayer } from '../src/engine/project.ts';
import { videoLayer } from './fixtures.ts';

const FPS = 30;

// --- a regra ------------------------------------------------------------

test('o trecho é meio-aberto: pega o começo, larga o fim', () => {
  const span = { start: 2, duration: 4 };

  assert.equal(coversAt(span, 1.999), false);
  assert.equal(coversAt(span, 2), true, 'o instante inicial é dele');
  assert.equal(coversAt(span, 5.999), true);
  assert.equal(coversAt(span, 6), false, 'o instante final já é do próximo');
});

// --- a invariante -------------------------------------------------------

/** Fatias encostadas, como um corte produz: fim de uma = começo da outra. */
function encostados(cortes: readonly number[]) {
  return cortes.slice(0, -1).map((start, i) => ({
    id: i + 1,
    start,
    duration: (cortes[i + 1] as number) - start,
  }));
}

test('todo quadro de uma faixa contínua tem EXATAMENTE um dono', () => {
  /**
   * O caso do usuário: cortes encostados, reorganizados. Sem a regra
   * meio-aberta, o quadro de cada emenda tinha dois donos — e qual deles ia
   * pra tela dependia da ordem do ARRAY, que num remix não é a ordem da linha
   * do tempo.
   */
  const clipes = encostados([0, 3, 3.5, 7, 7.2, 10]);
  const ultimo = frameIndexAt(10, FPS);

  for (let i = 0; i < ultimo; i++) {
    const t = timeAtFrameIndex(i, FPS);
    const donos = clipes.filter(c => coversAt(c, t));
    assert.equal(donos.length, 1, `o quadro ${i} (t=${t.toFixed(4)}) tem ${donos.length} donos`);
  }
});

test('cortar um clipe não duplica nem perde o quadro da emenda', () => {
  // O corte é o gesto que produz duas fatias encostadas. A soma das duas tem
  // que cobrir exatamente o que o clipe inteiro cobria — nem um quadro a mais.
  const inteiro = videoLayer({ start: 0, duration: 4, trimStart: 0, sourceDuration: 20 });

  const partes = splitLayer(inteiro, 1.5);
  assert.ok(partes, 'o corte em 1,5s é válido');
  const [esquerda, direita] = partes;

  for (let i = 0; i < frameIndexAt(4, FPS); i++) {
    const t = timeAtFrameIndex(i, FPS);
    const donos = [esquerda, direita].filter(p => coversAt(p, t));
    assert.equal(donos.length, 1, `o quadro ${i} ficou com ${donos.length} donos depois do corte`);
  }
});

test('um clipe de N segundos ocupa round(N × fps) quadros', () => {
  for (const [duracao, esperado] of [[3, 90], [0.2, 6], [1 / 3, 10]] as const) {
    const clipe = { start: 0, duration: duracao };
    let quadros = 0;
    for (let i = 0; i <= esperado + 5; i++) {
      if (coversAt(clipe, timeAtFrameIndex(i, FPS))) quadros++;
    }
    assert.equal(quadros, esperado, `${duracao}s a ${FPS}fps`);
  }
});

// --- o outro lado do mesmo off-by-one -----------------------------------

test('um projeto de 3s exporta 90 quadros, não 91', () => {
  /**
   * O erro espelhado: o export contava o quadro que começa em `to`, que já é o
   * primeiro do que vem DEPOIS do trecho. Um arquivo de 3,033s pra um projeto
   * de 3s. Não aparecia porque o clipe também contava a fronteira a mais e os
   * dois se cancelavam — motivo pelo qual as duas correções andam juntas.
   */
  const first = frameIndexAt(0, FPS);
  const last = lastFrameIndex(0, 3, FPS);

  assert.equal(last - first + 1, Math.round(3 * FPS));
});

test('o trecho exportado cobre os mesmos quadros que o clipe desenha', () => {
  // A prova de que os dois lados batem: nenhum quadro do export cai fora do
  // clipe (quadro preto no fim), e nenhum quadro do clipe fica sem ser gravado.
  const clipe = { start: 0, duration: 3 };
  const last = lastFrameIndex(0, 3, FPS);

  assert.equal(coversAt(clipe, timeAtFrameIndex(last, FPS)), true, 'o último gravado é do clipe');
  assert.equal(coversAt(clipe, timeAtFrameIndex(last + 1, FPS)), false, 'e não sobrou nenhum');
});

test('trecho vazio não produz contagem negativa', () => {
  // `from === to` acontece com IN e OUT no mesmo lugar. O piso existe pra que
  // quem chama receba 1 quadro, e não -1.
  assert.equal(lastFrameIndex(2, 2, FPS), frameIndexAt(2, FPS));
});
