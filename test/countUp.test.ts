/**
 * O contador numérico animado — motor puro, sem canvas nem DOM.
 *
 * Como em outros motores deste projeto, o que importa aqui é o modo de
 * FALHA: valor antes do início, depois do fim, formatação com entrada
 * absurda (decimais negativos, `from > to`), não só o caminho feliz de
 * "conta de 0 a 100".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countUpProgress, countUpValue, formatCountUp, displayText, seedCountUpFromText,
} from '../src/engine/countUp.ts';
import type { CountUp } from '../src/engine/types.ts';
import { textLayer } from './fixtures.ts';

const near = (a: number, b: number, msg = `${a} ≈ ${b}`) => {
  assert.ok(Math.abs(a - b) < 1e-6, `${msg} (${a} vs ${b})`);
};

const cu = (over: Partial<CountUp> = {}): CountUp => ({ from: 0, to: 100, ...over });

// --- progresso e valor ----------------------------------------------------

test('duração ausente cai na duração da LAYER inteira, não em 1s', () => {
  // Diferente do padrão de `Effect` — um contador roda enquanto o texto
  // está na tela, não como um floreio de entrada curto.
  const layer = { start: 0, duration: 4 };
  near(countUpProgress(cu(), layer, 2), 0.5, 'meio da duração da layer');
  near(countUpProgress(cu(), layer, 4), 1, 'fim da duração da layer');
});

test('antes do início (delay), mostra `from` — nunca erra pra baixo de 0', () => {
  const layer = { start: 0, duration: 4 };
  near(countUpProgress(cu({ delay: 1 }), layer, 0), 0, 'ainda não começou');
  near(countUpValue(cu({ delay: 1, from: 10, to: 20 }), layer, 0), 10, 'mostra from, não NaN nem negativo');
});

test('depois do fim, segura em `to` — não passa nem volta', () => {
  const layer = { start: 0, duration: 4 };
  near(countUpValue(cu({ from: 10, to: 20 }), layer, 999), 20);
});

test('midpoint linear', () => {
  const layer = { start: 0, duration: 4 };
  near(countUpValue(cu({ ease: 'linear' }), layer, 2), 50);
});

test('easing não-linear muda a curva, não só os extremos', () => {
  const layer = { start: 0, duration: 4 };
  const v = countUpValue(cu({ ease: 'outQuint' }), layer, 2);
  // outQuint desacelera forte: no meio do tempo já está bem mais perto do
  // fim que o linear (50).
  assert.ok(v > 80, `esperava bem acima de 50 (outQuint), deu ${v}`);
});

test('delay desloca o início da contagem', () => {
  const layer = { start: 0, duration: 4 };
  near(countUpValue(cu({ delay: 2, duration: 2 }), layer, 3), 50, 'meio da janela de 2s que começa em t=2');
});

test('contagem REGRESSIVA (from > to) interpola na direção certa', () => {
  const layer = { start: 0, duration: 4 };
  near(countUpValue(cu({ from: 100, to: 0, ease: 'linear' }), layer, 2), 50);
  near(countUpValue(cu({ from: 100, to: 0 }), layer, 4), 0, 'chega em to, não fica presa em from');
});

test("anchor 'end': inativo antes da janela mostra `from`, termina no fim da layer", () => {
  const layer = { start: 2, duration: 4 };   // termina em t=6
  const eff = cu({ duration: 1, anchor: 'end', from: 0, to: 50 });
  near(countUpValue(eff, layer, 4), 0, 'antes da janela: from, não erro nem NaN');
  near(countUpValue(eff, layer, 6), 50, 'termina exatamente no fim da layer');
});

// --- formatação -------------------------------------------------------

test('decimals ausente arredonda pra inteiro', () => {
  assert.equal(formatCountUp(4.6, cu()), '5', 'arredonda, não trunca');
});

test('decimais e separador de milhar juntos, no padrão BR', () => {
  assert.equal(formatCountUp(559872.5, cu({ decimals: 2 })), '559.872,50');
});

test('separator: false desliga só o AGRUPAMENTO — decimal continua vírgula', () => {
  // Se desligasse os dois, "separador" pareceria mudar duas coisas por uma.
  assert.equal(formatCountUp(1234.5, cu({ decimals: 1, separator: false })), '1234,5');
});

test('prefixo e sufixo, nessa ordem: prefixo + número + sufixo', () => {
  assert.equal(
    formatCountUp(1234, cu({ prefix: 'R$ ', suffix: ' km rodados' })),
    'R$ 1.234 km rodados',
  );
});

test('decimals negativo (entrada absurda, ex. de .frag editado à mão) não quebra', () => {
  assert.equal(formatCountUp(4.6, cu({ decimals: -3 })), '5', 'cai em 0 casas, não lança nem gera lixo');
});

// --- displayText: a decisão de qual texto mostrar --------------------------

test('sem countUp, displayText devolve o `text` estático sem tocar', () => {
  const layer = textLayer({ text: 'Olá mundo' });
  assert.equal(displayText(layer, 0), 'Olá mundo');
  assert.equal(displayText(layer, 999), 'Olá mundo', 'estático não muda com t');
});

test('com countUp, NUNCA devolve o `text` estático — nem antes nem depois da janela', () => {
  // É o teste que trava a decisão de design: contador SUBSTITUI, não mistura.
  const layer = textLayer({
    text: 'ignorado', duration: 4,
    countUp: cu({ from: 0, to: 100, delay: 10 }),   // delay maior que a duração: nunca "roda" de fato
  });
  assert.notEqual(displayText(layer, 0), 'ignorado');
  assert.notEqual(displayText(layer, 999), 'ignorado');
  assert.equal(displayText(layer, 0), '0', 'antes do delay, mostra from formatado');
});

test('displayText muda de fato ao longo do tempo, quando o contador está ativo', () => {
  const layer = textLayer({ text: 'x', duration: 4, countUp: cu({ ease: 'linear' }) });
  assert.equal(displayText(layer, 0), '0');
  assert.equal(displayText(layer, 2), '50');
  assert.equal(displayText(layer, 4), '100');
});

// --- seedCountUpFromText ------------------------------------------------

test('lê número BR com separador de milhar e sufixo de texto', () => {
  assert.deepEqual(
    seedCountUpFromText('559.872 km rodados'),
    { to: 559872, prefix: '', suffix: ' km rodados' },
  );
});

test('lê prefixo antes do número', () => {
  assert.deepEqual(seedCountUpFromText('R$ 1.234,50'), { to: 1234.5, prefix: 'R$ ', suffix: '' });
});

test('texto sem dígito nenhum devolve null — a UI cai num padrão fixo', () => {
  assert.equal(seedCountUpFromText('sem número nenhum'), null);
});

test('texto vazio devolve null, não lança', () => {
  assert.equal(seedCountUpFromText(''), null);
});
