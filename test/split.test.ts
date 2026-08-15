import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitLayer, compactTracks, topTrack, overlaps, freeWindow, trimLeft, trimRight, MIN_CLIP,
  pasteSlot, topTrackOf,
} from '../src/engine/project.ts';
import { audioLayer, textLayer, videoLayer } from './fixtures.ts';
import type { Layer, VideoLayer } from '../src/engine/types.ts';

// --- corte --------------------------------------------------------------

test('corta um clipe em duas metades que se encostam', () => {
  const layer = textLayer({ start: 2, duration: 4 });     // ocupa 2..6
  const [a, b] = splitLayer(layer, 3.5)!;

  assert.equal(a.start, 2);
  assert.equal(a.duration, 1.5, 'a primeira vai até o corte');
  assert.equal(b.start, 3.5, 'a segunda começa exatamente onde a outra acabou');
  assert.equal(b.duration, 2.5);
  assert.equal(a.start + a.duration, b.start, 'sem buraco nem sobreposição');
});

test('as metades ficam na mesma faixa', () => {
  const [a, b] = splitLayer(textLayer({ track: 3, start: 0, duration: 4 }), 2)!;
  assert.equal(a.track, 3);
  assert.equal(b.track, 3);
});

test('a segunda metade ganha id próprio', () => {
  // Sem isso as duas seriam a mesma layer pro React e pro updateLayer.
  const [a, b] = splitLayer(textLayer({ id: 42, start: 0, duration: 4 }), 2)!;
  assert.equal(a.id, 42, 'a primeira continua sendo a original');
  assert.notEqual(b.id, 42);
});

test('vídeo: a segunda metade avança o ponto de leitura do arquivo', () => {
  // É o detalhe que faz o corte não repetir o trecho que acabou de passar.
  const layer = videoLayer({ start: 2, duration: 4, trimStart: 1, sourceDuration: 30 });
  const [a, b] = splitLayer(layer, 3.5)! as [VideoLayer, VideoLayer];

  assert.equal(a.trimStart, 1, 'a primeira lê do mesmo lugar de antes');
  assert.equal(b.trimStart, 2.5, 'a segunda pula os 1.5s que a primeira mostrou');
});

test('texto não tem material de origem pra avançar', () => {
  const [, b] = splitLayer(textLayer({ start: 0, duration: 4 }), 2)!;
  assert.equal('trimStart' in b, false);
});

test('os efeitos são copiados, não compartilhados', () => {
  // As metades viram clipes independentes; editar os efeitos de uma não pode
  // mexer na outra.
  const layer = textLayer({
    start: 0, duration: 4,
    effects: [{ name: 'fade', tracks: [{ prop: 'opacity', keys: [[0, 0], [1, 1]] }] }],
  });
  const [a, b] = splitLayer(layer, 2)!;

  assert.deepEqual(b.effects, a.effects, 'mesmo conteúdo');
  assert.notEqual(b.effects, a.effects, 'mas não o mesmo array');
  assert.notEqual(b.effects[0], a.effects[0], 'nem o mesmo efeito');
});

// --- quando o corte não vale --------------------------------------------

test('cortar fora do clipe não faz nada', () => {
  const layer = textLayer({ start: 2, duration: 4 });     // 2..6
  assert.equal(splitLayer(layer, 1), null, 'antes do começo');
  assert.equal(splitLayer(layer, 7), null, 'depois do fim');
});

test('cortar rente à ponta não cria um clipe grudado de milissegundos', () => {
  // Um clipe de 3ms você não consegue nem pegar pra apagar.
  const layer = textLayer({ start: 2, duration: 4 });
  assert.equal(splitLayer(layer, 2), null, 'exatamente no começo');
  assert.equal(splitLayer(layer, 6), null, 'exatamente no fim');
  assert.equal(splitLayer(layer, 2 + MIN_CLIP / 2), null, 'meio mínimo do começo');
});

test('cortar no limite mínimo é permitido', () => {
  const layer = textLayer({ start: 0, duration: 4 });
  const cut = splitLayer(layer, MIN_CLIP);
  assert.notEqual(cut, null);
  assert.equal(cut![0].duration, MIN_CLIP);
});

test('o original não é mutado', () => {
  const layer = textLayer({ start: 2, duration: 4 });
  splitLayer(layer, 3);
  assert.equal(layer.duration, 4, 'o estado do React não pode ser alterado no lugar');
});

// --- sobreposição -------------------------------------------------------

test('overlaps ignora clipes que só se encostam', () => {
  // Encostar é o caso normal — é o que o corte produz.
  assert.equal(overlaps({ start: 0, duration: 2 }, { start: 2, duration: 2 }), false);
  assert.equal(overlaps({ start: 2, duration: 2 }, { start: 0, duration: 2 }), false);
});

test('overlaps acusa invasão, mesmo mínima', () => {
  assert.equal(overlaps({ start: 0, duration: 2 }, { start: 1.9, duration: 2 }), true);
  assert.equal(overlaps({ start: 0, duration: 5 }, { start: 1, duration: 1 }), true, 'contido');
});

test('poeira de ponto flutuante na emenda NÃO é invasão', () => {
  /**
   * `0.2 + 0.1` dá `0.30000000000000004`. Com o fim fora da grade e o início do
   * vizinho dentro dela, a comparação estrita via uma sobreposição de 4×10⁻¹⁷
   * segundos — e ela era suficiente pra mandar a duplicata pra outra faixa.
   */
  assert.equal(overlaps({ start: 0.2, duration: 0.1 }, { start: 0.3, duration: 0.1 }), false);
  assert.equal(overlaps({ start: 0, duration: 1 / 3 }, { start: 0.333, duration: 0.1 }), false);
});

test('Ctrl+D repetido mantém a faixa enquanto houver espaço à frente', () => {
  /**
   * O sintoma relatado: duplicar um clipe várias vezes e, da terceira ou quarta
   * em diante, a cópia ir parar na faixa de cima "sem necessidade". Nunca foi
   * escolha de colocação — era a emenda entre a cópia anterior e a nova sendo
   * lida como colisão. Ver `overlaps`.
   *
   * Anda como o `duplicateSelected`: cada cópia nasce logo depois da anterior.
   */
  let layers = [{ id: 1, type: 'video', track: 0, start: 0, duration: 0.1 } as unknown as Layer];
  let sel = layers[0] as Layer;

  for (let i = 0; i < 8; i++) {
    const span = { start: +(sel.start + sel.duration).toFixed(3), duration: sel.duration };
    const slot = pasteSlot(layers, span, sel.track, 'visual');
    assert.equal(slot.track, 0, `a cópia ${i + 1} saiu da faixa 0`);
    const copia = { ...sel, id: 100 + i, ...slot } as Layer;
    layers = [...layers, copia];
    sel = copia;
  }
});

test('duplicar em cima de um clipe existente AINDA sobe de faixa', () => {
  // A correção não pode ter apagado o motivo de `pasteSlot` existir: quando o
  // lugar está de fato ocupado, subir é o certo.
  const layers = [
    { id: 1, type: 'video', track: 0, start: 0, duration: 2 },
    { id: 2, type: 'video', track: 0, start: 2, duration: 2 },
  ] as unknown as Layer[];

  assert.equal(pasteSlot(layers, { start: 2, duration: 2 }, 0, 'visual').track, 1);
});

// --- faixas -------------------------------------------------------------

test('topTrack acha a faixa mais alta em uso', () => {
  assert.equal(topTrack([textLayer({ track: 0 }), textLayer({ track: 4 })]), 4);
  assert.equal(topTrack([]), -1, 'projeto vazio não tem faixa nenhuma');
});

test('compactTracks fecha os buracos deixados por uma faixa esvaziada', () => {
  // Sem isso, arrastar o único clipe de uma faixa deixaria uma linha fantasma,
  // e o editor iria acumulando faixas vazias a cada gesto.
  const layers = [textLayer({ id: 1, track: 0 }), textLayer({ id: 2, track: 5 })];
  const out = compactTracks(layers);

  assert.equal(out[0]?.track, 0);
  assert.equal(out[1]?.track, 1);
});

test('compactTracks preserva a ordem relativa das faixas', () => {
  // Compactar não pode reordenar o que está na tela.
  const out = compactTracks([
    textLayer({ id: 1, track: 9 }),
    textLayer({ id: 2, track: 3 }),
    textLayer({ id: 3, track: 6 }),
  ]);
  assert.equal(out.find(l => l.id === 2)?.track, 0, 'a mais baixa continua embaixo');
  assert.equal(out.find(l => l.id === 3)?.track, 1);
  assert.equal(out.find(l => l.id === 1)?.track, 2, 'a mais alta continua no topo');
});

test('compactTracks mantém juntos os clipes que dividem faixa', () => {
  const out = compactTracks([
    textLayer({ id: 1, track: 7, start: 0 }),
    textLayer({ id: 2, track: 7, start: 5 }),
    textLayer({ id: 3, track: 2 }),
  ]);
  assert.equal(out.find(l => l.id === 1)?.track, 1);
  assert.equal(out.find(l => l.id === 2)?.track, 1, 'os dois continuam na mesma faixa');
});

test('compactTracks não recria objetos à toa', () => {
  // Layer que não mudou tem que continuar sendo o MESMO objeto: é o que faz o
  // histórico de undo compartilhar estrutura em vez de duplicar o projeto.
  const a = textLayer({ id: 1, track: 0 });
  const b = textLayer({ id: 2, track: 1 });
  const out = compactTracks([a, b]);

  assert.equal(out[0], a, 'nada mudou nesta');
  assert.equal(out[1], b);
});

// --- trim com vizinhos na mesma faixa -----------------------------------
// Passou a fazer falta quando uma faixa deixou de ter um clipe só: sem limite,
// esticar a alça comeria o clipe vizinho.

test('freeWindow acha o espaço livre em volta do clipe', () => {
  const alvo = textLayer({ id: 2, track: 0, start: 5, duration: 2 });   // 5..7
  const layers = [
    textLayer({ id: 1, track: 0, start: 0, duration: 3 }),              // 0..3
    alvo,
    textLayer({ id: 3, track: 0, start: 9, duration: 2 }),              // 9..11
  ];

  assert.deepEqual(freeWindow(layers, alvo), { minStart: 3, maxEnd: 9 });
});

test('freeWindow ignora clipes de outras faixas', () => {
  const alvo = textLayer({ id: 2, track: 1, start: 5, duration: 2 });
  const layers = [textLayer({ id: 1, track: 0, start: 0, duration: 20 }), alvo];

  assert.deepEqual(freeWindow(layers, alvo), { minStart: 0, maxEnd: Infinity });
});

test('freeWindow sozinho na faixa não impõe limite', () => {
  const alvo = textLayer({ id: 1, track: 0, start: 5, duration: 2 });
  assert.deepEqual(freeWindow([alvo], alvo), { minStart: 0, maxEnd: Infinity });
});

test('trimRight para no começo do vizinho', () => {
  const alvo = { start: 5, duration: 2 };                 // 5..7
  const patch = trimRight(alvo, 99, { maxEnd: 9 });
  assert.equal(patch?.duration, 4, 'esticou até 9 e parou');
});

test('trimLeft para no fim do vizinho anterior', () => {
  const alvo = { start: 5, duration: 2 };
  const patch = trimLeft(alvo, -99, { minStart: 3 });
  assert.equal(patch?.start, 3, 'recuou até 3 e parou');
  assert.equal(patch?.duration, 4);
});

test('sem vizinho, o trim continua limitado só pela fonte', () => {
  // A regra antiga não pode ter sido substituída, só somada.
  const clipe = { start: 5, duration: 2, trimStart: 0, sourceDuration: 3 };
  assert.equal(trimRight(clipe, 99)?.duration, 3, 'limitado pelo arquivo');
});

// --- colar --------------------------------------------------------------

test('colar cai na faixa de origem quando ela está livre', () => {
  // Colar perto do original tem que manter a camada — senão a ordem de desenho
  // muda sozinha e o resultado não é o que se viu ao copiar.
  const layers = [textLayer({ id: 1, track: 2, start: 0, duration: 2 })];
  const slot = pasteSlot(layers, { start: 5, duration: 2 }, 2);
  assert.deepEqual(slot, { start: 5, track: 2 });
});

test('faixa de origem ocupada: sobe pra próxima livre', () => {
  const layers = [
    textLayer({ id: 1, track: 0, start: 4, duration: 4 }),
    textLayer({ id: 2, track: 1, start: 0, duration: 1 }),
  ];
  assert.equal(pasteSlot(layers, { start: 5, duration: 2 }, 0).track, 1);
});

test('nenhuma faixa serve: abre uma nova no topo', () => {
  // Recusar seria a pior resposta: a pessoa acabou de mandar colar.
  const layers = [
    textLayer({ id: 1, track: 0, start: 0, duration: 10 }),
    textLayer({ id: 2, track: 1, start: 0, duration: 10 }),
  ];
  assert.equal(pasteSlot(layers, { start: 5, duration: 2 }, 0).track, 2);
});

test('encostar não é sobrepor', () => {
  // Um clipe terminando exatamente onde o outro começa é o caso normal — é o
  // que um corte produz.
  const layers = [textLayer({ id: 1, track: 0, start: 0, duration: 5 })];
  assert.equal(pasteSlot(layers, { start: 5, duration: 2 }, 0).track, 0);
});

test('projeto vazio aceita colar na faixa 0', () => {
  assert.deepEqual(pasteSlot([], { start: 3, duration: 2 }, 0), { start: 3, track: 0 });
});

// --- espaços de faixa separados -----------------------------------------

const musica = (over = {}) => audioLayer({ mediaId: 'm', ...over });

test('a faixa 0 do áudio não é a faixa 0 do vídeo', () => {
  // A ambiguidade que o modelo antigo tinha: nada distinguia as duas.
  const layers = [textLayer({ id: 1, track: 0, start: 0, duration: 10 }), musica({ id: 2, track: 0 })];
  assert.equal(topTrackOf(layers, 'visual'), 0);
  assert.equal(topTrackOf(layers, 'audio'), 0);
});

test('compactar renumera cada tipo por conta própria', () => {
  // Juntos, uma faixa de áudio passaria a depender de quantas de vídeo existem.
  const compactado = compactTracks([
    textLayer({ id: 1, track: 5 }),
    textLayer({ id: 2, track: 9 }),
    musica({ id: 3, track: 7 }),
  ]);
  assert.deepEqual(compactado.map(l => l.track), [0, 1, 0]);
});

test('um áudio não bloqueia a faixa de mesmo número no vídeo', () => {
  // Colar um texto na faixa 0 tem que caber, mesmo com música ocupando a
  // faixa 0 do áudio no mesmo instante.
  const layers = [musica({ id: 1, track: 0, start: 0, duration: 30 })];
  assert.deepEqual(pasteSlot(layers, { start: 5, duration: 2 }, 0, 'visual'), { start: 5, track: 0 });
});

test('colar áudio procura faixa entre os ÁUDIOS', () => {
  const layers = [
    textLayer({ id: 1, track: 0, start: 0, duration: 30 }),
    musica({ id: 2, track: 0, start: 0, duration: 30 }),
  ];
  // A faixa 0 do áudio está ocupada; a 0 do vídeo não conta pra essa decisão.
  assert.equal(pasteSlot(layers, { start: 5, duration: 2 }, 0, 'audio').track, 1);
});

test('o trim de um áudio não enxerga o vídeo da faixa de mesmo número', () => {
  const alvo = musica({ id: 1, track: 0, start: 5, duration: 5 });
  const janela = freeWindow([alvo, textLayer({ id: 2, track: 0, start: 0, duration: 4.5 })], alvo);
  assert.equal(janela.minStart, 0, 'o texto vizinho não limita o áudio');
});
