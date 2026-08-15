/**
 * O arquivo `.frag` e o histórico de versões.
 *
 * Os dois existem pra quando algo já deu errado, então o que se testa aqui é
 * sobretudo o comportamento sob defeito: arquivo cortado, arquivo de outro
 * programa, projeto de uma versão futura, e o histórico apagando o que não
 * devia.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { toFrag, fromFrag, fragFileName, FragFileError } from '../src/engine/fragFile.ts';
import { deserializeProject, serializeProject, PROJECT_FORMAT } from '../src/engine/serialize.ts';
import { snapshotPlan, snapshotLabel, DEFAULT_POLICY } from '../src/engine/snapshots.ts';
import { project, textLayer } from './fixtures.ts';

const exemplo = () => project([
  textLayer({ id: 1, name: 'Título', start: 0, duration: 2 }),
  textLayer({ id: 2, name: 'Selo', start: 2, duration: 1.5, track: 1 }),
]);

// --- ida e volta ---------------------------------------------------------

test('o projeto sobrevive à ida e volta pelo arquivo', () => {
  const antes = exemplo();
  const depois = deserializeProject(fromFrag(toFrag(antes)), () => null).project;

  assert.deepEqual(
    serializeProject(depois),
    serializeProject(antes),
    'exportar e importar não pode mudar nada',
  );
});

test('o cabeçalho diz quem gerou, o formato e quando', () => {
  const texto = toFrag(exemplo(), new Date('2026-08-15T14:30:00Z'));
  const obj = JSON.parse(texto);

  assert.equal(obj.app, 'fragmento');
  assert.equal(obj.appFormat, PROJECT_FORMAT);
  assert.equal(obj.savedAt, '2026-08-15T14:30:00.000Z');
  // O projeto fica no MESMO nível, não aninhado: um `.frag` é o objeto que vai
  // pro IndexedDB com um cabeçalho a mais, e não um segundo formato.
  assert.equal(obj.format, PROJECT_FORMAT);
  assert.ok(Array.isArray(obj.layers));
});

test('é texto legível: indentado e terminando em quebra de linha', () => {
  // As três propriedades que o formato existe pra ter — ler, colar num chat,
  // versionar em git — dependem disto e de mais nada.
  const texto = toFrag(exemplo());
  assert.ok(texto.includes('\n  "format"'), 'devia estar indentado');
  assert.ok(texto.endsWith('\n'), 'arquivo de texto termina em nova linha');
});

test('o mesmo projeto gera BYTE A BYTE o mesmo arquivo', () => {
  // É o que faz `git diff` entre dois `.frag` significar "o que mudou na
  // edição". Se a ordem das chaves variasse, todo salvamento pareceria uma
  // mudança inteira.
  const p = exemplo();
  const at = new Date('2026-08-15T14:30:00Z');
  assert.equal(toFrag(p, at), toFrag(p, at));
});

test('o nome sugerido não tem caractere proibido em sistema de arquivos', () => {
  const nome = fragFileName(new Date('2026-08-15T14:30:00'));
  assert.match(nome, /^fragmento_[\d-]+_\d{4}\.frag$/);
  assert.ok(!/[:/\\]/.test(nome), nome);
});

// --- o que chega quebrado ------------------------------------------------

test('arquivo cortado no meio diz que foi cortado', () => {
  assert.throws(() => fromFrag('{ "format": 6, "lay'), (e: Error) => {
    assert.ok(e instanceof FragFileError);
    assert.match(e.message, /JSON válido|cortado/);
    return true;
  });
});

test('JSON válido que não é projeto é recusado por FALTAR `format`', () => {
  assert.throws(() => fromFrag('{"foo":1}'), FragFileError);
  assert.throws(() => fromFrag('[1,2,3]'), FragFileError);
  assert.throws(() => fromFrag('"texto"'), FragFileError);
});

test('arquivo de outro programa é recusado dizendo QUAL', () => {
  assert.throws(
    () => fromFrag('{"app":"outro-editor","format":6}'),
    (e: Error) => {
      assert.match(e.message, /outro-editor/);
      return true;
    },
  );
});

test('projeto SEM cabeçalho é aceito — é o objeto do autosave', () => {
  /**
   * Deliberado: quem estiver recuperando o próprio trabalho copiando o objeto
   * do IndexedDB tem um projeto válido em mãos. Recusá-lo por falta de um campo
   * decorativo seria pedantismo em cima de alguém em apuros.
   */
  const cru = JSON.stringify(serializeProject(exemplo()));
  const p = deserializeProject(fromFrag(cru), () => null).project;
  assert.equal(p.layers.length, 2);
});

test('projeto de uma versão FUTURA é recusado, não adivinhado', () => {
  // A recusa mora no `deserializeProject` e vale igual pro arquivo e pro autosave —
  // dois caminhos com regras diferentes seria como o formato começa a divergir.
  const futuro = JSON.stringify({ app: 'fragmento', format: PROJECT_FORMAT + 1, layers: [] });
  assert.throws(() => deserializeProject(fromFrag(futuro), () => null), /mais nova/);
});

// --- histórico de versões ------------------------------------------------

const emMinutos = (...mins: number[]) => mins.map(m => ({ at: m * 60_000 }));

test('a primeira versão sempre é guardada', () => {
  assert.deepEqual(snapshotPlan([], 0), { write: true, drop: [] });
});

test('cedo demais desde a última: não guarda E NÃO APAGA', () => {
  /**
   * O modo de falha que este teste existe pra impedir: apagar sem guardar faria
   * o histórico encolher de segundo em segundo, com o autosave disparando a
   * cada 600ms, até não sobrar nada — sem nunca ganhar versão nova.
   */
  const cheio = emMinutos(...Array.from({ length: 20 }, (_, i) => i * 2));
  const plano = snapshotPlan(cheio, 38 * 60_000 + 1000);
  assert.deepEqual(plano, { write: false, drop: [] });
});

test('passado o intervalo, guarda', () => {
  const plano = snapshotPlan(emMinutos(0), DEFAULT_POLICY.everyMs);
  assert.equal(plano.write, true);
});

test('o teto conta a versão que está ENTRANDO', () => {
  // Sem isso o histórico passa do limite por um até a gravação seguinte.
  const cheio = emMinutos(...Array.from({ length: 20 }, (_, i) => i * 2));
  const plano = snapshotPlan(cheio, 40 * 60_000);
  assert.equal(plano.write, true);
  assert.deepEqual(plano.drop, [0], 'sai exatamente a mais antiga');
});

test('o que sai é sempre a ponta VELHA', () => {
  const bagunçado = [{ at: 300 }, { at: 100 }, { at: 200 }];
  const plano = snapshotPlan(bagunçado, 10_000, { everyMs: 1000, max: 2 });
  assert.equal(plano.write, true);
  assert.deepEqual(plano.drop, [100, 200], 'as duas mais antigas, em ordem');
});

test('teto de 1 mantém só a que está entrando', () => {
  const plano = snapshotPlan(emMinutos(0, 2), 10 * 60_000, { everyMs: 1000, max: 1 });
  assert.deepEqual(plano.drop, [0, 2 * 60_000]);
});

test('rótulos dizem o que a pessoa precisa pra escolher', () => {
  const agora = new Date('2026-08-15T14:30:00').getTime();
  assert.equal(snapshotLabel(agora - 10_000, agora), 'agora mesmo');
  assert.equal(snapshotLabel(agora - 5 * 60_000, agora), 'há 5 min');
  assert.match(snapshotLabel(agora - 3 * 3600_000, agora), /^hoje \d\d:\d\d$/);
  assert.match(snapshotLabel(agora - 26 * 3600_000, agora), /^ontem \d\d:\d\d$/);
});
