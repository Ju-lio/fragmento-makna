/**
 * O caso que motivou o arquivo: um REMIX — várias fatias curtas do mesmo
 * vídeo, em ordem trocada.
 *
 * O defeito que estes testes travam não era "o quadro não chega": era o quadro
 * chegar tarde porque o decodificador foi reiniciado no corte. Como isso não se
 * enxerga num teste de entrega (o quadro chega, e é diferente do anterior),
 * aqui se olha a SEQUÊNCIA de quadros pedida a cada decodificador. Reset é o
 * que acontece quando ela salta; se ela é contígua, não há o que reiniciar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  framePlanAt, frameServes, highWaterAfterAim, providersToDrop, sourceFrameOf,
  MARCA_DESCONHECIDA,
} from '../src/engine/framePlan.ts';
import type { PlanLimits, VideoClip } from '../src/engine/framePlan.ts';

const LIMITES: PlanLimits = { lookahead: 12, minLookahead: 4, preArm: 0.6 };
const FPS = 30;

/** Uma fatia de 0,2s do mesmo arquivo, lida a partir de `trimStart`. */
function fatia(id: number, start: number, trimStart: number, duration = 0.2): VideoClip {
  return { id, mediaId: 'um-arquivo-só', start, duration, trimStart, sourceDuration: 20 };
}

/**
 * O remix: seis fatias de 0,2s do MESMO arquivo, em ordem embaralhada.
 * Cada uma lê um ponto distante da anterior — que é o que fazia o índice de
 * quadro saltar quando havia um decodificador só.
 */
const REMIX: VideoClip[] = [
  fatia(1, 0.0, 12.0),
  fatia(2, 0.2, 3.0),
  fatia(3, 0.4, 17.4),
  fatia(4, 0.6, 0.6),
  fatia(5, 0.8, 9.2),
  fatia(6, 1.0, 6.4),
];

// --- um decodificador por clipe -----------------------------------------

test('duas fatias do mesmo arquivo pedem decodificadores SEPARADOS', () => {
  // As duas visíveis ao mesmo tempo, em faixas diferentes: com chave por
  // `mediaId` elas escreviam o playhead do mesmo decodificador, uma desfazendo
  // a mira da outra a cada quadro.
  const a = fatia(1, 0, 2.0, 4);
  const b = { ...fatia(2, 0, 15.0, 4), track: 1 };

  const plano = framePlanAt([a, b], 1, FPS, LIMITES);

  assert.deepEqual(plano.map(p => p.id), [1, 2]);
  assert.equal(plano[0]?.mediaId, plano[1]?.mediaId);
  // Cada um mirando o próprio ponto do arquivo, e não o do vizinho.
  assert.equal(plano[0]?.sourceFrame, Math.round(3.0 * FPS));
  assert.equal(plano[1]?.sourceFrame, Math.round(16.0 * FPS));
});

test('atravessando o remix inteiro, nenhum decodificador vê um salto', () => {
  /**
   * Este é o teste da dívida. Anda quadro a quadro pela linha do tempo e anota,
   * por decodificador, a sequência de quadros de arquivo pedida. Um corte só
   * pode aparecer como um decodificador NOVO entrando — nunca como um salto
   * dentro da sequência de um que já estava rodando, porque é isso que o
   * `@elah/core` trata como descontinuidade e paga com um reset.
   */
  const pedidos = new Map<number, number[]>();
  const duracao = 1.2;

  for (let quadro = 0; quadro <= Math.round(duracao * FPS); quadro++) {
    const t = quadro / FPS;
    for (const alvo of framePlanAt(REMIX, t, FPS, LIMITES)) {
      if (!alvo.onScreen) continue;   // armar é mirar o começo; ainda não é leitura
      const serie = pedidos.get(alvo.id) ?? [];
      if (serie[serie.length - 1] !== alvo.sourceFrame) serie.push(alvo.sourceFrame);
      pedidos.set(alvo.id, serie);
    }
  }

  assert.equal(pedidos.size, 6, 'as seis fatias foram lidas');
  for (const [id, serie] of pedidos) {
    for (let i = 1; i < serie.length; i++) {
      const passo = (serie[i] as number) - (serie[i - 1] as number);
      assert.equal(passo, 1, `decodificador ${id} saltou ${passo} quadros dentro da própria fatia`);
    }
  }
});

test('na fronteira do corte, o quadro é de quem ENTRA — só dele', () => {
  /**
   * O trecho é meio-aberto (ver `timeSpan.ts`). Antes as duas fatias contavam
   * a fronteira, e isso custava caro em dois lugares: o `framesReadyAt` exigia
   * o quadro da fatia que sai pra poder desenhar o corte (engasgo em toda
   * emenda), e no desenho quem ficava por cima era o último do array — que num
   * remix pode ser justamente o clipe que está TERMINANDO.
   */
  const plano = framePlanAt(REMIX, 0.2, FPS, LIMITES);
  const naTela = plano.filter(p => p.onScreen);

  assert.deepEqual(naTela.map(p => p.id), [2], 'só a fatia que entra está na tela');
  assert.equal(naTela[0]?.sourceFrame, Math.round(3.0 * FPS), 'e no PRIMEIRO quadro dela');
});

test('a fatia que sai ainda é dona do quadro anterior à fronteira', () => {
  // O outro lado da mesma regra: meio-aberto tira dela a fronteira, não o
  // último quadro de verdade. Perder este seria trocar o quadro duplicado por
  // um quadro faltando.
  const plano = framePlanAt(REMIX, 0.2 - 1 / FPS, FPS, LIMITES);
  const porId = new Map(plano.filter(p => p.onScreen).map(p => [p.id, p]));

  assert.equal(porId.has(1), true, 'a fatia que sai ainda está na tela');
  assert.equal(porId.has(2), false, 'a que entra ainda não');
});

test('um clipe de N segundos ocupa round(N × fps) quadros, nem um a mais', () => {
  // A conta que o `<=` quebrava: 0,2s a 30fps são 6 quadros (0..5). Com a
  // fronteira contada, eram 7 — e um clipe de 3s cobria 91 quadros.
  const fatia6 = fatia(1, 0.0, 12.0, 0.2);
  let quadros = 0;
  for (let i = 0; i < 20; i++) {
    if (framePlanAt([fatia6], i / FPS, FPS, LIMITES).some(p => p.onScreen)) quadros++;
  }

  assert.equal(quadros, Math.round(0.2 * FPS));
});

// --- um corte: a sequência que o arquivo tem que produzir ----------------

test('atravessar um corte lê 0…3s e depois 7…10s, sem passar pelo meio', () => {
  /**
   * A propriedade da ETAPA 3, escrita como sequência.
   *
   * Duas fatias do MESMO arquivo: `[0–3s]` lendo o começo e `[3–6s]` lendo a
   * partir de 7s. O que a linha do tempo tem que produzir é
   * `0 1 2 3 | 7 8 9 10` — e o que ela NÃO pode produzir é a passagem contínua
   * `…3 4 5 6 7…`, que é o sintoma de o motor estar lendo o arquivo em linha
   * reta e ignorando o corte.
   *
   * Anda quadro a quadro e anota, pra cada quadro da linha do tempo, de qual
   * clipe ele é e qual quadro do ARQUIVO ele pede.
   */
  const A = { id: 1, mediaId: 'um', start: 0, duration: 3, trimStart: 0, sourceDuration: 20 };
  const B = { id: 2, mediaId: 'um', start: 3, duration: 3, trimStart: 7, sourceDuration: 20 };

  const lidos: { dono: number; quadro: number }[] = [];
  for (let i = 0; i < Math.round(6 * FPS); i++) {
    const naTela = framePlanAt([A, B], i / FPS, FPS, LIMITES).filter(p => p.onScreen);
    assert.equal(naTela.length, 1, `o quadro ${i} tem ${naTela.length} donos`);
    lidos.push({ dono: naTela[0]!.id, quadro: naTela[0]!.sourceFrame });
  }

  // A primeira metade é do clipe A, lendo do começo do arquivo.
  assert.deepEqual(lidos.slice(0, 4).map(l => l.quadro), [0, 1, 2, 3]);
  assert.ok(lidos.slice(0, 90).every(l => l.dono === 1), 'os 90 primeiros são de A');

  // E no corte o arquivo SALTA pra 7s — não passa por 4, 5, 6.
  assert.equal(lidos[89]?.quadro, 89, 'último quadro de A = 89 (2,9667s)');
  assert.equal(lidos[90]?.quadro, Math.round(7 * FPS), 'primeiro de B = 210 (7s)');
  assert.equal(lidos[90]?.dono, 2);

  // Nenhum quadro entre 90 e 209 é lido: é justamente o trecho descartado.
  const meio = lidos.filter(l => l.quadro > 89 && l.quadro < 210);
  assert.deepEqual(meio, [], 'o trecho cortado fora não pode ser lido');
});

test('dentro de cada fatia a leitura é contígua — nada de reset no meio', () => {
  // O corte é o único salto permitido. Um salto DENTRO de uma fatia é o que o
  // `@elah/core` lê como descontinuidade e paga com reset de decodificador.
  const A = { id: 1, mediaId: 'um', start: 0, duration: 3, trimStart: 0, sourceDuration: 20 };
  const B = { id: 2, mediaId: 'um', start: 3, duration: 3, trimStart: 7, sourceDuration: 20 };

  const series = new Map<number, number[]>();
  for (let i = 0; i < Math.round(6 * FPS); i++) {
    for (const alvo of framePlanAt([A, B], i / FPS, FPS, LIMITES)) {
      if (!alvo.onScreen) continue;
      const s = series.get(alvo.id) ?? [];
      s.push(alvo.sourceFrame);
      series.set(alvo.id, s);
    }
  }

  for (const [id, s] of series) {
    for (let i = 1; i < s.length; i++) {
      assert.equal((s[i] as number) - (s[i - 1] as number), 1, `fatia ${id} saltou no meio`);
    }
  }
});

// --- armar antes do corte -----------------------------------------------

test('o clipe que entra logo já está no plano, mirando o próprio começo', () => {
  const plano = framePlanAt(REMIX, 0.05, FPS, LIMITES);
  const entrando = plano.find(p => p.id === 3);

  assert.ok(entrando, 'a fatia que entra em 0,4s (dentro do preArm) foi armada');
  assert.equal(entrando.onScreen, false);
  assert.equal(entrando.sourceFrame, Math.round(17.4 * FPS));
});

test('clipe distante demais NÃO é armado', () => {
  // Sem esse corte, um projeto de meia hora abriria a linha do tempo inteira.
  const longe = fatia(9, 30, 1.0);
  const plano = framePlanAt([...REMIX, longe], 0, FPS, LIMITES);

  assert.equal(plano.some(p => p.id === 9), false);
});

// --- o teto de quadros por decodificador --------------------------------

test('o lookahead não passa do fim do clipe', () => {
  // Numa fatia de 0,2s (6 quadros), pedir 12 à frente é decodificar e guardar
  // o dobro do que a fatia mostra — vezes vinte fatias, é o estouro de memória
  // que a correção trocaria pelo engasgo.
  const plano = framePlanAt(REMIX, 0.0, FPS, LIMITES);
  const primeira = plano.find(p => p.id === 1);

  assert.equal(primeira?.lookahead, 6);
});

test('no último quadro do clipe o lookahead ainda respeita o PISO', () => {
  /**
   * Modo de falha, não caminho feliz: o `@elah/core` chama de descontinuidade
   * um salto MAIOR que o lookahead. Com lookahead 0 no fim da fatia, andar um
   * único quadro viraria reset de decodificador — o defeito consertado nesta
   * fase, reintroduzido pela própria correção.
   */
  // O último quadro da fatia é o ANTERIOR à fronteira — ver a regra meio-aberta.
  const plano = framePlanAt(REMIX, 0.2 - 1 / FPS, FPS, LIMITES);
  const saindo = plano.find(p => p.id === 1);

  assert.equal(saindo?.lookahead, LIMITES.minLookahead);
  assert.ok((saindo?.lookahead ?? 0) > 0);
});

test('num clipe longo o lookahead para no teto', () => {
  const inteiro = fatia(7, 0, 0, 60);
  const plano = framePlanAt([inteiro], 1, FPS, LIMITES);

  assert.equal(plano[0]?.lookahead, LIMITES.lookahead);
});

// --- quem fecha primeiro -------------------------------------------------

const vivo = (id: number, usedAt: number) => ({ id, usedAt });

test('layer excluída fecha o decodificador na hora, mesmo sob o teto', () => {
  const fechados = providersToDrop([vivo(1, 10), vivo(2, 20)], {
    keep: new Set([2]),
    existing: new Set([2]),
    max: 8,
  });

  assert.deepEqual(fechados, [1]);
});

test('acima do teto, fecha o mais antigo', () => {
  const vivos = [vivo(1, 30), vivo(2, 10), vivo(3, 20), vivo(4, 40)];
  const existem = new Set([1, 2, 3, 4]);

  const fechados = providersToDrop(vivos, { keep: new Set([4]), existing: existem, max: 3 });

  assert.deepEqual(fechados, [2]);
});

test('o que está no plano NUNCA fecha, nem estourando o teto', () => {
  // Dez fatias visíveis ao mesmo tempo (dez faixas) com teto de 8: fechar
  // qualquer uma delas é garantir o buraco que o teto queria evitar.
  const vivos = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(id => vivo(id, id));
  const todas = new Set(vivos.map(v => v.id));

  const fechados = providersToDrop(vivos, { keep: todas, existing: todas, max: 8 });

  assert.deepEqual(fechados, []);
});

// --- a conta do trim, que o resto depende ---------------------------------

test('o quadro pedido é INTEIRO e sai do trim, não do tempo da linha', () => {
  const clipe = fatia(1, 2.0, 5.0, 1.0);

  // Quadro 61 a 30fps começa em 2,033333… — pedir por segundos põe a fronteira
  // à mercê do ponto flutuante; por índice, ela não existe.
  assert.equal(sourceFrameOf(clipe, 2 + 1 / 30, FPS), Math.round(5.0 * FPS) + 1);
  // Preso ao que o arquivo tem, dos dois lados.
  assert.equal(sourceFrameOf(clipe, 0, FPS), Math.round(3.0 * FPS));
});

// --- veio o quadro, ou veio um vizinho? ---------------------------------

test('o quadro exato serve', () => {
  assert.equal(frameServes(414, 414, 419), true);
});

test('vizinho NÃO serve enquanto o exato ainda pode chegar', () => {
  /**
   * O defeito que isto trava saiu no arquivo exportado: `413, 414, 414, 416,
   * 417, 417` onde o projeto pedia `414…419`. O `getCurrent` do `@elah/core`
   * entrega um quadro até dois atrás, e "veio algum quadro" foi aceito como
   * "veio o quadro".
   */
  assert.equal(frameServes(415, 414, 414), false);
  assert.equal(frameServes(415, 413, 414), false);
});

test('vizinho serve quando o exato não existe no arquivo', () => {
  // 29,97 num projeto a 30: o índice pedido pode simplesmente não existir, e
  // recusá-lo deixaria esse material esperando pra sempre. O decodificador já
  // ter passado do pedido é a prova de que ele não vem.
  assert.equal(frameServes(415, 414, 416), true);
});

test('sem índice conhecido, aceita — apagar a imagem seria pior', () => {
  assert.equal(frameServes(415, undefined, -1), true);
});

// --- voltar apaga o que sabíamos sobre a entrega -------------------------

test('mirar pra frente preserva a marca d\'água', () => {
  assert.equal(highWaterAfterAim(100, 101, 300), 300);
  assert.equal(highWaterAfterAim(100, 100, 300), 300, 'parado no mesmo quadro também');
});

test('mirar pra TRÁS zera a marca d\'água', () => {
  assert.equal(highWaterAfterAim(300, 100, 300), MARCA_DESCONHECIDA);
});

test('depois de voltar, o vizinho volta a ser recusado', () => {
  /**
   * O defeito inteiro, em três linhas. A reprodução adiantou o lookahead até o
   * quadro 300; você arrasta o cursor de volta pro 100. Sem zerar a marca,
   * `300 > 100` seguia verdadeiro pra SEMPRE e todo índice abaixo de 300
   * passava a aceitar o quadro vizinho — o defeito do `<video>` (mostrar o
   * quadro de antes) reintroduzido pela própria correção, e logo depois do
   * gesto mais comum que existe num editor.
   */
  assert.equal(frameServes(100, 98, 300), true, 'era isto que acontecia antes');

  const marca = highWaterAfterAim(300, 100, 300);
  assert.equal(frameServes(100, 98, marca), false, 'agora espera o quadro exato');
  assert.equal(frameServes(100, 100, marca), true, 'e serve assim que ele chega');
});

test('a marca se reconstrói sozinha quando o índice não existe no arquivo', () => {
  /**
   * Zerar não pode deixar material 29,97 esperando pra sempre: o decodificador
   * segue entregando, passa do pedido, e a prova de que o exato não vem se
   * refaz — agora medida a partir do ponto pra onde você voltou.
   */
  let marca = highWaterAfterAim(300, 100, 300);
  assert.equal(frameServes(100, 99, marca), false);

  // O decodificador entregou 99 e depois 101: o 100 não existe neste arquivo.
  for (const entregue of [99, 101]) marca = Math.max(marca, entregue);

  assert.equal(frameServes(100, 99, marca), true);
});
