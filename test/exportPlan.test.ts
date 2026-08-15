import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evenDimensions, frameTimestamp, keyFrameInterval, chooseBitrate,
  frameCount, exportFileName, CODEC_CANDIDATES, AUDIO_CODEC_CANDIDATES,
} from '../src/engine/exportPlan.ts';

// --- dimensões ----------------------------------------------------------

test('dimensão ímpar sobe pro par seguinte', () => {
  // H.264 guarda croma em metade da resolução: dimensão ímpar não existe pro
  // formato, e o encoder recusa a configuração sem dizer por quê.
  assert.deepEqual(evenDimensions({ width: 1081, height: 607 }), { width: 1082, height: 608 });
});

test('dimensão já par não é mexida', () => {
  assert.deepEqual(evenDimensions({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
});

test('a escala é aplicada antes do arredondamento', () => {
  assert.deepEqual(evenDimensions({ width: 1920, height: 1080 }, 0.5), { width: 960, height: 540 });
});

test('escala minúscula não produz dimensão zero', () => {
  // Um canvas 0×0 faria o encoder falhar bem longe daqui, com outra mensagem.
  const d = evenDimensions({ width: 100, height: 100 }, 0.001);
  assert.deepEqual(d, { width: 2, height: 2 });
});

test('a escala pode produzir ímpar, e ele também é corrigido', () => {
  // 1080 * 0.3 = 324 (par), mas 1085 * 0.3 = 325.5 -> 326.
  assert.equal(evenDimensions({ width: 1085, height: 100 }, 0.3).width % 2, 0);
});

// --- timestamps ---------------------------------------------------------

test('o primeiro quadro exportado começa em zero', () => {
  // Exportar de 8s a 12s tem que dar um arquivo de 4s, não 4s de nada na frente.
  assert.equal(frameTimestamp(240, 240, 30), 0);
});

test('os quadros seguintes avançam em microssegundos', () => {
  assert.equal(frameTimestamp(241, 240, 30), 33_333, 'um quadro a 30fps');
  assert.equal(frameTimestamp(270, 240, 30), 1_000_000, 'um segundo depois');
});

test('o timestamp acompanha o fps do projeto', () => {
  assert.equal(frameTimestamp(1, 0, 60), 16_667);
  assert.equal(frameTimestamp(60, 0, 60), 1_000_000, 'um segundo a 60fps');
});

test('os timestamps crescem sem repetir', () => {
  // Timestamp repetido faz o player tratar dois quadros como o mesmo instante.
  const ts = Array.from({ length: 120 }, (_, i) => frameTimestamp(i, 0, 30));
  for (let i = 1; i < ts.length; i++) {
    assert.ok(ts[i]! > ts[i - 1]!, `quadro ${i} não avançou`);
  }
});

// --- keyframes ----------------------------------------------------------

test('keyframe a cada dois segundos', () => {
  assert.equal(keyFrameInterval(30), 60);
  assert.equal(keyFrameInterval(24), 48);
});

test('o intervalo nunca é zero', () => {
  // Zero viraria divisão por zero ou keyframe em quadro nenhum.
  assert.ok(keyFrameInterval(0.1) >= 1);
});

// --- bitrate ------------------------------------------------------------

test('bitrate escala com resolução e fps', () => {
  const hd = chooseBitrate({ width: 1920, height: 1080 }, 30);
  const sd = chooseBitrate({ width: 960, height: 540 }, 30);
  assert.ok(hd > sd * 3, 'quatro vezes os pixels pede muito mais bitrate');

  const alto = chooseBitrate({ width: 1920, height: 1080 }, 60);
  assert.ok(alto > hd, 'o dobro de quadros pede mais bitrate');
});

test('1080p30 fica na ordem de grandeza recomendada pra upload', () => {
  const b = chooseBitrate({ width: 1920, height: 1080 }, 30);
  assert.ok(b > 4_000_000 && b < 9_000_000, `esperava ~6 Mbps, veio ${b}`);
});

test('projeto minúsculo ainda recebe bitrate utilizável', () => {
  // Sem o piso, um preview 64×64 sairia num bitrate que borra tudo.
  assert.equal(chooseBitrate({ width: 64, height: 64 }, 30), 500_000);
});

test('projeto gigante é limitado no teto', () => {
  assert.equal(chooseBitrate({ width: 7680, height: 4320 }, 60), 40_000_000);
});

// --- contagem e nome ----------------------------------------------------

test('a contagem inclui as duas pontas', () => {
  assert.equal(frameCount(0, 29), 30);
  assert.equal(frameCount(240, 240), 1, 'um quadro só');
});

test('trecho invertido não devolve contagem negativa', () => {
  assert.equal(frameCount(100, 50), 0);
});

test('o nome do arquivo carrega o trecho exportado', () => {
  // Exportar pedaços diferentes do mesmo projeto é o caso comum, e
  // "video (1).mp4" não diz qual é qual.
  assert.equal(exportFileName(0, 8), 'fragmento_0_0s-8_0s.mp4');
  // Uma casa decimal: o nome é pra você reconhecer o arquivo, não pra ser
  // exato ao milissegundo (2.25 arredonda pra 2.3).
  assert.equal(exportFileName(2.25, 10.5), 'fragmento_2_3s-10_5s.mp4');
});

test('o nome acompanha a extensão do formato que saiu', () => {
  assert.match(exportFileName(0, 1, 'webm'), /\.webm$/);
});

test('o nome não tem ponto além do da extensão', () => {
  // Ponto no meio faz alguns sistemas tratarem o resto como extensão.
  const nome = exportFileName(1.5, 2.5);
  assert.equal(nome.split('.').length, 2, nome);
});

// --- codecs -------------------------------------------------------------

test('H.264 é tentado antes de VP9', () => {
  // A pessoa exporta pra mandar pra alguém; H.264 abre em qualquer lugar.
  const primeiro = CODEC_CANDIDATES[0];
  assert.equal(primeiro?.muxer, 'avc');
  assert.equal(CODEC_CANDIDATES.at(-1)?.muxer, 'vp9', 'VP9 é a reserva');
});

test('todo candidato traz o nome que o muxer entende', () => {
  // Os dois vocabulários não coincidem, e trocar um pelo outro gera um
  // arquivo que não abre.
  for (const c of CODEC_CANDIDATES) {
    assert.ok(c.codec.length > 0, 'string do WebCodecs');
    assert.ok(['avc', 'vp9'].includes(c.muxer), `muxer inválido: ${c.muxer}`);
    assert.ok(c.label.length > 0, 'rótulo pra mostrar na interface');
  }
});

// --- codecs de áudio ----------------------------------------------------

test('o áudio também tem reserva, e o AAC vem primeiro', () => {
  // AAC é o que o MP4 leva por padrão, mas é proprietário: o ENCODER não vem em
  // toda build de Chromium. Sem reserva, exportar num Linux dava
  // "the encoder must be configured first" depois da mixagem inteira.
  assert.equal(AUDIO_CODEC_CANDIDATES[0]?.muxer, 'aac');
  assert.equal(AUDIO_CODEC_CANDIDATES.at(-1)?.muxer, 'opus', 'Opus é livre e está em todo lugar');
});

test('todo candidato de áudio traz o nome que o muxer entende', () => {
  // O vocabulário do WebCodecs ("mp4a.40.2") e o do muxer ("aac") não
  // coincidem, e trocar um pelo outro gera arquivo que não abre.
  for (const c of AUDIO_CODEC_CANDIDATES) {
    assert.ok(['aac', 'opus'].includes(c.muxer), `${c.codec} -> ${c.muxer}`);
    assert.ok(c.codec.length > 0);
    assert.ok(c.label.length > 0, 'o rótulo aparece na interface');
  }
});
