import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layerBox, layerCenter, toLocal, hitBox, pickLayer,
  scaleFactor, rotationDelta, normalizeAngle, snapAngle, boxCorners,
} from '../src/engine/gizmo.ts';
import { resolveState } from '../src/engine/effects.ts';
import { drawOrder } from '../src/engine/project.ts';
import { project, textLayer, imageLayer, fakeImage } from './fixtures.ts';
import type { VisualLayer } from '../src/engine/types.ts';

/** Medidor falso: 10px por caractere, independente da fonte. */
const measure = (line: string) => line.length * 10;

const comp = () => project([]);

// --- caixa da layer -----------------------------------------------------

test('a caixa do texto sai da medição, e a altura do corpo da fonte', () => {
  const box = layerBox(textLayer({ text: 'ABCDE', size: 100 }), comp(), measure);
  assert.equal(box.w, 50);
  assert.equal(box.h, 100, 'uma linha: um corpo');
});

test('texto de várias linhas usa a linha mais larga e a entrelinha do desenho', () => {
  // A caixa TEM que bater com o `drawText`: contas em lugares diferentes é
  // justamente o que faria a moldura não coincidir com o que está na tela.
  const box = layerBox(textLayer({ text: 'AB\nABCD', size: 100 }), comp(), measure);
  assert.equal(box.w, 40, 'a linha mais larga manda');
  assert.equal(box.h, 100 * 1.12 + 100, 'um vão de entrelinha mais um corpo');
});

test('a caixa da imagem usa a mesma conta do desenho', () => {
  // Fonte 100x100 numa composição 1920x1080, com fit 0.5:
  // escala = min(1920/100, 1080/100) * 0.5 = 5.4  ->  100 * 5.4 = 540.
  // A altura manda porque é o lado que aperta — o mesmo `Math.min` do desenho.
  const box = layerBox(imageLayer({ img: fakeImage(), fit: 0.5 }), comp(), measure);
  assert.equal(box.w, 540);
  assert.equal(box.h, 540, 'a imagem falsa é quadrada');
});

test('mídia sem dimensões ainda não tem caixa', () => {
  const semImagem = imageLayer({ img: { width: 0, height: 0 } as HTMLImageElement });
  assert.deepEqual(layerBox(semImagem, comp(), measure), { w: 0, h: 0 });
});

// --- referencial da layer -----------------------------------------------

test('o centro da layer parte do meio da composição', () => {
  const st = resolveState(textLayer({ x: 100, y: -50, effects: [] }), 0);
  assert.deepEqual(layerCenter(comp(), st), { x: 1920 / 2 + 100, y: 1080 / 2 - 50 });
});

test('desfazer a rotação devolve um retângulo alinhado aos eixos', () => {
  // É o que permite testar acerto numa layer girada sem calcular polígono.
  const center = { x: 0, y: 0 };
  const local = toLocal({ x: 0, y: 100 }, center, 90, 1);
  assert.ok(Math.abs(local.x - 100) < 1e-9, `x=${local.x}`);
  assert.ok(Math.abs(local.y) < 1e-9, `y=${local.y}`);
});

test('desfazer a escala junto', () => {
  const local = toLocal({ x: 50, y: 0 }, { x: 0, y: 0 }, 0, 2);
  assert.equal(local.x, 25);
});

test('escala zero não estoura a conta', () => {
  assert.equal(toLocal({ x: 50, y: 0 }, { x: 0, y: 0 }, 0, 0).x, 50);
});

// --- acerto -------------------------------------------------------------

test('dentro acerta, fora não', () => {
  const box = { w: 100, h: 40 };
  assert.equal(hitBox({ x: 49, y: 19 }, box), true);
  assert.equal(hitBox({ x: 51, y: 0 }, box), false);
  assert.equal(hitBox({ x: 0, y: 21 }, box), false);
});

test('a folga existe pra texto fino não ser impossível de pegar', () => {
  // Clicar "quase em cima" e não selecionar nada parece defeito.
  assert.equal(hitBox({ x: 0, y: 30 }, { w: 100, h: 40 }, 12), true);
});

test('numa layer girada, o acerto acompanha', () => {
  const p = project([textLayer({ text: 'ABCDEFGHIJ', size: 40, rotate: 90, x: 0, y: 0, effects: [] })]);
  const layer = p.layers[0] as VisualLayer;
  const st = resolveState(layer, 0);
  const center = layerCenter(p, st);
  const box = layerBox(layer, p, measure);   // 100 de largura, 40 de altura

  // Deitada 90°, a extensão longa passou a ser vertical.
  const acimaDoCentro = { x: center.x, y: center.y - 45 };
  assert.equal(hitBox(toLocal(acimaDoCentro, center, st.rotate, st.scale), box), true);
  const aoLado = { x: center.x + 45, y: center.y };
  assert.equal(hitBox(toLocal(aoLado, center, st.rotate, st.scale), box), false);
});

// --- escolher a layer ---------------------------------------------------

test('clicar pega a layer da FRENTE', () => {
  // Quem está por cima é quem você quis pegar.
  const p = project([
    textLayer({ id: 1, track: 0, text: 'AAAA', size: 100, effects: [] }),
    textLayer({ id: 2, track: 1, text: 'AAAA', size: 100, effects: [] }),
  ]);
  const meio = { x: p.width / 2, y: p.height / 2 };
  const achada = pickLayer(drawOrder(p), meio, p, measure, l => resolveState(l, 0));
  assert.equal(achada?.id, 2);
});

test('clicar no vazio não seleciona nada', () => {
  const p = project([textLayer({ text: 'A', size: 20, effects: [] })]);
  assert.equal(pickLayer(drawOrder(p), { x: 5, y: 5 }, p, measure, l => resolveState(l, 0)), null);
});

test('layer sem caixa não pode ser pega', () => {
  // Senão uma imagem que ainda não carregou roubaria o clique de quem está atrás.
  const p = project([imageLayer({ img: { width: 0, height: 0 } as HTMLImageElement })]);
  const meio = { x: p.width / 2, y: p.height / 2 };
  assert.equal(pickLayer(drawOrder(p), meio, p, measure, l => resolveState(l, 0)), null);
});

// --- escalar ------------------------------------------------------------

test('a escala sai da razão entre as distâncias ao centro', () => {
  const centro = { x: 0, y: 0 };
  assert.equal(scaleFactor({ x: 100, y: 0 }, { x: 150, y: 0 }, centro), 1.5);
});

test('escalar funciona igual numa layer girada', () => {
  // Pela distância e não pela projeção num eixo: "pra fora" numa layer deitada
  // não é nem horizontal nem vertical.
  const centro = { x: 0, y: 0 };
  const diagonal = scaleFactor({ x: 30, y: 40 }, { x: 60, y: 80 }, centro);
  assert.equal(diagonal, 2);
});

test('alça largada em cima do centro não explode a escala', () => {
  // Um pixel de tremor viraria 10x.
  assert.equal(scaleFactor({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0 }), 1);
});

// --- girar --------------------------------------------------------------

test('o giro sai do ângulo em torno do centro', () => {
  const d = rotationDelta({ x: 100, y: 0 }, { x: 0, y: 100 }, { x: 0, y: 0 });
  assert.ok(Math.abs(d - 90) < 1e-9, `${d}`);
});

test('cruzar os 180° não dá uma volta inteira no meio do gesto', () => {
  const d = rotationDelta({ x: -100, y: -1 }, { x: -100, y: 1 }, { x: 0, y: 0 });
  assert.ok(Math.abs(d) < 5, `esperava um passo pequeno, deu ${d}`);
});

test('o ângulo não acumula voltas', () => {
  assert.equal(normalizeAngle(370), 10);
  assert.equal(normalizeAngle(-90), 270);
});

test('Shift prende de 15 em 15 graus', () => {
  assert.equal(snapAngle(37, true), 30);
  assert.equal(snapAngle(37, false), 37);
});

// --- quinas -------------------------------------------------------------

test('as quinas saem na ordem, e a escala as afasta', () => {
  const q = boxCorners({ x: 0, y: 0 }, { w: 100, h: 40 }, 0, 2);
  assert.deepEqual(q[0], { x: -100, y: -40 });
  assert.deepEqual(q[2], { x: 100, y: 40 });
});

test('girar 90° troca as quinas de lugar como se espera', () => {
  const [primeira] = boxCorners({ x: 0, y: 0 }, { w: 100, h: 40 }, 90, 1);
  assert.ok(Math.abs(primeira!.x - 20) < 1e-9, `x=${primeira!.x}`);
  assert.ok(Math.abs(primeira!.y + 50) < 1e-9, `y=${primeira!.y}`);
});
