import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analisar, podeCarregar, contarNos, maiorDesfoque, chavesDesbalanceadas, avisoDeCobertura,
} from '../src/criar/validador.ts';
import { SEMENTES } from '../src/criar/sementes.ts';

const bom = {
  meta: { tipo: 'efeito', nome: 'Teste' },
  html: '<div class="a"></div>',
  css: '.a{opacity:.5}',
};
const de = (o: Partial<typeof bom> & { fontes?: string[]; params?: unknown } = {}) =>
  analisar({ ...bom, ...o });
const mensagens = (o: Parameters<typeof de>[0] = {}) => de(o).map(p => p.mensagem).join(' | ');

// --- o caminho feliz ----------------------------------------------------

test('um efeito bem-comportado não gera nada', () => {
  assert.deepEqual(de(), []);
  assert.equal(podeCarregar(de()), true);
});

test('as quatro sementes do /criar passam limpas', () => {
  // Se as sementes disparassem aviso, a primeira coisa que a pessoa vê ao
  // abrir a página seria uma reclamação sobre o nosso próprio código.
  for (const [tipo, s] of Object.entries(SEMENTES)) {
    const problemas = analisar({
      meta: JSON.parse(s.manifesto).meta,
      params: JSON.parse(s.manifesto).params,
      html: s.html,
      css: s.css,
    });
    assert.deepEqual(problemas.map(p => `${p.nivel}: ${p.mensagem}`), [], tipo);
  }
});

// --- erros --------------------------------------------------------------

test('meta inválido é ERRO', () => {
  const p = de({ meta: { tipo: 'xis', nome: 'a' } });
  assert.equal(p[0]?.nivel, 'erro');
  assert.equal(podeCarregar(p), false);
});

test('params com tipo inexistente é ERRO', () => {
  const p = de({ params: { x: { tipo: 'vetor3', padrao: 0 } } });
  assert.equal(podeCarregar(p), false);
  assert.match(mensagens({ params: { x: { tipo: 'vetor3', padrao: 0 } } }), /desconhecido/);
});

test('chave de CSS não fechada é ERRO, com a contagem', () => {
  assert.match(mensagens({ css: '.a{color:red' }), /Falta.*1 chave/);
  assert.match(mensagens({ css: '.a{color:red}}' }), /Sobra.*1 chave/);
});

test('chave dentro de comentário não conta', () => {
  assert.equal(chavesDesbalanceadas('/* isto { não conta */ .a{color:red}'), 0);
  assert.deepEqual(de({ css: '/* { */ .a{color:red}' }), []);
});

test('recurso externo é ERRO — ele simplesmente não carrega', () => {
  const p = de({ css: '.a{background:url(https://x.com/a.png)}' });
  assert.equal(p[0]?.nivel, 'erro');
  assert.match(p[0]!.saida ?? '', /pacote/);
});

// --- avisos -------------------------------------------------------------

test('as quatro fontes de não-determinismo são apontadas', () => {
  for (const trecho of ['Math.random()', 'Date.now()', 'new Date()', 'performance.now()']) {
    const p = de({ html: `<div>${trecho}</div>` });
    assert.equal(p.length, 1, trecho);
    assert.equal(p[0]?.nivel, 'aviso', trecho);
    assert.match(p[0]!.saida ?? '', /rng\(\)/, trecho);
  }
});

test('handler inline é apontado — o sandbox bloqueia e o autor procura no lugar errado', () => {
  const p = de({ html: '<div onclick="fazer()" onmouseover="x()"></div>' });
  assert.equal(p.length, 1);
  assert.match(p[0]!.mensagem, /onclick, onmouseover/);
  assert.match(p[0]!.saida ?? '', /@keyframes/);
});

test('atributo comum não é confundido com handler', () => {
  assert.deepEqual(de({ html: '<div data-on="x" class="only"></div>' }), []);
});

test('o aviso de determinismo explica a CONSEQUÊNCIA, não só a regra', () => {
  // "é proibido" não ensina; "o vídeo vai tremer" ensina.
  assert.match(mensagens({ html: '<b>Math.random()</b>' }), /tremer/);
});

test('canvas e WebGL são apontados', () => {
  for (const trecho of ['<canvas></canvas>', 'new THREE.Scene()', 'getContext("webgl")']) {
    assert.match(mensagens({ html: trecho }), /não aparece no quadro/, trecho);
  }
});

test('a saída pro canvas aponta o que FUNCIONA', () => {
  assert.match(de({ html: '<canvas></canvas>' })[0]!.saida ?? '', /perspective/);
});

test('rede é apontada', () => {
  assert.match(mensagens({ html: '<b>fetch("/x")</b>' }), /offline/);
  assert.match(mensagens({ html: '<b>new XMLHttpRequest()</b>' }), /offline/);
});

test('<style> no HTML é apontado, com o motivo', () => {
  assert.match(mensagens({ html: '<style>.a{}</style>' }), /CDATA/);
});

test('fonte não embutida é apontada; embutida não', () => {
  const css = `.a{font-family:'Minha', sans-serif}`;
  assert.match(mensagens({ css }), /"Minha" não vem no pacote/);
  assert.deepEqual(analisar({ ...bom, css, fontes: ['Minha'] }), []);
});

test('backdrop-filter sem slot é apontado — é o caso do vidro', () => {
  const css = '.a{backdrop-filter:blur(20px)}';
  assert.match(mensagens({ css }), /não enxerga|só enxerga/);
  // com slot declarado, é justamente o jeito certo de fazer
  assert.deepEqual(
    analisar({ ...bom, css, html: '<div data-frag="vidro"></div>' }),
    [],
  );
});

// --- custo --------------------------------------------------------------

test('contarNos conta abertura, não fechamento', () => {
  assert.equal(contarNos('<div><span>a</span></div>'), 2);
  assert.equal(contarNos('<div/><br>'), 2);
  assert.equal(contarNos('<!-- comentário --><div>'), 1);
});

test('muitos nós vira aviso de CUSTO, não erro', () => {
  const html = '<div></div>'.repeat(600);
  const p = analisar({ ...bom, html });
  assert.equal(p.length, 1);
  assert.equal(p[0]?.nivel, 'custo');
  assert.equal(podeCarregar(p), true, 'custo não impede de carregar');
  assert.match(p[0]!.mensagem, /600 elementos/);
});

test('500 nós ainda não reclama; 501 reclama', () => {
  assert.deepEqual(analisar({ ...bom, html: '<i></i>'.repeat(500) }), []);
  assert.equal(analisar({ ...bom, html: '<i></i>'.repeat(501) }).length, 1);
});

test('maiorDesfoque pega blur e drop-shadow, e o maior de vários', () => {
  assert.equal(maiorDesfoque('.a{filter:blur(12px)}'), 12);
  assert.equal(maiorDesfoque('.a{filter:drop-shadow(0 0 34px #fff)}'), 34);
  assert.equal(maiorDesfoque('.a{filter:blur(8px) drop-shadow(2px 4px 40px #f00)}'), 40);
  assert.equal(maiorDesfoque('.a{opacity:.5}'), 0);
});

test('desfoque grande vira aviso de custo com o número medido', () => {
  const p = de({ css: '.a{filter:blur(40px)}' });
  assert.equal(p[0]?.nivel, 'custo');
  assert.match(p[0]!.mensagem, /45 ms/);
  assert.match(p[0]!.saida ?? '', /canvas 2D custa mais/, 'não culpa o DOM injustamente');
});

test('desfoque pequeno não reclama', () => {
  assert.deepEqual(de({ css: '.a{filter:blur(12px)}' }), []);
});

// --- cobertura (depende do projeto, não do pacote) ----------------------

test('efeito curto não gera aviso de cobertura', () => {
  assert.equal(avisoDeCobertura(3, 60), null);
});

test('efeito que cobre o vídeo inteiro gera aviso de custo', () => {
  const p = avisoDeCobertura(60, 60);
  assert.equal(p?.nivel, 'custo');
  assert.match(p!.mensagem, /100%/);
});

test('projeto de duração zero não divide por zero', () => {
  assert.equal(avisoDeCobertura(3, 0), null);
});

// --- ordem --------------------------------------------------------------

test('erro vem antes de aviso', () => {
  // Quem vê um erro não precisa ler os avisos ainda.
  const p = analisar({
    meta: { tipo: 'xis', nome: 'a' },
    html: '<b>Math.random()</b>',
    css: '.a{}',
  });
  assert.equal(p[0]?.nivel, 'erro');
  assert.equal(p.at(-1)?.nivel, 'aviso');
});
