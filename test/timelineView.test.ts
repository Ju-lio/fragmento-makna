import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fitPxPerSecond, clampPxPerSecond, zoomAnchor, clampScroll, tickStep, followPlayhead,
} from '../src/engine/timelineView.ts';

// --- o piso do zoom -----------------------------------------------------

test('o fit faz o projeto inteiro caber na janela', () => {
  assert.equal(fitPxPerSecond(600, 60), 10, '60s em 600px = 10 px/s');
  assert.equal(fitPxPerSecond(600, 8), 75);
});

test('sem janela medida ainda devolve um número usável', () => {
  // O primeiro render acontece antes do ResizeObserver: um zero aqui viraria
  // divisão por zero na conversão de coordenadas.
  assert.ok(fitPxPerSecond(0, 60) > 0);
  assert.ok(fitPxPerSecond(600, 0) > 0);
});

test('o zoom nunca desce abaixo de "cabe tudo"', () => {
  // Abaixo do fit sobraria faixa vazia à direita e a rolagem não teria pra onde
  // ir — o projeto encolhido no canto de uma janela larga.
  assert.equal(clampPxPerSecond(1, 600, 60), 10);
});

test('o zoom tem teto', () => {
  assert.ok(clampPxPerSecond(99_999, 600, 60) < 99_999);
});

test('num projeto curto, "cabe tudo" vence o teto', () => {
  // 1s numa janela de 3000px pede 3000 px/s. Mostrar o projeto inteiro importa
  // mais que respeitar um teto pensado pra projeto longo.
  assert.equal(clampPxPerSecond(10, 3000, 1), 3000);
});

// --- zoom ancorado ------------------------------------------------------

test('o instante sob o cursor não sai do lugar ao ampliar', () => {
  // É o que separa "ampliar pra examinar um corte" de "ampliar e procurar o
  // corte de novo".
  const scroll = 100;
  const anchorX = 250;
  const antes = 10;
  const depois = 40;

  const t = (scroll + anchorX) / antes;
  const novo = zoomAnchor(scroll, anchorX, antes, depois);

  assert.equal((novo + anchorX) / depois, t, 'o mesmo instante segue sob o cursor');
});

test('ancorar nunca devolve rolagem negativa', () => {
  // Ampliar com o cursor perto do começo pediria scroll negativo, que o
  // navegador silenciosamente vira 0 — melhor a conta já sair certa.
  assert.equal(zoomAnchor(0, 10, 40, 10), 0);
});

test('zoom de partida inválido não explode a conta', () => {
  assert.equal(zoomAnchor(100, 50, 0, 40), 100);
});

// --- limites da rolagem -------------------------------------------------

test('a rolagem para nas duas pontas', () => {
  assert.equal(clampScroll(-50, 2000, 600), 0);
  assert.equal(clampScroll(9999, 2000, 600), 1400, 'o fim do conteúdo encosta na borda');
});

test('conteúdo menor que a janela não rola', () => {
  assert.equal(clampScroll(300, 400, 600), 0);
});

// --- marcas da régua ----------------------------------------------------

test('o passo das marcas acompanha o zoom, não a duração', () => {
  // Bem ampliado cabem marcas finas; espremido, só as grossas.
  assert.ok(tickStep(600) < tickStep(10));
});

test('as marcas caem sempre em números redondos', () => {
  // Passos de 0,3s ou 7s são tão legíveis quanto um relógio quebrado.
  const redondos = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const pps of [2, 5, 10, 30, 60, 120, 300, 600]) {
    assert.ok(redondos.includes(tickStep(pps)), `${pps} px/s deu ${tickStep(pps)}`);
  }
});

test('marca nenhuma fica colada na vizinha', () => {
  for (const pps of [2, 5, 10, 30, 60, 120, 300, 600]) {
    assert.ok(tickStep(pps) * pps >= 52, `${pps} px/s espremeu os rótulos`);
  }
});

test('espremido ao extremo, ainda sobra o passo mais grosso', () => {
  assert.equal(tickStep(0.01), 300);
});

// --- seguir o cursor ----------------------------------------------------

test('cursor à vista não mexe na rolagem', () => {
  // Seguir pixel a pixel deixaria a timeline deslizando o tempo todo debaixo
  // do olho, e aí não dá pra ler nem mirar nada enquanto toca.
  assert.equal(followPlayhead(300, 0, 600), null);
});

test('saindo pela direita, o cursor reaparece perto da borda esquerda', () => {
  // Com uma página inteira de projeto pela frente, que é o que interessa ver.
  const scroll = followPlayhead(600, 0, 600);
  assert.notEqual(scroll, null);
  assert.ok(scroll! > 0);
  assert.ok(600 - scroll! <= 600 * 0.2, 'perto da esquerda, não no meio');
});

test('voltando pra trás, o espelho disso', () => {
  const scroll = followPlayhead(100, 1000, 600);
  assert.notEqual(scroll, null);
  assert.ok(scroll! < 1000, 'rolou pra trás');
  assert.ok(100 - scroll! >= 600 * 0.7, 'o cursor reaparece perto da direita');
});

test('sem janela medida, não tenta seguir nada', () => {
  assert.equal(followPlayhead(300, 0, 0), null);
});
