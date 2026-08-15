import test from 'node:test';
import assert from 'node:assert/strict';
import { clipDragPlan, flipOrder, openTrackAt } from '../src/engine/trackDrag.ts';
import type { Occupant } from '../src/engine/trackDrag.ts';

/** Um gesto parado: 100px por segundo, faixas de 28px, clipe de 2s em t=1. */
const base = {
  dx: 0, dy: 0,
  pxPerSecond: 100,
  trackPitch: 28,
  start: 1,
  track: 2,
  span: 2,
  duration: 10,
  maxTrack: 3,
  others: [] as Occupant[],
};

const drag = (over: Partial<typeof base> = {}) => clipDragPlan({ ...base, ...over });

// --- movimento no tempo -------------------------------------------------

test('parado, o plano é exatamente onde o clipe já está', () => {
  assert.deepEqual(drag(), { start: 1, track: 2, insert: false, valid: true, snappedTo: null });
});

test('arrastar na horizontal converte pixel em segundo', () => {
  assert.equal(drag({ dx: 250 }).start, 3.5, '250px a 100px/s são 2.5s');
  assert.equal(drag({ dx: -50 }).start, 0.5);
});

test('o clipe não passa do começo da linha', () => {
  assert.equal(drag({ dx: -9999 }).start, 0);
});

test('o clipe não deixa a cauda sair pelo fim', () => {
  // Projeto de 10s, clipe de 2s: o começo dele para em 8s.
  assert.equal(drag({ dx: 9999 }).start, 8);
});

test('clipe maior que o projeto encosta em zero em vez de ir pra negativo', () => {
  assert.equal(drag({ span: 30, dx: 9999 }).start, 0);
});

test('sem escala, o clipe fica onde está em vez de saltar pra zero', () => {
  // Acontece de verdade: a régua ainda não foi medida (largura 0).
  assert.equal(drag({ pxPerSecond: 0, dx: 500 }).start, 1);
});

// --- troca de faixa -----------------------------------------------------

/**
 * Estes testes falam em CIMA e BAIXO, não em número de faixa.
 *
 * Não é preciosismo de redação: a versão anterior afirmava "dy positivo
 * aumenta a faixa", que descrevia a implementação e não o gesto — e por isso
 * passava alegremente enquanto arrastar pra baixo mandava o clipe pra cima. As
 * faixas numeram ao contrário das linhas na tela, e é essa inversão que o teste
 * tem que fixar.
 */

test('arrastar pra BAIXO desce de faixa', () => {
  // A faixa 0 desenha no fundo e aparece embaixo, então descer diminui o número.
  assert.equal(drag({ dy: 28 }).track, 1, 'uma linha pra baixo');
  assert.equal(drag({ dy: 56 }).track, 0, 'duas linhas pra baixo');
});

test('arrastar pra CIMA sobe de faixa', () => {
  assert.equal(drag({ dy: -28 }).track, 3);
});

test('perto de uma linha, encaixa NELA', () => {
  // Três zonas por linha: o miolo pousa, e as bordas viram inserção (testadas
  // mais abaixo). Antes eram duas, e por isso não havia como descer do fundo.
  assert.equal(drag({ dy: 4 }).track, 2, 'quase parado, fica onde está');
  assert.equal(drag({ dy: 4 }).insert, false);
  assert.equal(drag({ dy: 24 }).track, 1, 'quase uma linha inteira, pousa na de baixo');
  assert.equal(drag({ dy: 24 }).insert, false);
});

test('a faixa é limitada às que aceitam o clipe', () => {
  assert.equal(drag({ dy: 9999 }).track, 0, 'não desce da faixa 0');
  assert.equal(drag({ dy: -9999 }).track, 3, 'nem passa da mais alta permitida');
});

test('as duas direções valem no mesmo gesto', () => {
  // É o ponto da feature: reposicionar no tempo e trocar de faixa de uma vez.
  assert.deepEqual(drag({ dx: 100, dy: 28 }), { start: 2, track: 1, insert: false, valid: true, snappedTo: null });
});

// --- colisão ------------------------------------------------------------

const ocupante = (over: Partial<Occupant> = {}): Occupant =>
  ({ track: 2, start: 5, duration: 2, ...over });

test('cair em cima de outro clipe da mesma faixa é inválido', () => {
  // Sem isso, dois clipes ocupariam o mesmo instante e a faixa deixaria de
  // ter um dono por quadro — que é a invariante que sustenta a ordem de desenho.
  const plan = drag({ dx: 450, others: [ocupante()] });   // clipe vai pra 5.5..7.5
  assert.equal(plan.valid, false);
});

test('o mesmo lugar em outra faixa é livre', () => {
  const plan = drag({ dx: 450, dy: 28, others: [ocupante({ track: 2 })] });
  assert.equal(plan.track, 1);
  assert.equal(plan.valid, true, 'a colisão é por faixa, não por instante');
});

test('encostar exatamente na ponta do vizinho é válido', () => {
  // É o caso NORMAL: é o que um corte produz, e o que empilhar clipes exige.
  const vizinho = ocupante({ start: 3, duration: 2 });   // ocupa 3..5
  assert.equal(drag({ dx: 400, others: [vizinho] }).valid, true, 'clipe começa em 5');

  const antes = ocupante({ start: 3, duration: 2 });
  assert.equal(drag({ dx: 0, others: [antes] }).valid, true, 'clipe 1..3 encosta em 3');
});

test('sobreposição de um instante só já invalida', () => {
  const vizinho = ocupante({ start: 2.9, duration: 2 });
  assert.equal(drag({ dx: 0, others: [vizinho] }).valid, false, 'clipe 1..3 invade 2.9');
});

test('o plano de posição é calculado mesmo quando inválido', () => {
  // A interface precisa mostrar ONDE cairia pra explicar por que não pode.
  const plan = drag({ dx: 450, others: [ocupante()] });
  assert.equal(plan.start, 5.5);
  assert.equal(plan.track, 2);
  assert.equal(plan.valid, false);
});

// --- ordem de desenho vs. ordem visual ----------------------------------

test('flipOrder espelha: a faixa mais alta é a linha de cima', () => {
  // 4 linhas na tela (faixas 0..3): a faixa 3 desenha na frente e aparece em cima.
  assert.equal(flipOrder(3, 4), 0);
  assert.equal(flipOrder(0, 4), 3);
});

test('flipOrder é a própria inversa', () => {
  // É o que permite uma função só pros dois sentidos, sem risco de trocá-las.
  for (const i of [0, 1, 2, 3]) assert.equal(flipOrder(flipOrder(i, 4), 4), i);
});

// --- inserir entre faixas -----------------------------------------------
// Faltava poder mandar um clipe pra BAIXO de outro: a faixa 0 era o piso, e
// não havia gesto que abrisse espaço embaixo dela nem no meio da pilha.

test('soltar no meio do caminho entre duas linhas abre uma faixa ali', () => {
  // Meia linha pra baixo: nem na faixa 2, nem na 1 — entre elas.
  const plan = drag({ dy: 14 });
  assert.equal(plan.insert, true);
  assert.equal(plan.track, 2, 'a faixa nova nasce em 2; a antiga 2 sobe pra 3');
});

test('perto de uma linha ainda pousa NELA, não insere', () => {
  // A zona de inserção não pode atrapalhar quem só quer trocar de faixa.
  assert.equal(drag({ dy: 5 }).insert, false, 'quase parado');
  assert.equal(drag({ dy: 26 }).insert, false, 'quase uma linha exata');
});

test('arrastar pra baixo do fundo abre uma faixa embaixo de tudo', () => {
  // Era o que não tinha jeito de fazer: a faixa 0 era o piso.
  const plan = drag({ track: 0, dy: 14 });
  assert.equal(plan.insert, true);
  assert.equal(plan.track, 0, 'tudo sobe uma, e o clipe fica no fundo');
});

test('faixa nova nasce vazia, então a inserção nunca colide', () => {
  const plan = drag({ dy: 14, others: [ocupante({ track: 2, start: 0, duration: 30 })] });
  assert.equal(plan.insert, true);
  assert.equal(plan.valid, true, 'o ocupante vai subir junto com a faixa dele');
});

test('a posição no tempo vale igual numa inserção', () => {
  assert.equal(drag({ dx: 250, dy: 14 }).start, 3.5);
});

test('a inserção respeita o teto de faixas', () => {
  assert.equal(drag({ dy: -9999 }).track, 3);
});

// --- abrir a faixa ------------------------------------------------------

test('openTrackAt empurra pra cima só o que está dali em diante', () => {
  const layers = [{ id: 1, track: 0 }, { id: 2, track: 1 }, { id: 3, track: 2 }];
  const out = openTrackAt(layers, 1);

  assert.equal(out[0]?.track, 0, 'abaixo do ponto, intocado');
  assert.equal(out[1]?.track, 2, 'daqui pra cima, sobe uma');
  assert.equal(out[2]?.track, 3);
});

test('openTrackAt em zero sobe todo mundo', () => {
  const out = openTrackAt([{ track: 0 }, { track: 1 }], 0);
  assert.deepEqual(out.map(l => l.track), [1, 2]);
});

test('openTrackAt acima de tudo não mexe em ninguém', () => {
  const layers = [{ track: 0 }, { track: 1 }];
  assert.deepEqual(openTrackAt(layers, 9).map(l => l.track), [0, 1]);
});

test('openTrackAt não recria quem não mudou', () => {
  // Mesma razão do compactTracks: o histórico compartilha estrutura.
  const baixo = { track: 0 };
  const out = openTrackAt([baixo, { track: 5 }], 3);
  assert.equal(out[0], baixo);
});

// --- direção das linhas -------------------------------------------------

test('no vídeo, descer com o ponteiro DIMINUI a faixa', () => {
  // A faixa 0 desenha no fundo e por isso aparece embaixo.
  const plan = clipDragPlan({
    ...base, dy: 40, trackPitch: 40, track: 2, maxTrack: 4, invertedRows: true,
  });
  assert.equal(plan.track, 1);
});

test('no áudio, descer AUMENTA — o número ali não é profundidade', () => {
  // Era fixo na convenção do vídeo, e o sintoma foi silencioso: o clipe de
  // áudio pedia a faixa -2, o clamp prendia em 0, e ele não saía do lugar.
  const plan = clipDragPlan({
    ...base, dy: 40, trackPitch: 40, track: 0, maxTrack: 4, invertedRows: false,
  });
  assert.equal(plan.track, 1);
});

test('subir no áudio faz o espelho', () => {
  const plan = clipDragPlan({
    ...base, dy: -40, trackPitch: 40, track: 2, maxTrack: 4, invertedRows: false,
  });
  assert.equal(plan.track, 1);
});

test('a convenção do vídeo continua sendo o padrão', () => {
  // Omitir o parâmetro tem que dar exatamente o comportamento antigo.
  const comPadrao = clipDragPlan({ ...base, dy: 40, trackPitch: 40, track: 2, maxTrack: 4 });
  const explicito = clipDragPlan({
    ...base, dy: 40, trackPitch: 40, track: 2, maxTrack: 4, invertedRows: true,
  });
  assert.deepEqual(comPadrao, explicito);
});
