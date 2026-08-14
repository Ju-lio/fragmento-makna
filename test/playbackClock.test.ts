import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceClock } from '../src/engine/playbackClock.ts';
import type { ClockState } from '../src/engine/playbackClock.ts';
import { frameIndexAt, timeAtFrameIndex } from '../src/engine/frameCache.ts';

const FPS = 30;
const DURATION = 10;

/**
 * Roda o relógio com uma sequência de intervalos e devolve os instantes que a
 * tela chegou a mostrar — só os passos que de fato mudaram de quadro.
 */
function play(elapseds: number[], opts: { fps?: number; duration?: number; loop?: boolean } = {}) {
  const { fps = FPS, duration = DURATION, loop = false } = opts;
  let state: ClockState = { frame: 0, accum: 0 };
  const shown: number[] = [];
  for (const elapsed of elapseds) {
    const next = advanceClock({ ...state, elapsed, fps, duration, loop });
    state = { frame: next.frame, accum: next.accum };
    if (next.stepped) shown.push(next.t);
    if (next.ended) break;
  }
  return shown;
}

/** Último instante mostrado. Explode se a reprodução não mostrou nada. */
function last(shown: number[]): number {
  const v = shown[shown.length - 1];
  assert.ok(v !== undefined, 'a reprodução não mostrou quadro nenhum');
  return v;
}

/** Os instantes que o EXPORT renderiza num trecho — a régua da fidelidade. */
function exportInstants(from: number, to: number, fps = FPS): number[] {
  const out: number[] = [];
  for (let i = frameIndexAt(from, fps); i <= frameIndexAt(to, fps); i++) {
    out.push(timeAtFrameIndex(i, fps));
  }
  return out;
}

/** Intervalos regulares, como um rAF de 60Hz sem engasgo nenhum. */
const steady = (seconds: number, hz = 60) => new Array(Math.round(seconds * hz)).fill(1 / hz);

test('todo instante mostrado é um instante que o export renderiza', () => {
  // A propriedade central da fase. Não basta o playhead andar direito: cada
  // valor que sai daqui vira `drawFrame(ctx, project, t)` no preview, e tem que
  // existir na grade que o exportador percorre.
  const grid = new Set(exportInstants(0, DURATION));
  for (const t of play(steady(5))) {
    assert.ok(grid.has(t), `instante fora da grade do export: ${t}`);
  }
});

test('um engasgo do navegador PULA quadros, nunca inventa um instante entre eles', () => {
  // O bug que iniciou esta fase: `t += dt` fazia um travamento virar um instante
  // arbitrário no meio da grade, e a reprodução mostrava um quadro que o arquivo
  // final não tem.
  const grid = new Set(exportInstants(0, DURATION));
  const comEngasgo = [...steady(0.5), 0.28, ...steady(0.5)];

  const shown = play(comEngasgo);
  for (const t of shown) assert.ok(grid.has(t), `instante inventado no engasgo: ${t}`);

  // E o engasgo aparece como salto: 0,28s a 30fps são 8 quadros de uma vez.
  const saltos: number[] = [];
  for (let i = 1; i < shown.length; i++) saltos.push(Math.round((shown[i]! - shown[i - 1]!) * FPS));
  assert.ok(saltos.includes(8), `esperava um salto de 8 quadros, vi ${saltos.join(',')}`);
});

test('a mesma reprodução com engasgos diferentes chega no MESMO lugar', () => {
  /**
   * O sintoma relatado: "cada vez que dou play sai algo diferente, sem eu ter
   * mexido nada". Com o tempo total igual, o quadro final tem que ser igual —
   * o que muda é só quantos quadros deram tempo de aparecer no meio.
   */
  // Os três somam os mesmos 3s, picados de jeitos diferentes.
  const liso = steady(3);
  const travado = [...steady(1), 0.2, ...steady(0.8), 0.3, ...steady(0.7)];
  const irregular = [...steady(0.5), 0.1, 0.05, ...steady(1), 0.15, ...steady(1.2)];

  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  assert.equal(total(liso).toFixed(6), total(travado).toFixed(6));
  assert.equal(total(liso).toFixed(6), total(irregular).toFixed(6));

  const a = last(play(liso)), b = last(play(travado)), c = last(play(irregular));

  /**
   * Tolerância de UM quadro, e não igualdade exata, porque somar 1/60 cento e
   * oitenta vezes não dá 3 em ponto flutuante — e cada picotagem erra pra um
   * lado. Exigir igualdade exata aqui seria testar o IEEE 754, não o relógio.
   *
   * O que o teste pega de verdade é o bug original, cuja diferença era de
   * dezenas de quadros: o `dt` limitado em 0,25s descartava tempo em silêncio a
   * cada travada, então quanto mais o navegador engasgasse, mais atrás a
   * reprodução terminava.
   */
  assert.ok(Math.abs(a - b) <= 1 / FPS, `o travamento mudou o fim: ${a} vs ${b}`);
  assert.ok(Math.abs(a - c) <= 1 / FPS, `o jitter mudou o fim: ${a} vs ${c}`);
});

test('a sobra não é descartada — um minuto não termina atrás', () => {
  // Truncar a fração a cada passo perderia até 1/fps por quadro. O acumulador
  // existe pra isso, e é o que mantém som e imagem juntos no fim de um clipe
  // longo.
  const fim = last(play(steady(60, 60), { duration: 120 }));
  const esperado = 60 - 1 / FPS;         // o último quadro completado em 60s
  assert.ok(
    Math.abs(fim - esperado) < 1 / FPS,
    `depois de 60s o playhead está em ${fim}, esperado ~${esperado}`,
  );
});

test('a 60Hz de relógio e 30fps de grade, metade dos ticks não repinta nada', () => {
  // Não é micro-otimização: repintar sem mudar de quadro é desenhar o mesmo
  // quadro duas vezes, e é o que o `stepped` evita.
  let state: ClockState = { frame: 0, accum: 0 };
  let repintou = 0;
  const ticks = 120;
  for (let i = 0; i < ticks; i++) {
    const next = advanceClock({ ...state, elapsed: 1 / 60, fps: FPS, duration: DURATION, loop: false });
    state = { frame: next.frame, accum: next.accum };
    if (next.stepped) repintou++;
  }
  assert.equal(repintou, ticks / 2);
});

test('o playhead nunca anda pra trás, nem com intervalo zero', () => {
  let state: ClockState = { frame: 0, accum: 0 };
  let prev = -Infinity;
  for (const elapsed of [0, 0, 1 / 60, 0, 1 / 30, 0, 0, 0.5, 0]) {
    const next = advanceClock({ ...state, elapsed, fps: FPS, duration: DURATION, loop: false });
    state = { frame: next.frame, accum: next.accum };
    assert.ok(next.t >= prev, `andou pra trás: ${prev} -> ${next.t}`);
    prev = next.t;
  }
});

test('o laço volta pro zero exato, sem carregar sobra entre as voltas', () => {
  // Carregar a sobra faria cada repetição começar um pouco adiante da anterior,
  // e depois de muitas voltas a trilha entraria fora do lugar.
  const r = advanceClock({ frame: frameIndexAt(DURATION, FPS) - 1, accum: 0.9, elapsed: 0.9, fps: FPS, duration: DURATION, loop: true });
  assert.equal(r.t, 0);
  assert.equal(r.frame, 0);
  assert.equal(r.accum, 0);
  assert.equal(r.ended, false);
});

test('sem laço, para no mesmo último quadro que o export chama de último', () => {
  // Se os dois discordarem sobre onde é o fim, parar no fim e exportar até o
  // fim mostram coisas diferentes.
  const r = advanceClock({ frame: frameIndexAt(DURATION, FPS) - 1, accum: 0, elapsed: 1, fps: FPS, duration: DURATION, loop: false });
  assert.equal(r.ended, true);
  assert.equal(r.frame, frameIndexAt(DURATION, FPS));
  assert.equal(r.t, timeAtFrameIndex(frameIndexAt(DURATION, FPS), FPS));
});

test('vale pra qualquer grade, não só 30fps', () => {
  for (const fps of [24, 25, 30, 50, 60]) {
    const grid = new Set(exportInstants(0, 4, fps));
    for (const t of play(steady(3), { fps, duration: 4 })) {
      assert.ok(grid.has(t), `fora da grade de ${fps}fps: ${t}`);
    }
  }
});
