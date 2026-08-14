import test from 'node:test';
import assert from 'node:assert/strict';
import { soundSyncPlan, soundElement, soundOwners } from '../src/engine/audioSync.ts';
import { audioLayer, imageLayer, textLayer, videoLayer } from './fixtures.ts';

/** Música de 60s, colocada em t=2, mostrando a partir de 1s do arquivo. */
const trilha = () => audioLayer({ start: 2, duration: 10, trimStart: 1, sourceDuration: 60 });

const rodando = { playing: true, currentTime: 0, paused: false, seeking: false };

// --- silêncio -----------------------------------------------------------

test('parado não toca nada e não posiciona nada', () => {
  // Não existe scrub sonoro: arrastar o cursor tocando pedacinhos é ruído.
  // E um seek com o player pausado gastaria decoder pra ninguém ouvir.
  const plan = soundSyncPlan(trilha(), 5, { playing: false, currentTime: 0 });
  assert.deepEqual(plan, { seekTo: null, play: false, volume: 1, rate: 1 });
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

test('deriva abaixo do que se ouve é deixada em paz', () => {
  // Corrigir o que ninguém percebe só gasta — e mexer no andamento à toa é a
  // receita pra faixa ficar oscilando em torno do relógio.
  const plan = soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 3.02 });
  assert.equal(plan.seekTo, null);
  assert.equal(plan.rate, 1);
  assert.equal(plan.play, true);
});

test('deriva audível corrige por VELOCIDADE, não por seek', () => {
  // Um seek num elemento que está tocando é um corte no som toda vez. Com
  // `preservesPitch`, ±4% de andamento não se percebe e não corta nada.
  const atrasada = soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 2.9 });
  assert.equal(atrasada.seekTo, null, 'sem corte no som');
  assert.ok(atrasada.rate > 1, 'acelera pra alcançar o relógio');

  const adiantada = soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 3.1 });
  assert.equal(adiantada.seekTo, null);
  assert.ok(adiantada.rate < 1, 'segura pra deixar o relógio alcançar');
});

test('a correção de andamento tem teto', () => {
  // Acima de ~4% a faixa soa apressada: trocar um defeito por outro.
  const plan = soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 2.7 });
  assert.equal(plan.rate, 1.04);
});

test('a tolerância do som fica no limiar do que se ouve', () => {
  // 45ms é onde o ouvido começa a pegar o som atrasado em relação à imagem.
  assert.equal(soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 3.04 }).rate, 1);
  assert.notEqual(soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 3.06 }).rate, 1);
});

test('perdido de vez, aí sim corrige por seek', () => {
  // Não é mais deriva, é evento: o loop voltou ao início, ou você arrastou o
  // cursor durante a reprodução. Aqui a velocidade nunca alcançaria.
  const plan = soundSyncPlan(trilha(), 4, { ...rodando, currentTime: 1 });
  assert.equal(plan.seekTo, 3, 'salta pro instante certo');
  assert.equal(plan.rate, 1, 'e volta ao andamento normal');
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

// --- posse do elemento --------------------------------------------------

/**
 * O clipe cortado ao meio: `splitLayer` copia a layer com spread, então as duas
 * metades apontam pro MESMO `<audio>`. Era o que fazia a primeira metade tocar
 * muda — a segunda, mais adiante na lista, pausava o elemento que a primeira
 * tinha acabado de soltar.
 */
const metades = () => [
  audioLayer({ id: 1, start: 0, duration: 4, trimStart: 0 }),
  audioLayer({ id: 2, start: 4, duration: 4, trimStart: 4 }),
];

test('duas metades do mesmo arquivo elegem UMA dona do elemento', () => {
  assert.equal(soundOwners(metades(), 2).length, 1);
});

test('a metade que está soando é quem conduz, mesmo vindo antes na lista', () => {
  // O bug: quem vinha depois vencia sempre, tocando ou não.
  assert.equal(soundOwners(metades(), 2)[0]?.id, 1, 'no primeiro trecho, a primeira');
  assert.equal(soundOwners(metades(), 6)[0]?.id, 2, 'no segundo trecho, a segunda');
});

test('sem ninguém soando ainda sobra uma dona — a que pausa o elemento', () => {
  // Sem isso o elemento ficaria rolando pra sempre depois do último clipe.
  const donas = soundOwners(metades(), 20);
  assert.equal(donas.length, 1);
  assert.equal(soundSyncPlan(donas[0]!, 20, rodando).play, false);
});

test('arquivos diferentes não disputam nada', () => {
  const donas = soundOwners([
    audioLayer({ id: 1, mediaId: 'musica', start: 0, duration: 10 }),
    videoLayer({ id: 2, mediaId: 'clipe', start: 0, duration: 10 }),
  ], 5);
  assert.deepEqual(donas.map(l => l.id).sort(), [1, 2]);
});

test('entre dois clipes do mesmo arquivo soando juntos, vence o de cima', () => {
  // Um elemento tem um cursor só: alguém perde. Que perca por um critério, e
  // sempre o mesmo — o último da lista é o que está na frente.
  const donas = soundOwners([
    audioLayer({ id: 1, track: 0, start: 0, duration: 10 }),
    audioLayer({ id: 2, track: 1, start: 0, duration: 10 }),
  ], 5);
  assert.equal(donas.length, 1);
  assert.equal(donas[0]?.id, 2);
});

test('layer muda não rouba o elemento de quem está tocando', () => {
  const donas = soundOwners([
    audioLayer({ id: 1, start: 0, duration: 10 }),
    audioLayer({ id: 2, start: 0, duration: 10, mute: true }),
  ], 5);
  assert.equal(donas[0]?.id, 1);
});

test('só layers com som entram na conta', () => {
  assert.deepEqual(soundOwners([textLayer(), imageLayer()], 1), []);
});

// --- elemento -----------------------------------------------------------

test('soundElement acha o elemento certo pra cada tipo', () => {
  const a = audioLayer();
  const v = videoLayer();
  assert.equal(soundElement(a), a.audio);
  assert.equal(soundElement(v), v.video, 'a trilha do vídeo sai do próprio <video>');
});
