import test from 'node:test';
import assert from 'node:assert/strict';
import {
  videoSyncPlan, sourceTimeAt, isLayerActive, previewBusyState, hasActiveVideo,
  syncVideoLayers, claimVideoElements, releaseVideoElements, videoElementsOwner,
  videoOwners,
} from '../src/engine/videoSync.ts';
import type { VideoTiming } from '../src/engine/types.ts';
import { fakeVideo, project, textLayer, videoLayer } from './fixtures.ts';

/** A 10s source, placed at t=2, showing seconds 1..5 of the file (trimStart=1). */
const clip = (): VideoTiming => ({ start: 2, duration: 4, trimStart: 1, sourceDuration: 10 });

test('outside the clip span: never seeks, never plays', () => {
  const c = clip();
  assert.deepEqual(
    videoSyncPlan(c, 1.9, { playing: true, currentTime: 0, paused: true }),
    { seekTo: null, play: false, rate: 1 },
  );
  assert.deepEqual(
    videoSyncPlan(c, 6.1, { playing: true, currentTime: 5, paused: false }),
    { seekTo: null, play: false, rate: 1 },
  );
});

test('playing, in sync: lets the element run, no seek', () => {
  const c = clip();
  // t=4 in the timeline -> source time 3 (sourceTimeAt = trimStart + (t - start))
  const plan = videoSyncPlan(c, 4, { playing: true, currentTime: 3.02, paused: false });
  assert.equal(plan.seekTo, null, 'small drift is left alone');
  assert.equal(plan.play, true);
  assert.equal(plan.rate, 1, 'sem desvio relevante, velocidade normal');
});

// --- correção de deriva durante a reprodução ----------------------------
// Este bloco existe por causa de um defeito concreto: corrigir por seek com o
// elemento rolando desenhava o quadro onde ele já estava, depois o quadro do
// seek (atrás dele) e só então o seguinte. Na tela: volta um, pula dois.

test('rolando com desvio pequeno: corrige pela velocidade, NUNCA por seek', () => {
  const c = clip();
  // want = 3, elemento em 2.85 -> 150ms atrasado, bem acima da tolerância.
  const plan = videoSyncPlan(c, 4, { playing: true, currentTime: 2.85, paused: false });
  assert.equal(plan.seekTo, null, 'um seek aqui é exatamente o bug');
  assert.ok(plan.rate > 1, 'atrasado: acelera pra encostar');
  assert.ok(plan.rate <= 1.12, 'mas nunca a ponto de a aceleração ficar visível');
});

test('rolando adiantado: desacelera em vez de saltar pra trás', () => {
  const c = clip();
  const plan = videoSyncPlan(c, 4, { playing: true, currentTime: 3.15, paused: false });
  assert.equal(plan.seekTo, null);
  assert.ok(plan.rate < 1, 'adiantado: segura');
  assert.ok(plan.rate >= 0.88);
});

test('a correção de velocidade é limitada mesmo com desvio grande', () => {
  const c = clip();
  // 0.4s de atraso: ainda abaixo do ponto de corte, então é velocidade — mas no teto.
  const plan = videoSyncPlan(c, 4, { playing: true, currentTime: 2.6, paused: false });
  assert.equal(plan.seekTo, null);
  assert.equal(plan.rate, 1.12);
});

test('rolando e perdido de vez: aí sim corta pro instante certo', () => {
  const c = clip();
  // 2s fora — travou, ou o loop voltou ao início. Velocidade não alcança.
  const plan = videoSyncPlan(c, 4, { playing: true, currentTime: 1.0, paused: false });
  assert.equal(plan.seekTo, 3, 'seeks to the exact source time');
  assert.equal(plan.play, true);
  assert.equal(plan.rate, 1);
});

test('com um seek já em voo, não empilha outro', () => {
  const c = clip();
  // Sem esta guarda, cada quadro pedia mais uma correção enquanto a anterior
  // ainda nem tinha pousado — o decoder afundava e a deriva só crescia.
  const plan = videoSyncPlan(c, 4, { playing: true, currentTime: 1.0, paused: false, seeking: true });
  assert.equal(plan.seekTo, null);
  assert.equal(plan.play, true);
});

test('prestes a entrar (ainda pausado): posiciona exato antes de soltar', () => {
  const c = clip();
  // Com o elemento parado o seek é invisível — não há movimento pra interromper.
  const plan = videoSyncPlan(c, 4, { playing: true, currentTime: 0, paused: true });
  assert.equal(plan.seekTo, 3, 'começa no lugar certo em vez de corrigir depois');
  assert.equal(plan.play, true);
});

test('paused: snaps to the exact frame even for small drift', () => {
  const c = clip();
  const plan = videoSyncPlan(c, 4, { playing: false, currentTime: 3.02, paused: true });
  assert.equal(plan.seekTo, 3, 'scrubbing wants precision, not tolerance');
  assert.equal(plan.play, false);
});

test('paused, already exact: no redundant seek', () => {
  const c = clip();
  const plan = videoSyncPlan(c, 4, { playing: false, currentTime: 3, paused: true });
  assert.equal(plan.seekTo, null, 'below SEEK_EPSILON, left alone');
  assert.equal(plan.play, false);
});

test('want is clamped to the source duration', () => {
  const c = clip();   // sourceDuration=10, trimStart=1 -> source time caps at 10
  const plan = videoSyncPlan(c, 100, { playing: false, currentTime: 0, paused: true });
  // layer inactive at t=100 (way past start+duration=6) so this is a null-op
  assert.deepEqual(plan, { seekTo: null, play: false, rate: 1 });
});

test('sourceTimeAt and isLayerActive agree with the plan boundaries', () => {
  const c = clip();
  assert.equal(sourceTimeAt(c, c.start), c.trimStart, 'clip start reads the trim point');
  assert.equal(isLayerActive(c, c.start + c.duration), true, 'end of span is inclusive');
});

// --- previewBusyState ---------------------------------------------------
// A sonda só lê `seeking` e `readyState`; o resto do elemento é irrelevante.

const projectWith = (video: HTMLVideoElement) =>
  project([videoLayer({ ...clip(), video })]);

test('previewBusyState acusa ocupado enquanto o decoder busca o frame', () => {
  const p = projectWith(fakeVideo({ seeking: true }));
  const st = previewBusyState(p, 4);
  assert.equal(st.busy, true);
  assert.equal(st.reason, 'decodificando');
});

test('previewBusyState acusa ocupado quando ainda não há frame disponível', () => {
  const p = projectWith(fakeVideo({ readyState: 1 }));
  assert.deepEqual(previewBusyState(p, 4), { busy: true, reason: 'carregando' });
});

test('previewBusyState fica quieto com o vídeo pronto', () => {
  const p = projectWith(fakeVideo());
  assert.deepEqual(previewBusyState(p, 4), { busy: false, reason: null });
});

test('vídeo fora da faixa atual não acende a barra', () => {
  // Buffering de um clipe que nem está na tela não é espera percebida.
  const p = projectWith(fakeVideo({ seeking: true }));
  assert.equal(previewBusyState(p, 50).busy, false, 't=50 está fora do clipe (2..6)');
});

test('layers sem vídeo são ignoradas pela sonda', () => {
  const p = project([textLayer({ start: 0, duration: 10 })]);
  assert.equal(previewBusyState(p, 1).busy, false);
});

// --- hasActiveVideo -----------------------------------------------------

test('hasActiveVideo enxerga vídeo na faixa atual', () => {
  const p = projectWith(fakeVideo());
  assert.equal(hasActiveVideo(p, 4), true, 't=4 está dentro do clipe (2..6)');
});

test('hasActiveVideo ignora vídeo fora da faixa', () => {
  // Importa porque frames sem vídeo na tela são fiéis mesmo capturados
  // durante a reprodução — não precisam ser marcados como aproximados.
  const p = projectWith(fakeVideo());
  assert.equal(hasActiveVideo(p, 50), false);
});

test('hasActiveVideo ignora layers de texto', () => {
  const p = project([textLayer({ start: 0, duration: 10 })]);
  assert.equal(hasActiveVideo(p, 1), false);
});

test('hasActiveVideo ignora layer de vídeo sem elemento carregado', () => {
  // Acontece entre criar a layer e o arquivo terminar de abrir.
  const semElemento = videoLayer({ ...clip() });
  semElemento.video = null as unknown as HTMLVideoElement;
  assert.equal(hasActiveVideo(project([semElemento]), 4), false);
});

// --- posse dos elementos <video> ----------------------------------------

test('syncVideoLayers não mexe nos elementos quando outro dono os reivindicou', () => {
  // Este é o bug que fazia o vídeo pular pra frente e voltar: o pré-render
  // posicionava o <video> num instante e o loop do preview o puxava de volta
  // pra posição do cursor, corrompendo os quadros capturados.
  const video = fakeVideo({ currentTime: 5 });
  const p = project([videoLayer({ ...clip(), video })]);

  const dono = {};
  claimVideoElements(dono);
  syncVideoLayers(p, 2);            // pediria currentTime = 1
  assert.equal(video.currentTime, 5, 'o elemento não foi tocado');

  releaseVideoElements(dono);
  syncVideoLayers(p, 2);
  assert.equal(video.currentTime, 1, 'liberado, volta a sincronizar');
});

test('só o dono que reivindicou consegue liberar', () => {
  const dono = {};
  const intruso = {};
  claimVideoElements(dono);

  releaseVideoElements(intruso);
  assert.equal(videoElementsOwner(), dono, 'a posse continua com quem reivindicou');

  releaseVideoElements(dono);
  assert.equal(videoElementsOwner(), null);
});

// --- um elemento, vários clipes -----------------------------------------

/**
 * Cortar um clipe com Ctrl+B deixa as duas metades apontando pro MESMO
 * `<video>` — `splitLayer` copia a layer com spread e a referência vai junto.
 * Deixar as duas conduzirem fazia a inativa pausar o elemento que a ativa
 * tinha acabado de soltar, e o clipe congelava logo depois do corte.
 */
const cortado = () => {
  const video = fakeVideo();
  return project([
    videoLayer({ id: 1, start: 0, duration: 4, trimStart: 0, video, mediaId: 'v' }),
    videoLayer({ id: 2, start: 4, duration: 4, trimStart: 4, video, mediaId: 'v' }),
  ]);
};

test('duas metades do mesmo arquivo elegem UM condutor do elemento', () => {
  assert.equal(videoOwners(cortado(), 2).length, 1);
});

test('quem está no ar conduz, mesmo vindo antes na lista', () => {
  assert.equal(videoOwners(cortado(), 2)[0]?.id, 1, 'no primeiro trecho, a primeira');
  assert.equal(videoOwners(cortado(), 6)[0]?.id, 2, 'no segundo trecho, a segunda');
});

test('passado o último clipe ainda sobra um condutor', () => {
  // De propósito: o plano dele é pausar o elemento, que senão continuaria
  // rolando depois do fim.
  const donos = videoOwners(cortado(), 20);
  assert.equal(donos.length, 1);
  assert.equal(videoSyncPlan(donos[0]!, 20, { playing: true, currentTime: 0 }).play, false);
});

test('vídeos de arquivos diferentes não disputam nada', () => {
  const p = project([
    videoLayer({ id: 1, start: 0, duration: 4, video: fakeVideo(), mediaId: 'um' }),
    videoLayer({ id: 2, start: 10, duration: 4, video: fakeVideo(), mediaId: 'dois' }),
  ]);
  assert.deepEqual(videoOwners(p, 2).map(l => l.id).sort(), [1, 2]);
});

test('layer de vídeo sem elemento carregado fica de fora', () => {
  const p = project([
    videoLayer({ id: 1, video: undefined as unknown as HTMLVideoElement, mediaId: 'v' }),
  ]);
  assert.deepEqual(videoOwners(p, 1), []);
});

test('o condutor eleito é quem de fato move o elemento', () => {
  // A ponta aplicada: em t=6 quem manda é a segunda metade, que lê o arquivo
  // a partir de 4s — logo o elemento tem que pousar em 6, não em 2.
  const p = cortado();
  syncVideoLayers(p, 6);
  assert.equal((p.layers[0] as { video: HTMLVideoElement }).video.currentTime, 6);
});
