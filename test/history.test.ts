import test from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../src/engine/history.ts';

/** Estados são só rótulos aqui: o que se testa é o caminho pela pilha. */
const h = (initial = 'A', opts = {}) => new History<string>(initial, opts);

// --- o básico -----------------------------------------------------------

test('começa no estado inicial, sem nada pra desfazer', () => {
  const hist = h('A');
  assert.equal(hist.current, 'A');
  assert.equal(hist.canUndo, false, 'não existe nada antes do início');
  assert.equal(hist.canRedo, false);
});

test('desfazer e refazer andam pela pilha', () => {
  const hist = h('A');
  hist.push('B');
  hist.push('C');

  assert.equal(hist.current, 'C');
  assert.equal(hist.undo(), 'B');
  assert.equal(hist.undo(), 'A');
  assert.equal(hist.canUndo, false, 'chegou no chão');
  assert.equal(hist.redo(), 'B');
  assert.equal(hist.redo(), 'C');
  assert.equal(hist.canRedo, false);
});

test('desfazer no chão devolve null em vez de estourar', () => {
  const hist = h('A');
  assert.equal(hist.undo(), null);
  assert.equal(hist.current, 'A', 'e não mexe no estado');
});

test('refazer no topo devolve null', () => {
  const hist = h('A');
  hist.push('B');
  assert.equal(hist.redo(), null);
});

test('editar depois de desfazer descarta o futuro', () => {
  // O ramo que você abandonou não pode voltar por Ctrl+Y.
  const hist = h('A');
  hist.push('B');
  hist.push('C');
  hist.undo();              // volta pra B

  hist.push('D');
  assert.equal(hist.current, 'D');
  assert.equal(hist.canRedo, false, 'C deixou de existir');
  assert.equal(hist.undo(), 'B', 'e o passado continua intacto');
});

// --- fusão de edições contínuas -----------------------------------------

test('edições com a mesma chave, juntas no tempo, viram um passo só', () => {
  // É o caso do arrasto de trim: uma edição por pointermove.
  const hist = h('A');
  for (let i = 1; i <= 50; i++) hist.push(`drag${i}`, { mergeKey: 'trim:1', now: i * 10 });

  assert.equal(hist.depth, 2, 'estado inicial + um passo pro gesto inteiro');
  assert.equal(hist.current, 'drag50', 'mas guarda o resultado final');
  assert.equal(hist.undo(), 'A', 'um Ctrl+Z desfaz o gesto todo');
});

test('a janela conta do último toque, não do primeiro', () => {
  // Um arrasto longo continua sendo um gesto só enquanto você não solta.
  const hist = h('A', { mergeWindowMs: 500 });
  hist.push('x', { mergeKey: 'k', now: 0 });
  hist.push('y', { mergeKey: 'k', now: 400 });
  hist.push('z', { mergeKey: 'k', now: 800 });

  assert.equal(hist.depth, 2, '800ms desde o início, mas 400 desde o anterior');
});

test('passada a janela, vira um passo novo', () => {
  const hist = h('A', { mergeWindowMs: 500 });
  hist.push('x', { mergeKey: 'k', now: 0 });
  hist.push('y', { mergeKey: 'k', now: 900 });

  assert.equal(hist.depth, 3, 'você parou e recomeçou: são duas ações');
});

test('chaves diferentes nunca se fundem', () => {
  const hist = h('A');
  hist.push('x', { mergeKey: 'size', now: 0 });
  hist.push('y', { mergeKey: 'cor', now: 10 });
  assert.equal(hist.depth, 3);
});

test('sem chave, cada edição é um passo — o padrão de ações discretas', () => {
  // Adicionar layer, excluir, reordenar: cada uma vale por si.
  const hist = h('A');
  hist.push('x', { now: 0 });
  hist.push('y', { now: 1 });
  assert.equal(hist.depth, 3);
});

test('a fusão nunca engole o estado inicial', () => {
  // Senão a primeira edição do projeto ficaria impossível de desfazer.
  const hist = h('A');
  hist.push('B', { mergeKey: 'k', now: 0 });
  hist.push('C', { mergeKey: 'k', now: 10 });

  assert.equal(hist.undo(), 'A', 'dá pra voltar ao começo');
  assert.equal(hist.depth, 2);
});

test('a fusão não passa por cima de um redo pendente', () => {
  // Depois de desfazer, qualquer edição é um ramo novo — mesmo que a chave
  // bata com a da entrada onde o ponteiro parou.
  const hist = h('A');
  hist.push('B', { mergeKey: 'k', now: 0 });
  hist.push('C', { mergeKey: 'outra', now: 10 });
  hist.undo();                                   // ponteiro em B

  hist.push('D', { mergeKey: 'k', now: 20 });
  assert.equal(hist.canRedo, false, 'C foi descartado, não fundido');
  assert.equal(hist.undo(), 'B', 'B continua sendo um passo próprio');
});

// --- teto de memória ----------------------------------------------------

test('o teto descarta o passo mais antigo', () => {
  const hist = h('A', { limit: 3 });
  hist.push('B');
  hist.push('C');
  hist.push('D');   // estoura: 'A' cai

  assert.equal(hist.depth, 3);
  assert.equal(hist.undo(), 'C');
  assert.equal(hist.undo(), 'B');
  assert.equal(hist.canUndo, false, 'o começo foi descartado, e o ponteiro sabe disso');
});

// --- recomeçar ----------------------------------------------------------

test('reset zera a pilha — projeto novo ou carregado do disco', () => {
  const hist = h('A');
  hist.push('B');
  hist.reset('Z');

  assert.equal(hist.current, 'Z');
  assert.equal(hist.canUndo, false, 'não dá pra desfazer de volta pro projeto anterior');
  assert.equal(hist.canRedo, false);
  assert.equal(hist.depth, 1);
});

// --- avisos -------------------------------------------------------------

test('avisa quem escuta a cada mudança', () => {
  const hist = h('A');
  let avisos = 0;
  const unsub = hist.subscribe(() => { avisos++; });

  hist.push('B');
  hist.undo();
  hist.redo();
  assert.equal(avisos, 3, 'os botões precisam reagir a push, undo e redo');

  unsub();
  hist.push('C');
  assert.equal(avisos, 3, 'e param de ser avisados ao desinscrever');
});

test('undo que não anda não avisa à toa', () => {
  const hist = h('A');
  let avisos = 0;
  hist.subscribe(() => { avisos++; });
  hist.undo();
  assert.equal(avisos, 0, 'nada mudou, ninguém precisa re-renderizar');
});
