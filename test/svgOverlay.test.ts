import test from 'node:test';
import assert from 'node:assert/strict';
import {
  montarSvg, emCdata, emAtributo, faceDeFonte, declaracaoDeVars, comoDataUri,
  recursosExternos, temStyleInline, fontesFaltando,
} from '../src/criar/svg.ts';

const base = { largura: 1920, altura: 1080, css: '.a{color:red}', corpo: '<div class="a"></div>' };

// --- CDATA: o que quebrava o quadro inteiro -----------------------------

test('CDATA deixa o CSS passar intacto', () => {
  assert.equal(emCdata('.a{color:red}'), '<![CDATA[.a{color:red}]]>');
});

test('`<` no CSS sobrevive — era o que sumia com o quadro', () => {
  // `syntax: '<integer>'` num @property abria uma tag XML e o SVG não
  // parseava. Não saía torto: sumia.
  const css = `@property --n { syntax: '<integer>'; }`;
  const svg = montarSvg({ ...base, css });
  assert.ok(svg.includes("syntax: '<integer>'"), 'o texto original está lá');
  assert.ok(svg.includes('<![CDATA['), 'e está dentro de CDATA');
});

test('`]]>` no CSS não fecha o CDATA cedo', () => {
  // O caso patológico: fechar a seção no meio do CSS truncaria o resto.
  const saida = emCdata('a{content:"]]>"}');
  assert.equal(saida.includes(']]]]><![CDATA[>'), true, 'fecha e reabre em volta do >');
  // e o conteúdo, remontado, continua sendo o original
  const remontado = saida.replaceAll('<![CDATA[', '').replaceAll(']]>', '');
  assert.equal(remontado, 'a{content:"]]>"}'.replaceAll(']]>', ']]>'));
});

test('`&` no CSS não vira entidade', () => {
  const svg = montarSvg({ ...base, css: '.a:hover .b{color:red}/* a & b */' });
  assert.ok(svg.includes('/* a & b */'), 'o & passou cru dentro do CDATA');
});

// --- o embrulho ---------------------------------------------------------

test('os dois xmlns estão presentes', () => {
  // O de dentro é o do XHTML. Sem ele o conteúdo do foreignObject não é
  // reconhecido como HTML e o quadro sai EM BRANCO, sem erro nenhum.
  const svg = montarSvg(base);
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('xmlns="http://www.w3.org/1999/xhtml"'));
});

test('o embrulho carrega o tamanho do projeto', () => {
  // É contra ele que vw/vh/% resolvem — o que faz o mesmo efeito servir
  // 1920x1080 e 1080x1920 sem o autor mexer em nada.
  const svg = montarSvg({ ...base, largura: 1080, altura: 1920 });
  assert.ok(svg.includes('width="1080" height="1920"'));
  assert.ok(svg.includes('width:1080px;height:1920px'));
  assert.ok(svg.includes('.frag-cena{position:relative;width:1080px;height:1920px'));
});

test('o corpo entra sem modificação', () => {
  const corpo = '<div class="a"><span>oi</span></div>';
  assert.ok(montarSvg({ ...base, corpo }).includes(corpo));
});

// --- variáveis ----------------------------------------------------------

test('as variáveis entram no style do embrulho', () => {
  const svg = montarSvg({ ...base, vars: { '--p-cor': '#f00', '--frag-t': '1.5s' } });
  assert.ok(svg.includes('--frag-t:1.5s'));
  assert.ok(svg.includes('--p-cor:#f00'));
});

test('a ordem das variáveis é estável', () => {
  // Duas ordens diferentes de entrada não podem gerar strings diferentes:
  // isso viraria invalidação de cache fantasma.
  const a = declaracaoDeVars({ '--b': '2', '--a': '1' });
  const b = declaracaoDeVars({ '--a': '1', '--b': '2' });
  assert.equal(a, b);
  assert.equal(a, '--a:1;--b:2');
});

test('sem variáveis, o style não ganha ponto-e-vírgula solto', () => {
  const svg = montarSvg(base);
  assert.ok(svg.includes('style="width:1920px;height:1080px"'));
});

test('valor de variável com aspas não escapa do atributo', () => {
  // `texto()` sai entre aspas de api.ts, e o style é um atributo XML.
  const svg = montarSvg({ ...base, vars: { '--p-titulo': '"oi"' } });
  assert.ok(!svg.includes('style="width:1920px;height:1080px;--p-titulo:"oi""'), 'não vazou');
  assert.ok(svg.includes('&quot;oi&quot;'));
});

test('emAtributo escapa os cinco perigosos', () => {
  assert.equal(emAtributo('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
});

// --- fontes -------------------------------------------------------------

test('a fonte embutida entra antes do CSS do autor', () => {
  const face = faceDeFonte('Minha', 'data:font/ttf;base64,AAAA');
  const svg = montarSvg({ ...base, fontes: [face] });
  assert.ok(svg.indexOf('@font-face') < svg.indexOf('.a{color:red}'), '@font-face vem antes');
  assert.ok(face.includes("font-family:'Minha'"));
  assert.ok(face.includes('font-display:block'), 'block: sem FOUT dentro de um snapshot estático');
});

// --- data URI -----------------------------------------------------------

test('o data URI escapa o que quebraria a URL', () => {
  const uri = comoDataUri(montarSvg({ ...base, css: '.a{content:"#x"}' }));
  assert.ok(uri.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.ok(!uri.slice(33).includes('#'), 'o # viraria fragmento de URL e cortaria o resto');
  assert.equal(decodeURIComponent(uri.slice(33)).includes('.a{content:"#x"}'), true);
});

// --- checagens de carga -------------------------------------------------

test('recurso externo é detectado nas formas que aparecem', () => {
  const css = `
    @import url("https://fonts.googleapis.com/css2?family=Inter");
    .a{background:url(https://exemplo.com/a.png)}
    .b{background:url('//cdn.exemplo.com/b.png')}
  `;
  const achados = recursosExternos(css);
  assert.equal(achados.length, 3);
  assert.ok(achados.some(u => u.includes('googleapis')));
  assert.ok(achados.some(u => u.startsWith('//cdn')));
});

test('data URI e caminho relativo não contam como externo', () => {
  const css = `.a{background:url(data:image/png;base64,AAA)} .b{background:url(./local.png)}`;
  assert.deepEqual(recursosExternos(css), []);
});

test('<style> no HTML do autor é detectado', () => {
  // Não passa pelo CDATA, então um `<` ali quebra o quadro.
  assert.equal(temStyleInline('<div><style>.a{}</style></div>'), true);
  assert.equal(temStyleInline('<div class="style"></div>'), false, 'não confunde com a palavra');
  assert.equal(temStyleInline('<div style="color:red"></div>'), false, 'nem com o atributo');
});

test('fonte usada mas não empacotada é apontada', () => {
  const css = `.a{font-family:'Minha Fonte', system-ui, sans-serif} .b{font-family:Outra}`;
  const faltando = fontesFaltando(css, ['Minha Fonte']);
  assert.deepEqual(faltando, ['Outra']);
});

test('as genéricas do CSS não são "faltando"', () => {
  const css = `.a{font-family:system-ui, sans-serif, monospace, ui-monospace}`;
  assert.deepEqual(fontesFaltando(css, []), []);
});

test('a comparação de fonte ignora caixa e aspas', () => {
  assert.deepEqual(fontesFaltando(`.a{font-family:"interblack"}`, ['InterBlack']), []);
});
