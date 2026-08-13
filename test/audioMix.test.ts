import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mixPlan, soundLayers, effectiveGain, sourceTimeOf, hasSound, isSoundActive,
} from '../src/engine/audioMix.ts';
import { audioLayer, videoLayer, textLayer, imageLayer } from './fixtures.ts';

const TRECHO = { from: 0, to: 30 };

// --- quem produz som ----------------------------------------------------

test('vídeo conta como fonte de som, junto com o áudio', () => {
  // A trilha de um clipe de vídeo é som como qualquer outro; tratá-la à parte
  // duplicaria volume, mudo e mixagem em dois caminhos.
  const layers = [textLayer(), imageLayer(), videoLayer(), audioLayer()];
  assert.deepEqual(soundLayers(layers).map(l => l.type), ['video', 'audio']);
});

test('texto e imagem nunca entram na mixagem', () => {
  assert.deepEqual(mixPlan([textLayer(), imageLayer()], TRECHO), []);
});

// --- ganho --------------------------------------------------------------

test('mudo zera o ganho', () => {
  assert.equal(effectiveGain({ volume: 1, mute: true }), 0);
});

test('o ganho é preso em 0..1', () => {
  // Fora dessa faixa o elemento de mídia lança, e derrubaria a reprodução.
  assert.equal(effectiveGain({ volume: 5 }), 1);
  assert.equal(effectiveGain({ volume: -2 }), 0);
  assert.equal(effectiveGain({ volume: NaN }), 1, 'valor inválido volta ao padrão');
  assert.equal(effectiveGain({}), 1, 'sem volume declarado, toca cheio');
});

test('layer no mudo não entra no plano', () => {
  assert.deepEqual(mixPlan([audioLayer({ mute: true })], TRECHO), []);
});

test('volume zero também não entra', () => {
  // Agendar uma fonte silenciosa custa decodificação e não produz nada.
  assert.deepEqual(mixPlan([audioLayer({ volume: 0 })], TRECHO), []);
});

// --- posição e trim -----------------------------------------------------

test('um clipe inteiro dentro do trecho entra como está', () => {
  const plan = mixPlan([audioLayer({ start: 2, duration: 4, trimStart: 1 })], TRECHO);
  assert.deepEqual(plan[0], {
    layerId: 4, mediaId: 'media-audio', at: 2, offset: 1, duration: 4, gain: 1,
  });
});

test('música que começa antes do trecho entra PELO MEIO', () => {
  // É o erro que faz o export soar diferente do preview: exportar de 10s a 20s
  // não pode reiniciar a música em 10s.
  const musica = audioLayer({ start: 0, duration: 30, trimStart: 0, sourceDuration: 60 });
  const plan = mixPlan([musica], { from: 10, to: 20 });

  assert.equal(plan[0]?.at, 0, 'entra logo no começo do arquivo exportado');
  assert.equal(plan[0]?.offset, 10, 'mas lendo a fonte a partir de 10s');
  assert.equal(plan[0]?.duration, 10);
});

test('o trim soma ao deslocamento do trecho', () => {
  const clipe = audioLayer({ start: 0, duration: 30, trimStart: 5, sourceDuration: 60 });
  const plan = mixPlan([clipe], { from: 10, to: 20 });
  assert.equal(plan[0]?.offset, 15, 'trim 5 + 10s adentro do clipe');
});

test('clipe que começa depois do trecho entra atrasado', () => {
  const plan = mixPlan([audioLayer({ start: 15, duration: 5 })], { from: 10, to: 30 });
  assert.equal(plan[0]?.at, 5, '15s na timeline são 5s no arquivo que começa em 10');
  assert.equal(plan[0]?.offset, 0, 'e lê a fonte do começo');
});

test('a cauda é cortada no fim do trecho', () => {
  const plan = mixPlan([audioLayer({ start: 0, duration: 30 })], { from: 0, to: 10 });
  assert.equal(plan[0]?.duration, 10, 'não vaza pra fora do que foi pedido');
});

// --- limites da fonte ---------------------------------------------------

test('nunca pede mais material do que o arquivo tem', () => {
  // Um clipe esticado além da fonte pediria áudio que não existe.
  const clipe = audioLayer({ start: 0, duration: 20, trimStart: 0, sourceDuration: 8 });
  assert.equal(mixPlan([clipe], TRECHO)[0]?.duration, 8);
});

test('clipe cujo trim já passou do fim do arquivo é descartado', () => {
  const clipe = audioLayer({ start: 0, duration: 5, trimStart: 40, sourceDuration: 30 });
  assert.deepEqual(mixPlan([clipe], TRECHO), [], 'tocaria silêncio, ou lançaria');
});

test('deslocamento negativo é descartado em vez de lançar', () => {
  // Aconteceria com um trim negativo vindo de um arquivo mexido à mão.
  const clipe = audioLayer({ start: 0, duration: 5, trimStart: -3 });
  assert.deepEqual(mixPlan([clipe], TRECHO), []);
});

// --- fora do trecho -----------------------------------------------------

test('clipe totalmente fora do trecho não entra', () => {
  const antes = audioLayer({ id: 1, start: 0, duration: 5 });
  const depois = audioLayer({ id: 2, start: 40, duration: 5 });
  assert.deepEqual(mixPlan([antes, depois], { from: 10, to: 20 }), []);
});

test('clipe que só encosta na ponta não entra', () => {
  // Duração zero seria uma fonte agendada pra não produzir nada.
  const clipe = audioLayer({ start: 0, duration: 10 });
  assert.deepEqual(mixPlan([clipe], { from: 10, to: 20 }), []);
});

// --- várias trilhas -----------------------------------------------------

test('trilhas simultâneas convivem no plano', () => {
  // É o ponto da mixagem: música de fundo mais o som do vídeo.
  const plan = mixPlan([
    audioLayer({ id: 1, start: 0, duration: 30, sourceDuration: 60 }),
    videoLayer({ id: 2, start: 5, duration: 10, sourceDuration: 60, volume: 0.4 }),
  ], TRECHO);

  assert.equal(plan.length, 2);
  assert.equal(plan[1]?.gain, 0.4, 'cada uma com o próprio ganho');
});

test('o plano sai ordenado pelo instante de entrada', () => {
  const plan = mixPlan([
    audioLayer({ id: 2, start: 10, duration: 5 }),
    audioLayer({ id: 1, start: 2, duration: 5 }),
  ], TRECHO);
  assert.deepEqual(plan.map(c => c.layerId), [1, 2]);
});

// --- atalhos ------------------------------------------------------------

test('hasSound evita montar contexto de áudio à toa', () => {
  assert.equal(hasSound([textLayer()], TRECHO), false);
  assert.equal(hasSound([audioLayer()], TRECHO), true);
  assert.equal(hasSound([audioLayer({ mute: true })], TRECHO), false);
});

test('sourceTimeOf mapeia a timeline no arquivo', () => {
  assert.equal(sourceTimeOf({ start: 2, trimStart: 1 }, 4), 3);
  assert.equal(sourceTimeOf({ start: 0 }, 5), 5, 'sem trim declarado');
});

test('a ponta final do som é exclusiva, ao contrário da do vídeo', () => {
  // O quadro final de um clipe visual ainda aparece; som tocando um instante
  // além do fim do clipe se ouve como estalo.
  const clipe = { start: 2, duration: 4 };
  assert.equal(isSoundActive(clipe, 2), true, 'começo é inclusivo');
  assert.equal(isSoundActive(clipe, 5.99), true);
  assert.equal(isSoundActive(clipe, 6), false, 'fim é exclusivo');
});
