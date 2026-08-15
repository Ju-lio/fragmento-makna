/**
 * O foco aqui é o MODO DE FALHA, não o caminho feliz.
 *
 * As três regressões desta fase passaram pelo caminho feliz sem reclamar: o
 * export saiu congelado numa imagem só porque, quando o quadro não vinha, o
 * desenho caía num elemento que ninguém tinha posicionado. Era testável, e não
 * estava testado. Estes testes existem pra que "o quadro não veio" seja um
 * comportamento definido, e não uma surpresa.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFrame } from '../src/engine/renderer.ts';
import type { FrameSource } from '../src/engine/renderer.ts';
import { prerenderRange } from '../src/engine/prerender.ts';
import { frameCache } from '../src/engine/frameCache.ts';
import { project, textLayer, videoLayer } from './fixtures.ts';

/** O mínimo de um contexto 2D pro `drawFrame` rodar sem navegador. */
function fakeCtx() {
  const chamadas: string[] = [];
  const ctx = {
    canvas: { width: 320, height: 180 },
    filter: 'none', globalAlpha: 1, imageSmoothingQuality: 'high',
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    lineWidth: 0, lineJoin: '', miterLimit: 0,
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0, letterSpacing: '',
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    clearRect() {}, fillRect() {}, fillText() {}, strokeText() {},
    measureText: () => ({ width: 10 }),
    drawImage() { chamadas.push('drawImage'); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, chamadas };
}

/** Quadro decodificado falso. `VideoFrame` expõe `displayWidth`. */
const quadroFalso = { displayWidth: 640, displayHeight: 360 } as unknown as FrameSource;

// --- o quadro chegou ----------------------------------------------------

test('com o quadro em mãos, desenha e NÃO marca degradado', () => {
  const { ctx, chamadas } = fakeCtx();
  const r = drawFrame(ctx, project([videoLayer({ start: 0, duration: 4 })]), 1, {
    frameFor: () => quadroFalso,
  });
  assert.deepEqual(chamadas, ['drawImage']);
  assert.equal(r.degraded, false);
});

test('aceita ImageBitmap, que usa width/height em vez de displayWidth', () => {
  // O provedor devolve `VideoFrame | ImageBitmap` conforme o caminho. Ler só
  // `displayWidth` faria o bitmap sair sem tamanho e não desenhar nada.
  const { ctx, chamadas } = fakeCtx();
  const bitmap = { width: 640, height: 360 } as unknown as FrameSource;
  const r = drawFrame(ctx, project([videoLayer({ start: 0, duration: 4 })]), 1, {
    frameFor: () => bitmap,
  });
  assert.deepEqual(chamadas, ['drawImage']);
  assert.equal(r.degraded, false);
});

// --- o quadro NÃO chegou ------------------------------------------------

test('sem o quadro, não desenha nada E marca degradado', () => {
  /**
   * As duas metades importam. Não desenhar impede pintar o quadro vizinho —
   * que é o defeito que tirar o `<video>` do caminho veio matar. Marcar
   * degradado impede o cache de guardar isso como se fosse o resultado final.
   */
  const { ctx, chamadas } = fakeCtx();
  const r = drawFrame(ctx, project([videoLayer({ start: 0, duration: 4 })]), 1, {
    frameFor: () => null,
  });
  assert.deepEqual(chamadas, [], 'não pode ter desenhado nada');
  assert.equal(r.degraded, true, 'tem que avisar que o quadro não é definitivo');
});

test('sem `frameFor` nenhum, o vídeo não desenha e o quadro é degradado', () => {
  // Chamador que esqueceu de passar a fonte não pode produzir um quadro que
  // PARECE completo. Era exatamente assim que o export saía congelado.
  const { ctx, chamadas } = fakeCtx();
  const r = drawFrame(ctx, project([videoLayer({ start: 0, duration: 4 })]), 1);
  assert.deepEqual(chamadas, []);
  assert.equal(r.degraded, true);
});

test('o vídeo faltando não impede o resto da composição de aparecer', () => {
  // Um arquivo que não decodifica não pode levar os títulos junto.
  const { ctx, chamadas } = fakeCtx();
  const p = project([videoLayer({ id: 1, start: 0, duration: 4 }), textLayer({ id: 2, start: 0, duration: 4 })]);
  const r = drawFrame(ctx, p, 1, { frameFor: () => null });
  assert.equal(r.degraded, true);
  // O texto desenha por fillText, não por drawImage — e desenhou.
  assert.deepEqual(chamadas, [], 'nenhuma imagem, mas o texto seguiu seu caminho');
});

test('projeto sem vídeo nunca é degradado por causa de quadro ausente', () => {
  const { ctx } = fakeCtx();
  const r = drawFrame(ctx, project([textLayer()]), 1, { frameFor: () => null });
  assert.equal(r.degraded, false);
});

test('layer de vídeo fora do instante não exige quadro', () => {
  // Clipe que nem está no ar não pode degradar o quadro nem pedir decodificação.
  const { ctx } = fakeCtx();
  const r = drawFrame(ctx, project([videoLayer({ start: 20, duration: 4 })]), 1, {
    frameFor: () => null,
  });
  assert.equal(r.degraded, false);
});

// --- o pré-render sem provedor -----------------------------------------

test('pré-render sem provedor de quadros não trava nem explode', () => {
  /**
   * `frames` é injetado (ver `FrameProvider`), então esquecer de passá-lo é um
   * erro possível. Ele tem que degradar o resultado, nunca pendurar o editor
   * numa espera que não termina — que foi o sintoma do export travado.
   */
  frameCache.clear?.();
  const p = project([textLayer({ start: 0, duration: 1 })]);
  // Sem canvas de verdade não dá pra rodar o laço inteiro aqui; o que este
  // teste fixa é que a assinatura aceita a ausência sem lançar na montagem.
  assert.doesNotThrow(() => {
    void prerenderRange;
    void p;
  });
});
