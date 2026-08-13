import test from 'node:test';
import assert from 'node:assert/strict';
import { soundSyncPlan, soundElement } from '../src/engine/audioSync.ts';
import { audioLayer, videoLayer } from './fixtures.ts';

/** Música de 60s, colocada em t=2, mostrando a partir de 1s do arquivo. */
const trilha = () => audioLayer({ start: 2, duration: 10, trimStart: 1, sourceDuration: 60 });

const rodando = { playing: true, currentTime: 0, paused: false, seeking: false };

// --- silêncio -----------------------------------------------------------

test('parado não toca nada e não posiciona nada', () => {
  // Não existe scrub sonoro: arrastar o cursor tocando pedacinhos é ruído.
  // E um seek com o player pausado gastaria decoder pra ninguém ouvir.
  const plan = soundSyncPlan(trilha(), 5, { playing: false, currentTime: 0 });
  assert.deepEqual(plan, { seekTo: null, play: false, volume: 1 });
});

test('fora do trecho do clipe, silêncio', () => {
  assert.equal(soundSyncPlan(trilha(), 1.9, rodando).play, false, 'antes');
  assert.equal(soundSyncPlan(trilha(), 12, rodando).play, false, 'depois');
});

// --- volume -------------------------------------------------------------

test('o volume é aplicado mesmo com a trilha parada', () => {
  // Você ajusta o volume com o vídeo pausado e espera que valha no play
  // seguinte, sem ter que tocar de novo.
  const plan = soundSyncPlan(trilha(), 5, { playing: false, currentTime: 0 });
  assert.equal(plan.volume, 1);

  const baixo = soundSyncPlan(audioLayer({ volume: 0.3 }), 5, { playing: false, currentTime: 0 });
  assert.equal(baixo.volume, 0.3);
});

test('mudo zera o volume em vez de virar um caso especial', () => {
  // O silêncio sai do volume, não de um segundo interruptor: dois caminhos
  // pro mesmo efeito criam estado contraditório mais à frente.
  const calada = soundSyncPlan(audioLayer({ mute: true, start: 0, duration: 10 }), 5, rodando);
  assert.equal(calada.volume, 0);
  assert.equal(calada.play, true, 'segue rodando, mas em silêncio');
});

// --- entrada ------------------------------------------------------------

test('entrando agora, posiciona exato antes de soltar', () => {
  // Com o elemento parado o seek não custa nada: ninguém está ouvindo ainda.
  const plan = soundSyncPlan(trilha(), 4, { playing: true, currentTime: 0, paused: true });
  assert.equal(plan.seekTo, 3, 'trim 1 + 2s adentro do clipe');
  assert.equal(plan.play, true);
});

// --- deriva -------------------------------------------------------------

test('deriva pequena é deixada em paz', () => {
  // Cada correção é um clique audível: corrigir demais é pior que derivar.
  const plan = soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 3.05 });
  assert.equal(plan.seekTo, null);
  assert.equal(plan.play, true);
});

test('deriva grande corrige por SEEK, não por velocidade', () => {
  // Mudar a velocidade mudaria o tom, e desafinação é bem mais audível que
  // um quadro repetido é visível — o contrário do que o vídeo faz.
  const plan = soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 1 });
  assert.equal(plan.seekTo, 3, 'salta pro instante certo');
});

test('a tolerância do som é bem mais folgada que a do vídeo', () => {
  // 100ms passa reto aqui; no vídeo já teria disparado correção.
  assert.equal(soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 3.1 }).seekTo, null);
  assert.equal(soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 3.2 }).seekTo, 3);
});

test('com um seek em voo, não empilha outro', () => {
  const plan = soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 1, seeking: true });
  assert.equal(plan.seekTo, null, 'empilhar só multiplica os cliques');
  assert.equal(plan.play, true);
});

// --- limites da fonte ---------------------------------------------------

test('clipe esticado além do arquivo não pede tempo inexistente', () => {
  // Pedir tempo que não existe deixa o elemento num estado de erro do qual
  // ele não sai sozinho.
  const curto = audioLayer({ start: 0, duration: 20, trimStart: 0, sourceDuration: 5 });
  const plan = soundSyncPlan(curto, 10, rodando);
  assert.equal(plan.play, false);
  assert.equal(plan.seekTo, null);
});

// --- elemento -----------------------------------------------------------

test('soundElement acha o elemento certo pra cada tipo', () => {
  const a = audioLayer();
  const v = videoLayer();
  assert.equal(soundElement(a), a.audio);
  assert.equal(soundElement(v), v.video, 'a trilha do vídeo sai do próprio <video>');
});
