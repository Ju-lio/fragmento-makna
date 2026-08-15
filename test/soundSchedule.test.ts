/**
 * A política do tocador de som ao vivo.
 *
 * Os testes que importam aqui são os do MODO DE FALHA, e cada um corresponde a
 * um defeito com som próprio: reagendar demais é um clique por quadro,
 * reagendar de menos é a trilha tocando o projeto antigo, e pedir além do fim
 * do buffer derruba a reprodução inteira. Nenhum deles aparece num teste que
 * verifica só que saiu som — ver `verificar conteúdo, não entrega`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  impliedPosition, soundAction, planSignature, projectSignature, scheduleFrom, SALTO,
} from '../src/engine/soundSchedule.ts';
import type { EngineState } from '../src/engine/soundSchedule.ts';
import { mixPlan } from '../src/engine/audioMix.ts';
import { audioLayer, videoLayer } from './fixtures.ts';

const ancora = { t: 1, ctx: 100, geracao: 1 };
const tocandoEm = (over: Partial<EngineState> = {}): EngineState =>
  ({ tocando: true, anchor: ancora, assinatura: 'A', ...over });

// --- o relógio ----------------------------------------------------------

test('a posição é a âncora mais o tanto que o contexto de áudio andou', () => {
  assert.equal(impliedPosition(ancora, 100), 1);
  assert.equal(impliedPosition(ancora, 102.5), 3.5);
});

// --- quando reagendar ---------------------------------------------------

test('o caso normal é SEGUIR: uma agenda no ar toca sozinha', () => {
  const acao = soundAction(tocandoEm(), { t: 1.5, playing: true, ctxNow: 100.5, assinatura: 'A' });
  assert.equal(acao, 'seguir');
});

test('a grade de quadros NÃO reagenda — seria um clique por quadro', () => {
  /**
   * A 30fps o playhead pousa na grade e fica até 33ms atrás da posição real: a
   * sobra vive no acumulador do `player`. Se esse resíduo passasse por salto, a
   * trilha seria recortada dezenas de vezes por segundo. É o defeito que o
   * limiar existe pra impedir, e ele não tem como aparecer olhando a tela.
   */
  for (const atraso of [1 / 30, 1 / 24, 0.05, SALTO - 0.001]) {
    const acao = soundAction(tocandoEm(), {
      t: 1.5 - atraso, playing: true, ctxNow: 100.5, assinatura: 'A',
    });
    assert.equal(acao, 'seguir', `atraso de ${atraso}s não podia reagendar`);
  }
});

test('um seek reagenda', () => {
  const acao = soundAction(tocandoEm(), { t: 3.2, playing: true, ctxNow: 100.5, assinatura: 'A' });
  assert.equal(acao, 'reagendar');
});

test('a volta do laço reagenda — senão a trilha seguiria pro silêncio do fim', () => {
  // A imagem volta pra 0 e o som continuaria lendo adiante: divergência do
  // tamanho do projeto. O mesmo teste do seek cobre este caso.
  const acao = soundAction(
    { tocando: true, anchor: { t: 4.5, ctx: 100, geracao: 1 }, assinatura: 'A' },
    { t: 0.033, playing: true, ctxNow: 100.3, assinatura: 'A' },
  );
  assert.equal(acao, 'reagendar');
});

test('editar durante a reprodução reagenda: a agenda é uma fotografia', () => {
  const acao = soundAction(tocandoEm(), { t: 1.5, playing: true, ctxNow: 100.5, assinatura: 'B' });
  assert.equal(acao, 'reagendar');
});

test('parado, para; e parado duas vezes não faz nada', () => {
  assert.equal(soundAction(tocandoEm(), { t: 1, playing: false, ctxNow: 100, assinatura: 'A' }), 'parar');
  assert.equal(
    soundAction({ tocando: false, anchor: null, assinatura: '' }, { t: 1, playing: false, ctxNow: 100, assinatura: 'A' }),
    'seguir',
  );
});

test('tocando sem agenda no ar, agenda', () => {
  const acao = soundAction(
    { tocando: false, anchor: null, assinatura: '' },
    { t: 0, playing: true, ctxNow: 100, assinatura: 'A' },
  );
  assert.equal(acao, 'reagendar');
});

// --- a assinatura -------------------------------------------------------

test('mexer no que se VÊ não reagenda o que se OUVE', () => {
  // Arrastar um clipe de faixa, movê-lo na tela ou mudar um efeito visual não
  // muda uma nota. Reagendar por isso seria um corte no som a cada tecla.
  const antes = [videoLayer({ id: 1, start: 0, duration: 2 })];
  const depois = [videoLayer({ id: 1, start: 0, duration: 2, track: 3, x: 120, rotate: 15 })];
  const faixa = { from: 0, to: 4 };

  assert.equal(
    planSignature(mixPlan(antes, faixa)),
    planSignature(mixPlan(depois, faixa)),
  );
});

test('a assinatura NÃO muda enquanto o playhead anda', () => {
  /**
   * O defeito que este teste existe pra impedir, e que a primeira versão tinha:
   * assinar `mixPlan(layers, { from: t })` faz `at`, `offset` e `duration`
   * mudarem a cada quadro, então a assinatura nunca se repete e a agenda é
   * refeita 60 vezes por segundo — um corte no som por quadro. Medido na
   * bancada antes da correção: 171 reagendamentos em 6 segundos, e nenhum
   * teste acusando, porque todos comparavam duas assinaturas no MESMO `t`.
   */
  const layers = [
    videoLayer({ id: 1, start: 0, duration: 2 }),
    audioLayer({ id: 2, start: 1, duration: 3, mediaId: 'trilha' }),
  ];
  const andando = [0, 0.033, 0.5, 1.2, 2.7, 3.9];

  // A armadilha, explicitada: o plano a partir do playhead muda a cada quadro.
  const doPlayhead = new Set(andando.map(t => planSignature(mixPlan(layers, { from: t, to: 4 }))));
  assert.ok(doPlayhead.size > 1, 'o plano a partir de t muda com t — é por isso que ele não serve de assinatura');

  // A assinatura certa é uma só, do começo ao fim da reprodução.
  const doProjeto = new Set(andando.map(() => projectSignature(layers, 4)));
  assert.equal(doProjeto.size, 1);
});

test('mexer no volume, no trim ou no corte reagenda', () => {
  const base = [videoLayer({ id: 1, start: 0, duration: 2 })];
  const faixa = { from: 0, to: 4 };
  const assinatura = planSignature(mixPlan(base, faixa));

  for (const mudanca of [
    { volume: 0.5 },
    { trimStart: 1 },
    { duration: 1.5 },
    { start: 0.5 },
  ]) {
    const outro = [videoLayer({ id: 1, start: 0, duration: 2, ...mudanca })];
    assert.notEqual(
      planSignature(mixPlan(outro, faixa)), assinatura,
      `mudar ${JSON.stringify(mudanca)} tinha que reagendar`,
    );
  }
});

test('emudecer reagenda, e a agenda fica vazia', () => {
  const faixa = { from: 0, to: 4 };
  const mudo = mixPlan([videoLayer({ id: 1, mute: true })], faixa);
  assert.equal(mudo.length, 0);
  assert.notEqual(planSignature(mudo), planSignature(mixPlan([videoLayer({ id: 1 })], faixa)));
});

// --- a agenda concreta --------------------------------------------------

const buffers = (dur: Record<string, number>) => (id: string) => dur[id] ?? null;

/** A única fonte agendada. Falha alto se a agenda não tiver exatamente uma. */
function unica<T>(agenda: readonly T[]): T {
  assert.equal(agenda.length, 1, 'esperava exatamente uma fonte agendada');
  return agenda[0] as T;
}

test('cada clipe vira um start(quando, offset, duração)', () => {
  const clips = mixPlan(
    [audioLayer({ id: 7, start: 1, duration: 2, trimStart: 5, mediaId: 'm' })],
    { from: 0, to: 4 },
  );
  const s = unica(scheduleFrom(clips, { ctxNow: 50, bufferDurationOf: buffers({ m: 30 }) }));

  assert.equal(s.when, 51, 'entra 1s depois de agora');
  assert.equal(s.offset, 5, 'lê o arquivo a partir do trim');
  assert.equal(s.duration, 2);
  assert.equal(s.gain, 1);
});

test('nunca pede além do fim do buffer — pedir derruba a reprodução inteira', () => {
  /**
   * O buffer decodificado pode ser mais curto que o `sourceDuration` que a
   * layer anunciou. Num `AudioBufferSourceNode`, pedir além do fim LANÇA — e
   * aqui isso não perderia uma faixa, perderia o som todo e o relógio junto.
   */
  const clips = mixPlan(
    [audioLayer({ id: 7, start: 0, duration: 5, trimStart: 8, sourceDuration: 30, mediaId: 'm' })],
    { from: 0, to: 5 },
  );
  const s = unica(scheduleFrom(clips, { ctxNow: 0, bufferDurationOf: buffers({ m: 9.5 }) }));

  assert.equal(s.duration, 1.5, 'só o que o buffer realmente tem depois do offset');
});

test('buffer que acaba antes do offset é descartado, não agendado com duração ≤ 0', () => {
  const clips = mixPlan(
    [audioLayer({ id: 7, start: 0, duration: 2, trimStart: 8, sourceDuration: 30, mediaId: 'm' })],
    { from: 0, to: 2 },
  );
  assert.equal(scheduleFrom(clips, { ctxNow: 0, bufferDurationOf: buffers({ m: 6 }) }).length, 0);
});

test('trilha ainda não decodificada some da agenda, sem derrubar as outras', () => {
  const clips = mixPlan([
    audioLayer({ id: 7, mediaId: 'pronto', start: 0, duration: 2 }),
    audioLayer({ id: 8, mediaId: 'vindo', start: 0, duration: 2 }),
  ], { from: 0, to: 2 });

  const agenda = scheduleFrom(clips, { ctxNow: 0, bufferDurationOf: buffers({ pronto: 30 }) });
  assert.deepEqual(agenda.map(s => s.layerId), [7]);
});

test('clipe que já devia ter entrado entra AGORA, não de uma vez', () => {
  // `start()` com tempo no passado toca o buffer inteiro imediatamente. Um
  // reagendamento no meio de um clipe cai exatamente nesse caso.
  const clips = mixPlan(
    [audioLayer({ id: 7, start: 0, duration: 4, mediaId: 'm' })],
    { from: 2, to: 4 },
  );
  const s = unica(scheduleFrom(clips, { ctxNow: 50, bufferDurationOf: buffers({ m: 30 }) }));
  assert.ok(s.when >= 50, `when=${s.when} não pode estar no passado`);
});

test('reagendar no meio lê o arquivo do meio, não do começo do clipe', () => {
  // O defeito que `mixPlan` já protegia pro export, e que agora vale pro
  // preview: retomar em 2s tem que continuar de onde estava.
  const clips = mixPlan(
    [audioLayer({ id: 7, start: 0, duration: 4, trimStart: 10, mediaId: 'm' })],
    { from: 2, to: 4 },
  );
  const s = unica(scheduleFrom(clips, { ctxNow: 0, bufferDurationOf: buffers({ m: 30 }) }));
  assert.equal(s.offset, 12);
  assert.equal(s.when, 0, 'entra imediatamente, porque já estava tocando');
});
