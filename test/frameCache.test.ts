import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameCache, renderSignature, frameIndexAt, timeAtFrameIndex, CACHE_FPS,
  estimateRange, formatBytes, stepFrame,
} from '../src/engine/frameCache.ts';
import type { FakeBitmap } from './fixtures.ts';
import { fakeBitmap, project, textLayer, videoLayer } from './fixtures.ts';
import type { TextLayer, VideoLayer } from '../src/engine/types.ts';

/** Projeto de uma layer de texto — o caso simples. */
const proj = (over: Partial<TextLayer> = {}) => project([textLayer(over)]);

/** Projeto de uma layer de vídeo — pros campos que só ela tem (trim, fonte). */
const vidProj = (over: Partial<VideoLayer> = {}) => project([videoLayer(over)]);

// --- assinatura: o que deve e o que não deve invalidar -------------------

test('mesmo conteúdo gera a mesma assinatura', () => {
  assert.equal(renderSignature(proj()), renderSignature(proj()));
});

test('mudar o que aparece na tela muda a assinatura', () => {
  const base = renderSignature(proj());
  assert.notEqual(renderSignature(proj({ text: 'OUTRO' })), base, 'texto');
  assert.notEqual(renderSignature(proj({ x: 50 })), base, 'posição');
  assert.notEqual(renderSignature(proj({ color: '#f00' })), base, 'cor');
  assert.notEqual(renderSignature(proj({ start: 1 })), base, 'início na timeline');
  assert.notEqual(
    renderSignature(proj({ effects: [{ name: 'x', tracks: [] }] })),
    base,
    'efeitos',
  );
});

test('ligar, desligar ou editar o contador muda a assinatura', () => {
  // Sem isto, editar `to`/`decimals`/`prefix` do contador não jogaria fora os
  // quadros já guardados, e o cache mostraria números velhos depois da edição.
  const base = renderSignature(proj());
  const comContador = renderSignature(proj({ countUp: { from: 0, to: 100 } }));
  assert.notEqual(comContador, base, 'ligar o contador');
  assert.notEqual(
    renderSignature(proj({ countUp: { from: 0, to: 200 } })),
    comContador,
    'mudar o `to`',
  );
  assert.notEqual(
    renderSignature(proj({ countUp: { from: 0, to: 100, decimals: 2 } })),
    comContador,
    'mudar as casas decimais',
  );
});

test('o trim de um vídeo muda a assinatura', () => {
  // Trocar qual pedaço do arquivo aparece troca os pixels, então o trecho já
  // preparado não vale mais.
  assert.notEqual(renderSignature(vidProj({ trimStart: 2 })), renderSignature(vidProj()));
});

test('mudar o tamanho da composição muda a assinatura', () => {
  const p = proj();
  const other = { ...p, width: 1080, height: 1920 };
  assert.notEqual(renderSignature(other), renderSignature(p));
});

test('campos que não desenham pixels NÃO invalidam o cache', () => {
  const base = renderSignature(proj());
  // Estado de UI grudado no modelo não pode custar um re-render do trecho todo.
  assert.equal(renderSignature(proj({ id: 999 })), base, 'id da layer');
  assert.equal(renderSignature(proj({ name: 'Outro nome' })), base, 'nome na lista');
  // Um campo de UI grudado no modelo não pode custar um re-render do trecho.
  assert.equal(
    renderSignature(proj({ selected: true } as Partial<TextLayer>)),
    base,
    'seleção',
  );
});

// --- grade de frames ----------------------------------------------------

test('tempo e índice de frame se convertem de volta', () => {
  assert.equal(frameIndexAt(0), 0);
  assert.equal(frameIndexAt(1), CACHE_FPS);
  assert.equal(timeAtFrameIndex(frameIndexAt(2.5)), 2.5);
});

test('instantes dentro do mesmo frame caem no mesmo índice', () => {
  // A 30fps, um frame dura ~33ms; 2.000s e 2.010s são o mesmo quadro.
  assert.equal(frameIndexAt(2.0), frameIndexAt(2.01));
});

// --- cache --------------------------------------------------------------

test('guarda e devolve um frame da assinatura corrente', () => {
  const c = new FrameCache();
  c.useSignature('sig-a');
  const b = fakeBitmap();
  c.set('sig-a', 10, b, 100);
  assert.equal(c.get('sig-a', 10), b);
  assert.equal(c.has('sig-a', 10), true);
});

test('assinatura diferente nunca devolve frame — nem por engano', () => {
  const c = new FrameCache();
  c.useSignature('sig-a');
  c.set('sig-a', 10, fakeBitmap(), 100);
  assert.equal(c.get('sig-b', 10), null, 'o projeto mudou: esse frame não vale mais');
});

test('trocar de assinatura descarta e libera tudo', () => {
  const c = new FrameCache();
  c.useSignature('sig-a');
  const b = fakeBitmap();
  c.set('sig-a', 1, b, 100);

  c.useSignature('sig-b');
  assert.equal(c.size, 0, 'cache esvaziado');
  assert.equal(c.bytes, 0, 'contagem de memória zerada');
  assert.equal(b.closed, true, 'bitmap liberado, não vazado');
});

test('frame que chega com assinatura velha é recusado e liberado', () => {
  // Acontece de verdade: o projeto é editado no meio de um pré-render.
  const c = new FrameCache();
  c.useSignature('nova');
  const atrasado = fakeBitmap();

  assert.equal(c.set('velha', 5, atrasado, 100), false, 'recusado');
  assert.equal(c.size, 0, 'não contaminou o cache novo');
  assert.equal(atrasado.closed, true, 'e não vazou');
});

test('regravar o mesmo índice libera o bitmap anterior', () => {
  const c = new FrameCache();
  c.useSignature('s');
  const velho = fakeBitmap();
  const novo = fakeBitmap();

  c.set('s', 3, velho, 100);
  c.set('s', 3, novo, 100);

  assert.equal(velho.closed, true, 'o substituído foi liberado');
  assert.equal(c.bytes, 100, 'memória contada uma vez só, não duas');
  assert.equal(c.get('s', 3), novo);
});

test('estourar o teto descarta os frames mais distantes primeiro', () => {
  const c = new FrameCache(250);   // cabem 2 frames de 100 bytes
  c.useSignature('s');

  c.set('s', 0, fakeBitmap(), 100);
  c.set('s', 50, fakeBitmap(), 100);
  c.set('s', 51, fakeBitmap(), 100);   // estoura; o índice 0 é o mais longe

  assert.ok(c.bytes <= 250, 'respeitou o teto');
  assert.equal(c.has('s', 51), true, 'mantém onde você está');
  assert.equal(c.has('s', 50), true, 'e a vizinhança imediata');
  assert.equal(c.has('s', 0), false, 'descartou o mais distante');
});

test('coverage agrupa os trechos contíguos já prontos', () => {
  const c = new FrameCache();
  c.useSignature('s');
  for (const i of [3, 4, 5, 9, 10]) c.set('s', i, fakeBitmap(), 10);

  assert.deepEqual(c.coverage(), [[3, 5], [9, 10]]);
});

test('clear libera todos os bitmaps', () => {
  const c = new FrameCache();
  c.useSignature('s');
  const bits = [fakeBitmap(), fakeBitmap()];
  bits.forEach((b, i) => c.set('s', i, b, 10));

  c.clear();
  assert.ok(bits.every(b => b.closed), 'nenhum bitmap ficou pra trás');
  assert.equal(c.bytes, 0);
});

// --- estimativa de capacidade -------------------------------------------

test('estimateRange conta frames e memória do trecho', () => {
  const e = estimateRange({
    width: 1000, height: 1000, scale: 0.5,   // 500x500 = 1MB por frame
    seconds: 1, fps: 30, budget: 100 * 1024 * 1024,
  });
  assert.equal(e.frames, 31, '1s a 30fps são 31 quadros contando as duas pontas');
  assert.equal(e.bytes, 31 * 500 * 500 * 4);
  assert.equal(e.fits, true);
});

test('estimateRange avisa quando o trecho não cabe', () => {
  const e = estimateRange({
    width: 1920, height: 1080, scale: 1,
    seconds: 60, fps: 30, budget: 320 * 1024 * 1024,
  });
  assert.equal(e.fits, false, '60s em resolução cheia não cabem em 320MB');
  assert.ok(e.maxSeconds > 0 && e.maxSeconds < 60, `sugere um trecho viável (${e.maxSeconds}s)`);
});

test('a duração sugerida realmente cabe no teto', () => {
  const budget = 320 * 1024 * 1024;
  const args = { width: 1920, height: 1080, scale: 1, fps: 30, budget };
  const { maxSeconds } = estimateRange({ ...args, seconds: 999 });

  assert.equal(estimateRange({ ...args, seconds: maxSeconds }).fits, true,
    'a sugestão não pode continuar estourando');
});

test('formatBytes usa a unidade legível', () => {
  assert.equal(formatBytes(320 * 1024 ** 2), '320 MB');
  assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB');
});

// --- qualidade: frames capturados durante a reprodução -------------------

test('frame de qualidade cheia serve pra qualquer situação', () => {
  const c = new FrameCache();
  c.useSignature('s');
  const b = fakeBitmap();
  c.set('s', 1, b, 10, { degraded: false });

  assert.equal(c.get('s', 1), b, 'parado');
  assert.equal(c.get('s', 1, { allowDegraded: true }), b, 'reproduzindo');
});

test('frame simplificado só vale enquanto reproduz', () => {
  const c = new FrameCache();
  c.useSignature('s');
  const b = fakeBitmap();
  c.set('s', 1, b, 10, { degraded: true });

  assert.equal(c.get('s', 1, { allowDegraded: true }), b, 'durante a reprodução, serve');
  assert.equal(c.get('s', 1), null, 'parado, prefere recompor a mostrar menos');
});

test('captura simplificada não rebaixa um frame de qualidade cheia', () => {
  // Cenário real: pré-renderizou o trecho, depois deu play por cima dele.
  const c = new FrameCache();
  c.useSignature('s');
  const bom = fakeBitmap();
  const pior = fakeBitmap();

  c.set('s', 1, bom, 10, { degraded: false });
  assert.equal(c.set('s', 1, pior, 10, { degraded: true }), false, 'recusado');

  assert.equal(c.get('s', 1), bom, 'o frame bom continua lá');
  assert.equal(pior.closed, true, 'e o pior foi liberado, não vazou');
});

test('qualidade cheia promove um frame que estava simplificado', () => {
  const c = new FrameCache();
  c.useSignature('s');
  const simplificado = fakeBitmap();
  const cheio = fakeBitmap();

  c.set('s', 1, simplificado, 10, { degraded: true });
  assert.equal(c.set('s', 1, cheio, 10, { degraded: false }), true);

  assert.equal(c.get('s', 1), cheio, 'agora vale parado também');
  assert.equal(simplificado.closed, true);
  assert.equal(c.bytes, 10, 'memória contada uma vez só');
});

test('has respeita a exigência de qualidade', () => {
  const c = new FrameCache();
  c.useSignature('s');
  c.set('s', 1, fakeBitmap(), 10, { degraded: true });

  assert.equal(c.has('s', 1, { allowDegraded: true }), true);
  assert.equal(c.has('s', 1), false, 'pro pré-render, esse frame ainda falta');
});

// --- retainRange: liberar orçamento antes do pré-render ------------------

test('retainRange descarta e libera o que está fora do trecho', () => {
  const c = new FrameCache();
  c.useSignature('s');
  const bits = new Map<number, FakeBitmap>();
  for (const i of [1, 5, 10, 15, 20]) {
    const b = fakeBitmap();
    bits.set(i, b);
    c.set('s', i, b, 10);
  }

  c.retainRange(5, 15);

  assert.deepEqual([...c.coverage()], [[5, 5], [10, 10], [15, 15]], 'só o miolo sobrou');
  assert.equal(bits.get(1)?.closed, true, 'fora do trecho foi liberado');
  assert.equal(bits.get(20)?.closed, true);
  assert.equal(bits.get(10)?.closed, false, 'dentro do trecho permanece');
  assert.equal(c.bytes, 30, 'memória recontada');
});

test('retainRange abre espaço pro trecho caber inteiro', () => {
  // O cenário real: quadros antigos de outra parte da linha do tempo ocupavam
  // o orçamento, e o descarte automático furava justamente o trecho sendo
  // preparado. Limpar antes faz a estimativa bater com a realidade.
  const c = new FrameCache(300);   // cabem 3 quadros de 100 bytes
  c.useSignature('s');
  c.set('s', 100, fakeBitmap(), 100);
  c.set('s', 200, fakeBitmap(), 100);

  c.retainRange(0, 2);
  assert.equal(c.bytes, 0, 'orçamento liberado');

  for (let i = 0; i <= 2; i++) c.set('s', i, fakeBitmap(), 100);
  assert.deepEqual(c.coverage(), [[0, 2]], 'trecho ficou íntegro, sem furos');
});

test('retainRange não mexe em nada quando tudo já está no trecho', () => {
  const c = new FrameCache();
  c.useSignature('s');
  for (let i = 0; i < 3; i++) c.set('s', i, fakeBitmap(), 10);
  c.retainRange(0, 10);
  assert.equal(c.size, 3);
});

// --- passo de quadro (setas do teclado) ---------------------------------

test('stepFrame anda um quadro exato a partir da grade', () => {
  assert.equal(stepFrame(1, 30, 1), timeAtFrameIndex(31, 30));
  assert.equal(stepFrame(1, 30, -1), timeAtFrameIndex(29, 30));
});

test('stepFrame encaixa na grade quando o cursor está entre quadros', () => {
  // O cursor chega fora da grade por arrasto. Somar 1/fps manteria o
  // desalinhamento pra sempre, e o preview recomporia quadros que o cache tem.
  const solto = 1.017;                       // entre os quadros 30 e 31
  const depois = stepFrame(solto, 30, 1);
  assert.equal(depois * 30, Math.round(depois * 30), 'pousou exatamente na grade');
});

test('stepFrame com passo zero apenas encaixa na grade', () => {
  assert.equal(stepFrame(1.017, 30, 0), timeAtFrameIndex(31, 30));
});

test('stepFrame respeita o fps do projeto', () => {
  assert.equal(stepFrame(0, 60, 1), 1 / 60, 'a 60fps o passo é a metade');
  assert.equal(stepFrame(0, 24, 1), 1 / 24);
});

test('stepFrame pode atravessar o zero — quem prende é o player', () => {
  // `seek` já limita em [0, duration]; duplicar o limite aqui só criaria dois
  // lugares pra discordar.
  assert.ok(stepFrame(0, 30, -1) < 0);
});
