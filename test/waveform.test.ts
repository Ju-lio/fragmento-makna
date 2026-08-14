import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePeaks, barsFor, clipWindow, viewScale, PEAKS_PER_SECOND,
} from '../src/engine/waveform.ts';

/** Uma senoide de `seconds` a 1000 amostras por segundo. */
const tom = (seconds: number, amp = 1, rate = 1000) => {
  const n = Math.round(seconds * rate);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = amp * Math.sin((2 * Math.PI * 50 * i) / rate);
  return d;
};

// --- envelope -----------------------------------------------------------

test('o envelope guarda vale E pico, não a média', () => {
  // A média tende a zero em qualquer sinal simétrico: desenharia uma linha reta
  // pra música e pra silêncio igualmente.
  const p = computePeaks([tom(1)], 1000, 100);
  assert.ok(Math.min(...p.min) < -0.9, 'pegou o vale');
  assert.ok(Math.max(...p.max) > 0.9, 'pegou o pico');
});

test('a resolução é por SEGUNDO, não por arquivo', () => {
  // Assim uma faixa de 3 min e um efeito de 2s têm o mesmo detalhe por
  // centímetro de timeline.
  assert.equal(computePeaks([tom(2)], 1000, 100).min.length, 200);
  assert.equal(computePeaks([tom(4)], 1000, 100).min.length, 400);
});

test('silêncio dá envelope achatado', () => {
  const p = computePeaks([new Float32Array(1000)], 1000, 100);
  assert.equal(Math.min(...p.min), 0);
  assert.equal(Math.max(...p.max), 0);
});

test('os canais entram pelo extremo, não somados', () => {
  // Somar estouraria a faixa em material já normalizado, e o que interessa
  // aqui é a forma.
  const esq = new Float32Array([0.5, 0.5, 0.5, 0.5]);
  const dir = new Float32Array([0.9, 0.9, 0.9, 0.9]);
  const p = computePeaks([esq, dir], 4, 1);
  assert.ok(Math.abs((p.max[0] as number) - 0.9) < 1e-6, `deu ${p.max[0]}`);
});

test('entrada vazia não quebra nem inventa baldes', () => {
  assert.equal(computePeaks([], 48000).min.length, 0);
  assert.equal(computePeaks([tom(1)], 0).min.length, 0);
});

// --- barras -------------------------------------------------------------

const envelope = () => computePeaks([tom(4)], 1000, 100);   // 400 baldes, 4s

test('devolve exatamente o número de barras pedido', () => {
  assert.equal(barsFor(envelope(), 0, 4, 37).min.length, 37);
});

test('a janela recorta o trecho certo do arquivo', () => {
  // Um clipe com trim mostra o MEIO do arquivo, não o começo.
  const meio = new Float32Array(4000);
  for (let i = 2000; i < 3000; i++) meio[i] = 1;    // só o terceiro segundo tem som
  const p = computePeaks([meio], 1000, 100);

  assert.equal(Math.max(...barsFor(p, 0, 2, 10).max), 0, 'os dois primeiros segundos são mudos');
  assert.ok(Math.max(...barsFor(p, 2, 3, 10).max) > 0.9, 'o terceiro tem som');
});

test('ampliar revela detalhe, nunca troca o desenho por outro', () => {
  // Reamostrar pegando um balde a cada N faria a onda cintilar a cada passo de
  // zoom, porque a barra passaria a ser um balde diferente e arbitrário.
  const p = envelope();
  const largo = barsFor(p, 0, 4, 20);
  const fino = barsFor(p, 0, 4, 200);
  // O pico global sobrevive nas duas resoluções.
  assert.ok(Math.abs(Math.max(...largo.max) - Math.max(...fino.max)) < 1e-6);
});

test('clipe mais ampliado que o material não abre buracos', () => {
  // Com `span` menor que `count`, um intervalo por barra fecharia vazio.
  const bars = barsFor(envelope(), 0, 0.05, 60);
  assert.equal(bars.max.length, 60);
  assert.ok(bars.max.some(v => v !== 0), 'alguma barra tem sinal');
});

test('pedir além do fim do arquivo não lê fora do array', () => {
  // Um clipe esticado além da fonte pediria baldes que não existem.
  const bars = barsFor(envelope(), 3, 99, 10);
  assert.equal(bars.max.length, 10);
  assert.ok(bars.max.every(Number.isFinite), 'nada de NaN vindo de índice fora');
});

test('janela invertida ou vazia devolve nada, sem lançar', () => {
  assert.equal(barsFor(envelope(), 2, 2, 10).max.length, 0);
  assert.equal(barsFor(envelope(), 3, 1, 10).max.length, 0);
  assert.equal(barsFor(envelope(), 0, 4, 0).max.length, 0);
});

// --- janela do clipe ----------------------------------------------------

test('a janela do clipe sai do trim e da duração', () => {
  // A mesma conta refeita no componente é como a onda passa a discordar do que
  // o clipe toca depois de um trim.
  assert.deepEqual(clipWindow({ trimStart: 2.5, duration: 4 }), { from: 2.5, to: 6.5 });
});

test('sem trim, começa do zero', () => {
  assert.deepEqual(clipWindow({ trimStart: 0, duration: 3 }), { from: 0, to: 3 });
});

test('a resolução padrão é mais fina que um pixel de timeline', () => {
  // A 120 baldes por segundo, um balde é ~8ms; um pixel só chega perto disso no
  // zoom máximo (600 px/s = 1,7ms), e aí já é detalhe demais pra 24px de altura.
  assert.ok(PEAKS_PER_SECOND >= 100);
});

// --- normalização da vista ----------------------------------------------

test('a onda é normalizada pela escala do arquivo', () => {
  // Em 24px de faixa, o valor absoluto falha justo onde importa: fala costuma
  // ter pico em -18 dB, que dá menos de um pixel — uma linha reta.
  const forte = computePeaks([tom(1, 1.0)], 1000, 100);
  const fraco = computePeaks([tom(1, 0.12)], 1000, 100);

  assert.ok(viewScale(fraco) > viewScale(forte), 'o fraco é ampliado mais');
  // Depois de normalizar, os dois ocupam praticamente a mesma altura.
  const alturaForte = Math.max(...forte.max) * viewScale(forte);
  const alturaFraco = Math.max(...fraco.max) * viewScale(fraco);
  assert.ok(Math.abs(alturaForte - alturaFraco) < 0.02, `${alturaForte} vs ${alturaFraco}`);
});

test('arquivo quase mudo não é amplificado até virar ruído', () => {
  // O outro extremo: sem piso, silêncio com um cochicho viraria uma onda cheia.
  const quaseMudo = computePeaks([tom(1, 0.001)], 1000, 100);
  assert.ok(Math.max(...quaseMudo.max) * viewScale(quaseMudo) < 0.05, 'segue parecendo vazio');
});

test('o silêncio interno continua silêncio depois de normalizar', () => {
  // O que se ganha é contraste, não uma mentira: a divisão é pelo pico do
  // arquivo, não por trecho.
  const d = new Float32Array(1000);
  for (let i = 0; i < 500; i++) d[i] = 0.2;
  const p = computePeaks([d], 1000, 100);
  assert.equal(Math.max(...barsFor(p, 0.5, 1, 10).max) * viewScale(p), 0);
  assert.ok(Math.max(...barsFor(p, 0, 0.5, 10).max) * viewScale(p) > 0.9);
});
