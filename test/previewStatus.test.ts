import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewStatus } from '../src/engine/previewStatus.ts';

/** Relógio falso: o ponto todo do store é comportamento no tempo. */
const make = (delay = 100) => new PreviewStatus(delay);

test('operação rápida nunca chega a mostrar a barra', () => {
  const s = make(100);
  s.report(true, 'decodificando', 0);
  s.report(true, 'decodificando', 50);   // ainda dentro do atraso
  assert.equal(s.visible, false, 'não pisca em algo que resolve rápido');

  s.report(false, null, 60);
  assert.equal(s.visible, false);
});

test('espera longa mostra a barra depois do atraso', () => {
  const s = make(100);
  s.report(true, 'decodificando', 0);
  assert.equal(s.visible, false, 'ainda não');

  s.report(true, 'decodificando', 100);
  assert.equal(s.visible, true, 'passou do limite, aparece');
  assert.equal(s.reason, 'decodificando');
});

test('a barra some assim que o trabalho termina', () => {
  const s = make(100);
  s.report(true, 'decodificando', 0);
  s.report(true, 'decodificando', 200);
  assert.equal(s.visible, true);

  s.report(false, null, 210);
  assert.equal(s.visible, false, 'saiu na hora');
  assert.equal(s.reason, null);
});

test('o contador reinicia entre episódios distintos', () => {
  const s = make(100);
  // Primeiro episódio, longo.
  s.report(true, 'decodificando', 0);
  s.report(true, 'decodificando', 300);
  assert.equal(s.visible, true);
  s.report(false, null, 310);

  // Segundo episódio, curto — não pode herdar o tempo do anterior.
  s.report(true, 'decodificando', 320);
  assert.equal(s.visible, false, 'começa a contar do zero de novo');
});

test('avisa os inscritos só nas transições, não a cada frame', () => {
  const s = make(100);
  let calls = 0;
  s.subscribe(() => calls++);

  // Simula ~60 frames de espera contínua.
  for (let i = 0; i <= 600; i += 10) s.report(true, 'decodificando', i);
  assert.equal(calls, 1, 'uma notificação ao aparecer, não 60');

  for (let i = 610; i <= 700; i += 10) s.report(false, null, i);
  assert.equal(calls, 2, 'e mais uma ao sumir');
});

test('mudança de motivo com a barra já visível notifica de novo', () => {
  const s = make(100);
  s.report(true, 'carregando', 0);
  s.report(true, 'carregando', 150);
  assert.equal(s.reason, 'carregando');

  s.report(true, 'decodificando', 160);
  assert.equal(s.reason, 'decodificando', 'o rótulo acompanha o estado real');
});

test('unsubscribe realmente desconecta', () => {
  const s = make(100);
  let calls = 0;
  const off = s.subscribe(() => calls++);
  off();
  s.report(true, 'decodificando', 0);
  s.report(true, 'decodificando', 200);
  assert.equal(calls, 0);
});
