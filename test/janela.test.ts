import test from 'node:test';
import assert from 'node:assert/strict';
import { ESQUEMA_JANELA, janelaDeEfeito, comJanela } from '../src/criar/janela.ts';
import { effectProgress } from '../src/engine/effects.ts';
import { validarEsquema } from '../src/criar/api.ts';
import { PRESETS } from '../src/engine/presets.ts';
import type { Effect } from '../src/engine/types.ts';

const base = (): Effect => ({ name: 'teste', duration: 1, tracks: [{ prop: 'x', keys: [[0, 0], [1, 10]] }] });

test('o esquema da janela é válido pelas regras do api', () => {
  assert.equal(validarEsquema(ESQUEMA_JANELA), null);
});

// --- leitura ------------------------------------------------------------

test('efeito sem campos opcionais cai nos padrões', () => {
  assert.deepEqual(janelaDeEfeito({ duration: 2 }), {
    duration: 2, delay: 0, anchor: 'start', loop: false,
  });
});

test('duração ausente vira 1 — o mesmo padrão que effectProgress usa', () => {
  // Se os dois divergirem, o slider mostra um número e o desenho usa outro.
  const janela = janelaDeEfeito({});
  const layer = { start: 0, duration: 10 };
  // no meio de uma janela de 1s a partir do início, o progresso é 0.5
  assert.equal(effectProgress({ duration: janela.duration }, layer, 0.5), 0.5);
  assert.equal(effectProgress({}, layer, 0.5), 0.5, 'e sem duration dá o mesmo');
});

test('todos os presets são lidos sem perder informação', () => {
  for (const [nome, preset] of Object.entries(PRESETS)) {
    const janela = janelaDeEfeito(preset);
    assert.equal(janela.duration, preset.duration, nome);
    assert.equal(janela.loop, Boolean((preset as Effect).loop), nome);
    assert.equal(janela.anchor, (preset as Effect).anchor ?? 'start', nome);
  }
});

// --- escrita ------------------------------------------------------------

test('ida e volta preserva a janela', () => {
  const eff: Effect = { ...base(), duration: 0.6, delay: 0.2, anchor: 'end', loop: true };
  assert.deepEqual(janelaDeEfeito(comJanela(eff, janelaDeEfeito(eff))), janelaDeEfeito(eff));
});

test('valores no padrão são OMITIDOS, não escritos', () => {
  // `delay: 0` e `anchor: 'start'` são exatamente o que a ausência significa.
  // Escrevê-los incharia todo efeito colado, e o .frag carregaria isso.
  const saida = comJanela(base(), { duration: 1, delay: 0, anchor: 'start', loop: false });
  assert.equal('delay' in saida, false);
  assert.equal('anchor' in saida, false);
  assert.equal('loop' in saida, false);
});

test('desligar loop e âncora REMOVE os campos de um efeito que os tinha', () => {
  // O caso que um `{...eff, ...patch}` ingênuo erraria: sobrescrever com
  // `false`/`'start'` deixaria lixo, e `loop: false` não é o mesmo que ausente
  // pro leitor humano do .frag.
  const eff: Effect = { ...base(), anchor: 'end', loop: true, delay: 3 };
  const saida = comJanela(eff, { duration: 1, delay: 0, anchor: 'start', loop: false });
  assert.equal('anchor' in saida, false);
  assert.equal('loop' in saida, false);
  assert.equal('delay' in saida, false);
});

test('as tracks e o nome atravessam intactos', () => {
  const eff = base();
  const saida = comJanela(eff, { duration: 3, delay: 0, anchor: 'start', loop: false });
  assert.deepEqual(saida.tracks, eff.tracks);
  assert.equal(saida.name, 'teste');
});

test('comJanela devolve cópia — o histórico guarda referências', () => {
  const eff = base();
  const saida = comJanela(eff, { duration: 9, delay: 0, anchor: 'start', loop: false });
  assert.notEqual(saida, eff);
  assert.equal(eff.duration, 1, 'o original não foi tocado');
});

test('valor absurdo é limitado, não aceito', () => {
  const saida = comJanela(base(), { duration: 9999, delay: -5, anchor: 'start', loop: false });
  assert.equal(saida.duration, 30, 'teto do esquema');
  assert.equal('delay' in saida, false, 'negativo virou 0, logo some');
});

test('o efeito editado continua sendo um TimeWindow que effectProgress entende', () => {
  const layer = { start: 2, duration: 10 };
  const saida = comJanela(base(), { duration: 2, delay: 0, anchor: 'end', loop: false });
  // ancorado no fim: a janela de 2s termina em t=12, então começa em t=10
  assert.equal(effectProgress(saida, layer, 10), 0);
  assert.equal(effectProgress(saida, layer, 11), 0.5);
  assert.equal(effectProgress(saida, layer, 12), 1);
});
