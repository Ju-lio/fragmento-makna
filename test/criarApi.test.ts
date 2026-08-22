import test from 'node:test';
import assert from 'node:assert/strict';
import {
  num, cor, bool, texto, opcao,
  padroes, normalizar, conferirValores, variaveisCss,
  validarMeta, validarEsquema, validarManifesto, TIPOS,
} from '../src/criar/api.ts';
import type { Params } from '../src/criar/api.ts';

const esquema = {
  intensidade: num(0.5, { min: 0, max: 2, passo: 0.01 }),
  raio: num(12, { min: 0, max: 80, unidade: 'px' }),
  cor: cor('#ff00aa'),
  ligado: bool(true),
  titulo: texto('OI'),
  modo: opcao(['screen', 'multiply', 'overlay'] as const, 'screen'),
};

// --- padrões ------------------------------------------------------------

test('padroes devolve o valor inicial de cada param', () => {
  assert.deepEqual(padroes(esquema), {
    intensidade: 0.5, raio: 12, cor: '#ff00aa',
    ligado: true, titulo: 'OI', modo: 'screen',
  });
});

test('esquema vazio é legítimo', () => {
  assert.deepEqual(padroes({}), {});
  assert.equal(validarEsquema({}), null);
});

// --- normalização -------------------------------------------------------

test('normalizar sempre devolve algo desenhável', () => {
  // É a promessa do caminho de desenho: nunca falha, sempre cai no padrão.
  const v = normalizar(esquema, { intensidade: 'lixo', modo: 'inexistente', ligado: 'sim' });
  assert.equal(v.intensidade, 0.5);
  assert.equal(v.modo, 'screen');
  assert.equal(v.ligado, true);
});

test('número fora da faixa é limitado, não descartado', () => {
  // Limitar preserva a INTENÇÃO ("bem forte"); cair no padrão a jogaria fora.
  assert.equal(normalizar(esquema, { intensidade: 99 }).intensidade, 2);
  assert.equal(normalizar(esquema, { intensidade: -5 }).intensidade, 0);
});

test('string numérica é aceita, string vazia não', () => {
  // O campo do painel devolve string; vazio significa "apaguei pra digitar
  // de novo", e virar 0 faria o efeito piscar enquanto se digita.
  assert.equal(normalizar(esquema, { intensidade: '1.25' }).intensidade, 1.25);
  assert.equal(normalizar(esquema, { intensidade: '' }).intensidade, 0.5);
  assert.equal(normalizar(esquema, { intensidade: null }).intensidade, 0.5);
});

test('normalizar aguenta lixo no lugar do objeto inteiro', () => {
  for (const entrada of [null, undefined, 42, 'texto', []]) {
    assert.deepEqual(normalizar(esquema, entrada), padroes(esquema));
  }
});

test('chave desconhecida no valor é ignorada', () => {
  const v = normalizar(esquema, { intensidade: 1, sobrando: 'x' });
  assert.equal('sobrando' in v, false);
});

// --- conferência --------------------------------------------------------

test('conferirValores acha o que normalizar corrigiu em silêncio', () => {
  const problemas = conferirValores(esquema, { intensidade: 99, modo: 'nada', ligado: 'sim' });
  assert.equal(problemas.length, 3);
  assert.match(problemas.join(' '), /intensidade.*faixa/);
  assert.match(problemas.join(' '), /modo/);
});

test('valor ausente não é problema — cai no padrão', () => {
  assert.deepEqual(conferirValores(esquema, {}), []);
});

test('valores certos não geram queixa', () => {
  assert.deepEqual(conferirValores(esquema, padroes(esquema)), []);
});

// --- variáveis CSS ------------------------------------------------------

test('params viram variáveis CSS com prefixo', () => {
  const css = variaveisCss(esquema, padroes(esquema));
  assert.equal(css['--p-intensidade'], '0.5');
  assert.equal(css['--p-cor'], '#ff00aa');
  assert.equal(css['--p-modo'], 'screen');
});

test('a unidade entra na variável, não no painel', () => {
  // O campo mostra 12; o CSS recebe 12px. Sem isso o autor escreveria
  // calc(var(--p-raio) * 1px) em todo lugar.
  assert.equal(variaveisCss(esquema, padroes(esquema))['--p-raio'], '12px');
});

test('booleano vira 1/0 porque CSS não tem booleano', () => {
  assert.equal(variaveisCss(esquema, { ...padroes(esquema), ligado: true })['--p-ligado'], '1');
  assert.equal(variaveisCss(esquema, { ...padroes(esquema), ligado: false })['--p-ligado'], '0');
});

test('texto sai entre aspas, pra servir direto em content:', () => {
  const css = variaveisCss(esquema, { ...padroes(esquema), titulo: 'oi "mundo"' });
  assert.equal(css['--p-titulo'], '"oi \\"mundo\\""');
});

// --- validação de meta --------------------------------------------------

test('meta precisa de um tipo conhecido', () => {
  assert.equal(validarMeta({ tipo: 'efeito', nome: 'Raio' }), null);
  assert.match(String(validarMeta({ tipo: 'transition', nome: 'x' })), /tipo inválido/);
  assert.match(String(validarMeta({ nome: 'x' })), /tipo inválido/);
});

test('os quatro tipos são aceitos', () => {
  for (const tipo of TIPOS) {
    assert.equal(validarMeta({ tipo, nome: 'x' }), null, tipo);
  }
});

test('meta sem nome é recusada', () => {
  assert.match(String(validarMeta({ tipo: 'efeito', nome: '   ' })), /nome/);
});

test('meta não-objeto é recusada sem explodir', () => {
  for (const entrada of [null, undefined, 7, 'efeito', []]) {
    assert.equal(typeof validarMeta(entrada), 'string');
  }
});

// --- validação de esquema -----------------------------------------------

test('esquema bom passa', () => {
  assert.equal(validarEsquema(esquema), null);
});

test('nome de param que quebraria a variável CSS é recusado', () => {
  // Vira `--p-<chave>`: um espaço ou dois-pontos aqui geraria CSS inválido
  // silenciosamente, e o efeito falharia longe da causa.
  for (const ruim of ['meu param', 'cor:1', '2fast', 'com-traco', '']) {
    assert.match(String(validarEsquema({ [ruim]: num(1) })), /inválido/, ruim);
  }
});

test('min maior que max é recusado', () => {
  assert.match(String(validarEsquema({ x: num(1, { min: 10, max: 2 }) })), /min/);
});

test('padrão fora da lista de opções é recusado', () => {
  const invalido = { tipo: 'opcao', valores: ['a', 'b'], padrao: 'c' };
  assert.match(String(validarEsquema({ modo: invalido })), /não está na lista/);
});

test('padrão do tipo errado é recusado', () => {
  assert.match(String(validarEsquema({ x: { tipo: 'num', padrao: 'oito' } })), /número/);
  assert.match(String(validarEsquema({ x: { tipo: 'bool', padrao: 1 } })), /booleano/);
});

test('tipo de param desconhecido é recusado', () => {
  assert.match(String(validarEsquema({ x: { tipo: 'vetor3', padrao: 0 } })), /desconhecido/);
});

// --- manifesto ----------------------------------------------------------

test('manifesto completo passa', () => {
  assert.equal(validarManifesto({ meta: { tipo: 'filtro', nome: 'Ruído' }, params: esquema }), null);
});

test('efeito sem params é legítimo', () => {
  assert.equal(validarManifesto({ meta: { tipo: 'efeito', nome: 'Shake' } }), null);
});

test('manifesto reprova pelo meta antes de olhar params', () => {
  const problema = validarManifesto({ meta: { tipo: 'xis', nome: 'a' }, params: { 'in valido': num(1) } });
  assert.match(String(problema), /tipo inválido/);
});

// --- a ponte de tipos ---------------------------------------------------

test('os tipos inferidos são os certos', () => {
  // Não roda nada: o valor deste teste é o compilador aceitar (ou não) as
  // atribuições abaixo. `npm run typecheck` é quem de fato o executa.
  const p: Params<typeof esquema> = padroes(esquema);
  const n: number = p.intensidade;
  const c: string = p.cor;
  const b: boolean = p.ligado;
  const m: 'screen' | 'multiply' | 'overlay' = p.modo;
  assert.deepEqual([typeof n, typeof c, typeof b, typeof m], ['number', 'string', 'boolean', 'string']);
});
