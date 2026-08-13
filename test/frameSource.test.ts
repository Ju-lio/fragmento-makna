import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFrameSource } from '../src/engine/frameSource.ts';

const FPS = 30;

/** Sequência de instantes como o rAF entrega: ~60 por segundo, tempo real. */
function rafTimes(seconds: number, hz = 60): number[] {
  const out: number[] = [];
  for (let i = 0; i <= seconds * hz; i++) out.push(i / hz);
  return out;
}

test('o instante mostrado nunca anda pra trás durante a reprodução', () => {
  // O sintoma que estamos caçando é a imagem "indo e voltando". Se a decisão
  // alguma vez devolver um t menor que o anterior, é aqui que aparece.
  let prev = -Infinity;
  for (const rawT of rafTimes(3)) {
    const { t } = pickFrameSource({
      rawT, fps: FPS, playing: true, fromCache: true, hasCached: () => true,
    });
    assert.ok(t >= prev, `t andou pra trás: ${prev} -> ${t} (rawT=${rawT})`);
    prev = t;
  }
});

test('a 60Hz de relógio e 30fps de grade, cada quadro aparece duas vezes seguidas', () => {
  const seen = rafTimes(0.5).map(rawT =>
    pickFrameSource({ rawT, fps: FPS, playing: true, fromCache: true, hasCached: () => true }).index);

  // Nunca deve haver um índice repetido DEPOIS de já ter avançado.
  const firstSeen = new Map();
  seen.forEach((idx, pos) => { if (!firstSeen.has(idx)) firstSeen.set(idx, pos); });
  seen.forEach((idx, pos) => {
    const contiguous = pos - firstSeen.get(idx) <= 1;
    assert.ok(contiguous, `índice ${idx} reapareceu fora de sequência na posição ${pos}`);
  });
});

test('reproduzindo do cache, nunca cai no caminho ao vivo se o quadro existe', () => {
  const { useCache } = pickFrameSource({
    rawT: 1, fps: FPS, playing: true, fromCache: true, hasCached: () => true,
  });
  assert.equal(useCache, true);
});

test('reproduzindo AO VIVO, o cache é ignorado mesmo tendo o quadro', () => {
  // Esta é a regra anti-mistura: durante uma reprodução ao vivo, ler um quadro
  // do cache no meio mostraria o vídeo num instante diferente do que o
  // elemento <video> está exibindo, e a imagem pularia.
  const { useCache } = pickFrameSource({
    rawT: 1, fps: FPS, playing: true, fromCache: false, hasCached: () => true,
  });
  assert.equal(useCache, false, 'não pode misturar origens durante a reprodução');
});

test('parado, o cache é usado normalmente', () => {
  const { useCache } = pickFrameSource({
    rawT: 1, fps: FPS, playing: false, fromCache: false, hasCached: () => true,
  });
  assert.equal(useCache, true, 'cada posição é independente quando não está reproduzindo');
});

test('um buraco no cache durante reprodução do cache cai pro caminho ao vivo', () => {
  const buraco = 45;
  const { useCache } = pickFrameSource({
    rawT: buraco / FPS, fps: FPS, playing: true, fromCache: true,
    hasCached: i => i !== buraco,
  });
  assert.equal(useCache, false, 'sem o quadro, só resta renderizar');
});

test('buracos esparsos fazem a origem alternar — a causa do tremor', () => {
  // Documenta o risco: se o cache tiver furos durante uma reprodução "do
  // cache", a origem alterna entre quadros e é exatamente aí que a imagem
  // treme. A garantia tem que vir de o trecho estar íntegro ANTES do play.
  const origens = rafTimes(1).map(rawT =>
    pickFrameSource({
      rawT, fps: FPS, playing: true, fromCache: true,
      hasCached: i => i % 3 !== 0,     // um furo a cada 3 quadros
    }).useCache);

  const alternancias = origens.filter((v, i) => i > 0 && v !== origens[i - 1]).length;
  assert.ok(alternancias > 5, `esperava alternância frequente, houve ${alternancias}`);
});
