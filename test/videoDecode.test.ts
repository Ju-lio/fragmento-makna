import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceTimeFor } from '../src/engine/videoDecode.ts';
import { drawFrame } from '../src/engine/renderer.ts';
import type { DecodedFrame } from '../src/engine/types.ts';
import { project, textLayer, videoLayer, fakeVideo } from './fixtures.ts';

// --- tempo do projeto -> tempo do arquivo -------------------------------

test('o trim desloca a leitura, não a posição', () => {
  // Clipe que entra em 2s mostrando a partir de 1s do arquivo: no instante 5
  // da linha do tempo, o arquivo está em 1 + (5-2) = 4.
  const l = { start: 2, duration: 10, trimStart: 1, sourceDuration: 60 };
  assert.equal(sourceTimeFor(l, 5), 4);
  assert.equal(sourceTimeFor(l, 2), 1);
});

test('nunca pede tempo que o arquivo não tem', () => {
  // Um clipe esticado além da fonte pediria material inexistente, e um pedido
  // negativo não corresponde a quadro nenhum.
  const l = { start: 0, duration: 30, trimStart: 0, sourceDuration: 10 };
  assert.equal(sourceTimeFor(l, 25), 10, 'além do fim');
  assert.equal(sourceTimeFor(l, -5), 0, 'antes do começo');
});

test('sourceDuration ausente não vira NaN', () => {
  // Vem de projeto salvo à mão ou de outra versão; `Math.min` com undefined
  // produziria NaN circulando até o decodificador.
  const l = { start: 0, duration: 4, trimStart: 0, sourceDuration: NaN };
  assert.equal(sourceTimeFor(l, 2), 2);
});

// --- de onde sai o pixel ------------------------------------------------

/** O mínimo de um contexto 2D pro `drawFrame` rodar sem navegador. */
function fakeCtx() {
  const chamadas: string[] = [];
  const ctx = {
    canvas: { width: 320, height: 180 },
    filter: 'none', globalAlpha: 1, imageSmoothingQuality: 'high',
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    lineWidth: 0, lineJoin: '', shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
    letterSpacing: '',
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    clearRect() {}, fillRect() {}, fillText() {}, strokeText() {},
    measureText: () => ({ width: 10 }),
    drawImage() { chamadas.push('drawImage'); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, chamadas };
}

/** Quadro decodificado falso — só o que o desenho lê. Ver `DecodedFrame`. */
function fakeFrame(chamadas: string[]): DecodedFrame {
  return {
    displayWidth: 640,
    displayHeight: 360,
    draw() { chamadas.push('frame.draw'); },
  };
}

test('havendo quadro decodificado, o desenho usa ELE e não o <video>', () => {
  const { ctx, chamadas } = fakeCtx();
  const l = videoLayer({ start: 0, duration: 4 });
  const r = drawFrame(ctx, project([l]), 1, { frameFor: () => fakeFrame(chamadas) });

  assert.deepEqual(chamadas, ['frame.draw']);
  assert.equal(r.degraded, false, 'quadro exato não é degradado');
});

test('sem quadro decodificado, cai no <video> e MARCA o quadro como degradado', () => {
  /**
   * A marcação é o que impede o cache de mentir. O elemento mostra o que ele
   * tiver, não o instante pedido — reexibir esse quadro é aceitável, tomá-lo
   * por definitivo não é, e o pré-render tem que poder regerá-lo.
   */
  const { ctx, chamadas } = fakeCtx();
  const l = videoLayer({ start: 0, duration: 4, video: fakeVideo({ readyState: 4 }) });
  const r = drawFrame(ctx, project([l]), 1, { frameFor: () => null });

  assert.deepEqual(chamadas, ['drawImage']);
  assert.equal(r.degraded, true);
});

test('sem quadro E sem elemento pronto, não desenha nada — mas ainda avisa', () => {
  const { ctx, chamadas } = fakeCtx();
  const l = videoLayer({ start: 0, duration: 4, video: fakeVideo({ readyState: 0 }) });
  const r = drawFrame(ctx, project([l]), 1, { frameFor: () => null });

  assert.deepEqual(chamadas, []);
  assert.equal(r.degraded, true);
});

test('projeto sem vídeo nunca é degradado por causa disto', () => {
  // Só o desfoque pulado pode degradar um projeto de texto; a ausência de
  // quadro decodificado não pode contaminar quem não tem vídeo.
  const { ctx } = fakeCtx();
  const r = drawFrame(ctx, project([textLayer()]), 1, { frameFor: () => null });
  assert.equal(r.degraded, false);
});
