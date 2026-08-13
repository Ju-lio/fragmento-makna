# Fragmento

Editor de motion graphics no browser, com estética pixel-art e efeitos definidos
como **dados** (JSON) em vez de código — pra que efeitos novos possam ser gerados
sob demanda e colados direto na interface.

```bash
npm install
npm run dev        # desenvolvimento
npm test           # testes (node --test, direto nos .ts)
npm run typecheck  # tsc --noEmit
npm run lint       # oxlint
npm run build      # typecheck + build de produção
```

Projeto em **TypeScript** com `strict` ligado. Não há etapa de build pros
testes: o `node --test` roda os `.ts` por *type stripping*, então os imports
carregam a extensão real (`./player.ts`) e o mesmo arquivo serve pro Vite, pro
`tsc` e pro runner de teste. É também por isso que `erasableSyntaxOnly` está
ligado no `tsconfig.json` — `enum`, `namespace` e *parameter property* não são
apagáveis e quebrariam só na hora de rodar; assim o erro aparece no typecheck.

## Arquitetura

A regra que sustenta tudo: **o engine não conhece o React.**

```
src/
  engine/            <- TS puro, zero dependência de framework
    types.ts           modelo de domínio (Layer, Project, Effect) — só tipos
    easings.ts         curvas de aceleração
    effects.ts         runtime: sampleTrack, effectProgress, resolveState
    renderer.ts        drawFrame(ctx, project, t) — função pura
    player.ts          relógio + loop rAF (fora do React de propósito)
    presets.ts         biblioteca inicial + doc do schema
    project.ts         modelo de dados
    fonts.ts           carga explícita da fonte do canvas
    viewport.ts        zoom, fit e pan do preview
    videoSync.ts       alinha os <video> ao relógio
    frameCache.ts      cache de frames compostos + assinatura
    frameSource.ts     de onde tirar cada quadro (cache ou ao vivo)
    prerender.ts       preenche um trecho quadro a quadro
    videoExport.ts     compõe o trecho e codifica (WebCodecs)
    exportPlan.ts      as decisões do export que não dependem do browser
    progress.ts        observável de progresso (pré-render, export)
    trackDrag.ts       para onde vai um clipe arrastado na timeline
    history.ts         pilha de undo/redo, genérica
    serialize.ts       projeto ↔ JSON (puro, sem DOM)
    mediaStore.ts      blobs e projeto em IndexedDB
    previewMode.ts     o interruptor ⚡ FAST
    previewStatus.ts   sinal da barra de atividade
  ui/                <- React: só o chrome da interface
  styles/            <- design system pixel
```

`types.ts` fica separado de propósito: `effects.ts` precisa saber o que é uma
`Layer` e `project.ts` precisa saber o que é um `Effect`. Com as duas
definições num arquivo só de tipos, os dois lados se referenciam sem ninguém
importar o runtime do outro — e o arquivo some inteiro na compilação, então não
existe ciclo em tempo de execução.

Se um dia o React virar estorvo, a parte valiosa sai inteira sem alteração.

### Performance

Três decisões deliberadas:

1. **O playhead não é estado do React.** Canvas, barra de playhead e timecode
   assinam o `player` e escrevem direto no DOM. Dar play ou arrastar o playhead
   causa **zero re-render** do React.
2. **Um único loop `requestAnimationFrame`** pro app inteiro, nunca um por
   componente.
3. **Frame sujo:** parado e sem mudanças, o loop não desenha nada. Editor ocioso
   não gasta CPU.

### Preview = Export

`drawFrame(ctx, project, t)` é função pura de `(projeto, tempo)` — não lê relógio
nem estado global. É o que permite o exportador produzir exatamente o que o
preview mostra, rodando o mesmo código quadro a quadro. Deixou de ser promessa:
ver "Export de vídeo" abaixo.

Cuidado já resolvido: **canvas não dispara carregamento de `@font-face`.** O
browser só busca a fonte quando um nó do DOM a usa, então uma fonte usada só no
canvas nunca carregaria. Por isso `fonts.ts` carrega explicitamente via `FontFace`,
e o export espera por ela antes de desenhar.

## Efeitos

Um efeito é JSON declarativo — sem `eval`, sem código arbitrário:

```json
{
  "name": "zoom-punch",
  "duration": 0.6,
  "tracks": [
    { "prop": "scale",   "keys": [[0, 0.6], [0.55, 1.06], [1, 1]], "ease": "outQuint" },
    { "prop": "opacity", "keys": [[0, 0], [0.3, 1]],               "ease": "outQuad" }
  ]
}
```

`keys` usa tempo normalizado (0 a 1), então o mesmo efeito funciona em qualquer
duração.

**Props:** `x`, `y`, `scale`, `rotate`, `opacity`, `blur`, `brightness`, `letterSpacing`.
O vocabulário é fechado de propósito: são exatamente as props que mapeiam tanto pra
CSS quanto pra canvas, o que garante que preview e export nunca divirjam.

**Composição:** `scale`, `opacity` e `brightness` multiplicam; o resto soma. É o que
permite empilhar vários efeitos na mesma layer sem que briguem.

### Fluxo de trabalho

1. Botão **SCHEMA** copia a documentação completa do formato
2. Cola no chat pedindo o efeito que você quer
3. Cola o JSON de volta na aba **Efeitos**

O app entrega um *runtime*, não um catálogo — a biblioteca cresce sob demanda.

## Viewport

O preview tem zoom, fit e pan — pensado pra editar em tela pequena.

| Ação | Atalho |
|---|---|
| Zoom no cursor | `Ctrl` + scroll |
| Zoom in / out | `Ctrl` `+` / `Ctrl` `-` |
| Fit | `Ctrl` `0` |
| Pan | arrastar, ou scroll |
| Play / pause | `Espaço` |

O estado do viewport vive em `engine/viewport.ts`, fora do React: arrastar
escreve uma única `transform` no DOM, sem re-render. Formatos disponíveis:
1920×1080, 1080×1920 (Reels/Shorts), 1080×1080, 1280×720 e custom.

## Vídeo e trim

Layer de vídeo (`+ MÍDIA`, aceita imagem ou vídeo) entra sempre **atrás** das
layers existentes, pra nunca tampar um título sem querer. Novidades:

- **Alças de trim** nas pontas do clipe da timeline — arrastar a esquerda corta
  o início *sem deslizar a imagem por baixo do cursor* (`trimLeft` em
  `project.ts` move `start` e `trimStart` juntos); arrastar a direita só encurta
  a duração (`trimRight`)
- Campos numéricos equivalentes na aba Props, pra ajuste fino
- **Arrastar o clipe** move no tempo e troca de faixa no mesmo gesto — ver
  "Arrastar layers entre faixas" abaixo
- `engine/videoSync.ts` mantém os elementos `<video>` alinhados ao relógio do
  player: **tocando**, corrige por velocidade e nunca por seek (ver "Corrigir
  deriva por velocidade"); **pausado/arrastando**, escreve a posição exata. A
  decisão em si (`videoSyncPlan`) é função pura, testável sem DOM nenhum
- Ao excluir uma layer de vídeo, o `<video>` é pausado e solto
  (`URL.revokeObjectURL` + `load()`), pra não vazar decoder

## Faixas com vários clipes

O modelo era uma layer por faixa. Virou o do CapCut: **uma faixa carrega vários
clipes**, desde que não se sobreponham no tempo.

A mudança cabe num campo. Cada layer ganhou `track: number` — número maior
desenha por cima — e essa invariante de não-sobreposição é o que faz a coisa
toda ficar simples: como nunca há dois clipes ativos no mesmo instante da mesma
faixa, a ordem *dentro* de uma faixa não importa pro desenho. A alternativa
(aninhar `tracks: { clips: [] }[]`) teria mexido em serialização, assinatura de
cache, trim, arrasto e todos os painéis, pra chegar no mesmo resultado.

A ordem de desenho passou a ser calculada, não a ordem do array — e memorizada
por referência do projeto, como `signatureOf`. Ordenar dentro do `drawFrame`
seria correto e alocaria um array por quadro, 60 vezes por segundo, no caminho
quente que o resto do editor faz questão de manter limpo.

Três coisas que a mudança obrigou a arrumar:

- **O arrasto ganhou colisão.** Cair em cima de outro clipe é recusado, e o
  indicador fica vermelho *durante* o gesto — descobrir que não valeu só depois
  de soltar é o que faz um arrasto parecer quebrado.
- **O trim ganhou vizinhos.** Esticar a alça direita comeria o clipe seguinte;
  agora `freeWindow` acha o espaço livre na faixa e as alças param nele.
- **As faixas se compactam.** Tirar o único clipe de uma faixa deixaria uma
  linha fantasma, e o editor acumularia faixas vazias a cada gesto.

Existe sempre uma faixa vazia no topo. Não é enfeite: sem ela não haveria pra
onde arrastar um clipe que está numa faixa cheia, e faixas novas seriam
impossíveis de criar depois que tudo se juntasse. Ela tem a mesma altura das
outras de propósito — o cálculo do arrasto mede o espaçamento entre as duas
primeiras linhas e assume que vale pra todas.

## Export de vídeo

O pré-render já era 80% de um exportador, e essa foi a razão de fazê-lo antes de
qualquer efeito novo. Ele percorre um trecho quadro a quadro, leva cada
`<video>` ao instante exato, **espera o `seeked` de verdade** e compõe em
qualidade cheia. O exportador reusa `stageVideosAt` — a parte genuinamente
difícil — e só troca o destino: em vez de guardar o bitmap no cache, o quadro
vai pro `VideoEncoder` e do encoder pro muxer.

Duas implementações desse seek divergiriam, e o arquivo deixaria de bater com o
preview. Como é uma só, "Preview = Export" passou de afirmação no README pra
propriedade verificável.

`exportPlan.ts` guarda as decisões que **não** dependem do navegador, separadas
justamente porque são as que produzem um arquivo silenciosamente errado:

- **Dimensões pares.** H.264 guarda croma em metade da resolução, então uma
  dimensão ímpar não existe pro formato: o encoder recusa a configuração e a
  mensagem não diz por quê. Um projeto 1080×607 é normal de montar e impossível
  de exportar sem isso.
- **Timestamps a partir do primeiro quadro exportado**, não do zero da timeline
  — quem exporta de 8s a 12s quer um arquivo de 4s, não quatro segundos de nada
  na frente.
- **Keyframe a cada dois segundos.** Espaçá-los demais faz o arrasto na barra do
  player travar; nunca forçá-los deixa o arquivo impossível de navegar.
- **Bitrate por pixels-por-segundo** (~0,1 bit por pixel por quadro, ~6 Mbps em
  1080p30). Escala sozinho: um vertical curto e um 4K não podem usar o mesmo
  número.

O codec é escolhido perguntando ao navegador, **com as dimensões junto** — o
suporte não é propriedade do codec sozinho, já que o nível declarado no nome
limita a resolução. H.264 vem primeiro porque abre em qualquer lugar; VP9 é a
reserva pra builds sem encoder H.264 licenciado.

Dois freios que a aba não sobrevive sem:

- **Fila do encoder.** `encode()` não bloqueia. Enfileirar 4000 quadros de 1080p
  é enfileirar gigabytes de bitmap cru, e a aba morre antes de terminar.
- **`frame.close()` em `finally`.** Um `VideoFrame` não liberado segura a
  memória do quadro inteiro até o coletor passar, e o export estoura muito antes
  disso.

E o loop do preview sai da frente durante o export. A condição virou "eu sou o
dono dos `<video>`?" em vez de "o pré-render está rodando?" — é a condição real,
e um trabalho novo que reivindique os elementos passa a ser respeitado sem
ninguém precisar lembrar de ir lá mexer.

**Sem áudio ainda**, e é a maior lacuna do arquivo exportado hoje.

## Navegar quadro a quadro

Setas ← → andam um quadro; com Shift, um segundo. O passo usa `stepFrame`, que
**pousa na grade** em vez de somar `1/fps` ao tempo atual.

A diferença importa: um cursor que chegou ali arrastando está entre dois
quadros, e somar manteria o desalinhamento pra sempre — cada passo continuaria
fora da grade, e o preview recomporia quadros que o cache já tem. Arredondar
primeiro resolve os dois casos de uma vez.

Andar com o vídeo rodando pausa antes: o relógio desfaria o passo no quadro
seguinte.

## Cortar no cursor (Ctrl+B)

`splitLayer` divide um clipe em dois que se encostam exatamente: o primeiro
termina onde o segundo começa. Em vídeo, a segunda metade **avança o
`trimStart`** pelo tanto que a primeira mostrou — sem isso o corte repetiria o
trecho que acabou de passar, que é o erro clássico dessa operação.

Os efeitos são copiados, não compartilhados: as metades viram clipes
independentes, e editar os efeitos de uma não pode mexer na outra.

O corte é recusado quando alguma metade nasceria menor que `MIN_CLIP`. Um clipe
de três milissegundos você não consegue nem pegar pra apagar, então é melhor não
criá-lo. E age só no clipe **selecionado**, não em tudo sob o cursor: cortar
cinco faixas de uma vez porque você errou o alvo é bem pior de desfazer do que
cortar de novo.

## Arrastar clipes na timeline

Reordenar layers era feito por duas setas ▲▼ no painel lateral: um alvo pequeno,
num painel diferente do que mostra o resultado, uma posição por clique. Agora se
arrasta o clipe direto na timeline — no tempo (horizontal) e entre faixas
(vertical) **no mesmo gesto**.

**A timeline foi invertida junto.** Ela renderizava `project.layers` na ordem do
array, então a faixa de cima era a que fica *atrás* de todas no canvas — o
oposto do painel de layers, que sempre mostrou frente-a-fundo. Enquanto a ordem
só se mudava por botão isso passava despercebido; com arrasto vertical viraria
um defeito diário, porque puxar pra cima mandaria a layer pra trás. Hoje a faixa
de cima é a que aparece na frente, igual ao painel e ao CapCut.

A conversão entre as duas ordens é `flipOrder(i, n) = n - 1 - i`, que é a
própria inversa — uma função só serve pros dois sentidos, e não há como trocá-las
por engano.

As duas direções do arrasto têm regras opostas, e é isso que faz o gesto
funcionar:

- **No tempo**, contínuo: você posiciona onde quiser, limitado pelas pontas. O
  fim da linha limita o *começo* do clipe em `duração − duração do clipe`, senão
  a cauda sairia da timeline.
- **Entre faixas**, discreto: `Math.round(dy / altura da faixa)`. O clipe encaixa
  visivelmente numa faixa em vez de flutuar entre duas.

**Nada é aplicado durante o arrasto.** O clipe segue o ponteiro por `transform`
escrito direto no DOM e a faixa de destino acende — o gesto inteiro custa zero
re-render, e a lista é reordenada uma vez só, ao soltar. Reordenar a cada
`pointermove` faria as faixas saltarem debaixo do cursor, que é exatamente o que
torna esse tipo de arrasto impossível de mirar.

Dois detalhes que não são preciosismo:

- A altura da faixa é **medida do layout já aplicado**, não uma constante
  copiada do CSS. Mexer no CSS não desalinha o cálculo em silêncio.
- Posição e faixa são aplicadas numa edição só. Separar em duas colocaria dois
  passos no histórico pro mesmo gesto, e um estado intermediário impossível (o
  clipe na faixa nova, no instante velho) chegaria a existir.

A matemática toda vive em `engine/trackDrag.ts`, fora do componente e sem DOM,
porque errar ali reordena o projeto errado sem que nada acuse.

## Undo/redo: o problema é a granularidade

A pilha guarda **snapshots inteiros** do projeto, não diffs. Parece caro e não
é: as edições já eram imutáveis (`{ ...p, layers: ... }`), então uma layer que
não mudou continua sendo o *mesmo objeto* em todos os snapshots. O
compartilhamento estrutural vem de graça do jeito que o estado já era escrito, e
cada entrada custa um punhado de ponteiros. Diffs custariam a complexidade de
aplicar e desaplicar patch, que é onde esse tipo de código quebra.

A parte difícil não é a pilha, é **quanto vale um Ctrl+Z**. Arrastar uma alça de
trim dispara uma edição por `pointermove`; sem tratamento, desfazer o gesto
exigiria duzentos Ctrl+Z — o que na prática é o mesmo que não ter undo.

A regra: edições seguidas com a mesma chave (layer + campos tocados), dentro de
500ms, ocupam uma entrada só. A janela conta do **último** toque, pra que um
arrasto longo continue sendo um gesto. Ações discretas — adicionar layer,
excluir, reordenar — passam chave nula e valem por si; o painel de efeitos
desliga a fusão explicitamente, senão clicar em dois presets rápido viraria um
passo só.

Dois casos que a fusão nunca pode engolir, e que os testes fixam: o estado
inicial (deixaria a primeira edição impossível de desfazer) e uma entrada com
redo pendente (depois de desfazer, toda edição é ramo novo e descarta o futuro).

No `App`, toda edição passa por um funil único. O registro no histórico acontece
**fora** do updater do `setState`: o StrictMode chama o updater duas vezes pra
flagrar efeito colateral, e a pilha entraria duplicada.

## Persistência: o projeto tem que estar lá quando você voltar

O nó: uma layer de mídia carrega um `HTMLVideoElement` vivo, e elemento de DOM
não vira JSON. Pior, o `src` dele é um `blob:` — válido só enquanto a aba está
aberta. Salvar isso produziria um arquivo que *parece* certo e abre quebrado
amanhã, que é o pior resultado possível.

Então o projeto salvo guarda um `mediaId` por layer, e os bytes vão pro
IndexedDB. As alternativas eram piores: base64 no JSON incha 33% e trava a aba
ao serializar um vídeo grande; guardar o caminho do arquivo não existe no
browser, e reabrir exigiria você reapontar cada mídia toda vez.

Com os blobs no IndexedDB, recarregar a página devolve o projeto inteiro
funcionando, offline, sem pedir nada. O autosave espera 600ms depois que você
para de mexer — o atraso não é economia de disco, é correção: arrastar um clipe
produz uma edição por quadro, e gravar em cada uma enfileiraria centenas de
transações que terminam fora de ordem.

Três decisões que evitam corromper projeto:

- **Ler é defensivo.** A entrada pode ter sido editada à mão, truncada ou vir de
  outra versão. Cada campo tem padrão, `prop` de efeito desconhecida é
  descartada, e um `width: "muito"` não vira `NaN` circulando pela engine.
- **Formato do futuro é recusado com explicação**, em vez de abrir e perder
  metade das layers em silêncio.
- **Layer sem mídia é reportada**, nunca sumida calada — some uma layer sem
  aviso e a pessoa acha que o editor corrompeu o projeto.

A vida da mídia é o detalhe que amarra as duas features. Excluir uma layer
**não** apaga o arquivo, porque o undo pode trazê-la de volta; um elemento com
o `src` revogado voltaria preto. O que sobra é descartado ao **reabrir** (aí não
existe mais histórico que alcance a layer) e em ✧ NOVO. Sem essa limpeza, o
editor decodificaria vídeos que ninguém usa a cada abertura.

## Performance do preview

O sintoma: dar play travava, mesmo num projeto simples, principalmente em
notebook mais fraco. Duas causas reais, não uma só:

1. **O canvas sempre renderizava na resolução nativa do projeto** (ex.:
   1920×1080), mesmo exibido a 25% de zoom numa tela pequena. O `transform:
   scale()` do CSS só encolhe o que já foi desenhado — todo `drawImage`,
   `fillText` e filtro rodava em cima dos pixels físicos inteiros de qualquer
   jeito.
2. **`ctx.filter = blur(...)` é uma convolução de verdade**, e ela roda sobre
   a região inteira do canvas a cada frame. Qualquer layer com o preset
   `blur-in` ativo pagava esse custo 60x por segundo, na resolução cheia.

A correção, em `viewport.ts` + `renderer.ts` + `Stage.tsx`:

- **`renderScale(zoom, dpr)`** calcula quantos pixels físicos o canvas
  realmente precisa pra mostrar o que está visível na tela — não mais que
  isso. A 25% de zoom, isso é ~1/16 do trabalho por frame, sem perda percebida
  (você não vê detalhe que não está exibindo). Zoom acima de 100% ainda
  ganha nitidez, com teto em 2x pra não sair do controle.
- `drawFrame` passou a desenhar em coordenadas **lógicas** (`project.width/
  height`) e compensar com `ctx.scale()` — o canvas físico pode ser menor sem
  que nenhuma layer precise saber disso. Preview e export continuam usando a
  mesma função com o mesmo resultado proporcional.
- **Fast preview**: desfoque é ignorado durante reprodução ativa e volta assim
  que você pausa. O botão **⚡ FAST** força esse modo o tempo todo, e também
  desliga a preparação automática do play (veja abaixo).

A qualidade de reamostragem (`imageSmoothingQuality`) é sempre `high`. Chegou
a ser reduzida durante a reprodução, mas o ganho nunca foi medido e a
diferença atrapalhava o cache: um frame capturado com reamostragem pior teria
que ser marcado como degradado, inutilizando quase tudo que a reprodução
guarda. Simplicidade valeu mais que uma micro-otimização não comprovada.

### Barra de atividade

Nem toda espera dá pra eliminar: arrastar o cursor do tempo num H.264 obriga o
decoder a remontar o frame desde o keyframe anterior, e isso leva o tempo que
leva. O que dá pra evitar é a **sensação de travamento** — a tela parada sem
explicação, que parece bug.

`previewStatus.ts` mantém esse sinal, e duas decisões o tornam útil em vez de
irritante:

- **Atraso de 140ms antes de aparecer.** Um seek que resolve em 30ms piscando
  uma barra é pior que barra nenhuma — vira ruído e passa impressão de
  instabilidade. Operação rápida nunca chega a mostrar nada.
- **Notifica só nas transições.** A sonda roda 60x por segundo, mas o React só
  re-renderiza quando a barra realmente aparece ou some: 2 renders por
  episódio, não 120 por segundo.

A sonda roda no `player.onTick()` — um gancho que dispara a cada frame
*inclusive nos que são pulados* pela otimização de frame sujo. Foi preciso
adicioná-lo porque é justamente enquanto a tela está parada esperando que a
barra precisa decidir se aparece; pendurar isso no `onFrame` faria o
indicador nunca surgir.

## Cache automático: navegar é de graça

A regra que guia tudo: **navegar não é editar.** Clicar no começo, no meio ou
no fim de um trecho não muda nenhum pixel — muda só qual pixel você está
olhando. Então não há motivo pra recompor nada.

Isso vale dos dois lados:

- **A assinatura ignora a posição do cursor**, então navegar nunca joga o
  cache fora.
- **Todo frame desenhado é guardado**, mesmo fora do pré-render. Assistir um
  clipe já preenche o cache como efeito colateral — depois disso, clicar em
  qualquer ponto que você já viu é instantâneo, sem apertar botão nenhum.

A captura mantém **no máximo uma cópia em voo** (`createImageBitmap` é
assíncrono): sem esse limite, uma reprodução longa enfileiraria centenas de
cópias pendentes e a própria captura viraria o gargalo.

### Qualidade: o detalhe que evita o cache mentir

Durante a reprodução o desfoque é pulado. Guardar esses frames sem mais nem
menos faria você pausar e ver a versão simplificada — o cache mentindo sobre
o resultado.

A solução é o `drawFrame` **relatar** se chegou a pular alguma coisa
(`{ degraded }`), em vez de assumir "reproduziu, logo é ruim". Isso importa
porque a maioria dos frames não tem desfoque nenhum: neles o modo rápido não
muda nada, o frame sai idêntico ao de qualidade cheia e vale pra sempre. Só
os frames que de fato perderam algo ficam restritos à reprodução, e são
recompostos quando você para em cima deles.

Um frame de qualidade cheia nunca é rebaixado por uma captura de reprodução
que passe por cima dele — mas o contrário promove.

## Play liso: preparar antes em vez de engasgar durante

A regra: **esperar é aceitável, reproduzir tremendo não é.**

Ao dar play, se o trecho ainda não estiver inteiro no cache em qualidade
cheia, o editor prepara primeiro (com barra de progresso, cancelável) e só
então reproduz — a partir daí, direto do cache, sem decoder no caminho.

`⚡ FAST` é a saída pro oposto: reproduz na hora, aceitando qualidade menor.

### Tudo se alinha na taxa de quadros do projeto

O preview renderiza **sempre no instante da grade** (`project.fps`, 30 por
padrão), nunca no tempo bruto do `requestAnimationFrame`.

Isso não é detalhe de precisão — é o que evita a imagem "tremer". Um frame
vindo do cache foi gerado no tempo da grade; um recém-renderizado sairia no
tempo exato do rAF. Alternar entre os dois faz o tempo andar pra trás e pra
frente entre quadros consecutivos, e a imagem treme mesmo com todos os frames
individualmente corretos. Fixando a grade, cache e render viram a mesma coisa
e ficam intercambiáveis.

## Um único conjunto de `<video>`, dois interessados

O bug mais difícil desta fase: a reprodução pulava pra frente e voltava, **só
nas layers de vídeo** — texto rodava perfeito.

Existe um único elemento `<video>` por layer, e dois códigos querendo
posicioná-lo: o loop do preview (que o leva ao cursor) e o pré-render (que o
leva ao instante exato de cada quadro e espera o `seeked` antes de capturar).
Quando os dois mexem ao mesmo tempo, o pré-render grava quadros com o vídeo no
lugar errado — e a reprodução a partir desse cache sai tremendo.

O gatilho era indireto: vídeo em `seeking` acendia a barra de atividade, que
re-renderiza o componente do preview, que invalida o quadro, que traz o loop
de volta pra disputar o elemento.

A trava (`claimVideoElements` / `releaseVideoElements`) fica dentro do
`videoSync.ts`, **não em quem chama** — assim um chamador novo não
reintroduz o problema por esquecimento.

## Corrigir deriva por velocidade, nunca por seek

O mesmo sintoma ("volta um quadro e pula pra frente") tinha uma segunda causa,
independente da anterior, e essa aparecia mesmo sem pré-render nenhum.

Durante a reprodução ao vivo existem dois relógios: o do app (rAF) e o do
`<video>`, que roda sozinho no pipeline de mídia. Eles divergem. A correção
original era direta — passou de 80 ms de desvio, escreve `currentTime`.

O problema é que **um seek num `<video>` que está tocando não é instantâneo, e
o elemento não congela esperando**: ele continua avançando no próprio relógio
até o seek pousar. A sequência que ia pra tela era esta:

```
t=0.15  desvio passa de 80ms   ->  pede seek pra 0.15
        (o elemento segue livre; a tela desenha 0.20)
t=0.23  o seek pousa           ->  a tela desenha 0.15   <- VOLTOU
t=0.26  a reprodução retoma    ->  a tela desenha 0.25   <- pulou
```

E 80 ms a 30fps são só 2,4 quadros, dentro do jitter normal do decoder — então
a correção disparava o tempo todo. Pior: cada seek custa tempo de decoder, o
que aumenta o desvio, que dispara o próximo seek. Uma tempestade que se
alimenta sozinha.

A saída foi trocar o mecanismo: `videoSyncPlan` corrige por **`playbackRate`**,
que é contínuo e sem latência. O elemento anda um pouco mais rápido ou mais
devagar até encostar no relógio, e nenhum quadro sai de ordem. O seek continua
existindo, mas só em três situações em que ele é o mal menor:

- o elemento ainda está **pausado** e vai entrar agora — aí o seek é invisível,
  porque não há movimento na tela pra ele interromper;
- o desvio passou de **meio segundo**, que já não é deriva e sim um evento (o
  vídeo travou, o loop voltou ao início, você arrastou o cursor durante o play)
  — velocidade não alcança mais;
- fora isso, nunca. E enquanto um seek está em voo (`video.seeking`), nenhuma
  correção nova é empilhada, senão o decoder afunda.

A correção é limitada a ±12%: acima disso a aceleração fica visível, que é
trocar um defeito por outro.

Detalhe adjacente, do mesmo sintoma: `player.play()` guardava
`performance.now()` como origem do relógio, mas o tick lê o timestamp do rAF —
que é o instante em que o **quadro** começou, e eventos de input são
despachados dentro desse mesmo quadro. Dar play num clique podia render um
`dt` negativo, e o relógio andava pra trás logo no primeiro quadro. Hoje a
origem sai do primeiro tick, e `dt` é limitado nos dois lados.

## Pré-render (RAM preview)

O problema real não era demorar pra renderizar — era **pagar o custo de novo
toda vez** que o cursor passa pelo mesmo ponto. Cada posição nova obriga o
decoder a remontar o frame desde o keyframe anterior, e isso se repete
indefinidamente enquanto você navega.

`frameCache.ts` guarda frames já compostos; `prerender.ts` preenche um trecho
de uma vez. Depois disso, reproduzir vira só copiar bitmap pra tela — sem
decoder no caminho, em qualidade cheia (com desfoque e tudo, porque é
justamente o resultado final que você quer avaliar fluido).

Como usar: marque `[ IN` e `OUT ]` na posição do cursor, clique
**⚙ PRÉ-RENDER**, acompanhe a barra. O trecho marcado aparece destacado na
régua.

### A parte difícil é a invalidação, não o cache

Um cache que devolve frame velho depois de você editar algo é **pior** que não
ter cache: você para de confiar no que vê. Por isso tudo gira em torno de
`renderSignature()`, que reduz o projeto exatamente ao que desenha pixels.

O que **não** entra na assinatura, de propósito:

- a posição do cursor (é justamente o que queremos poder variar de graça)
- pan e zoom (mudam *onde* a imagem aparece, não o que ela é)
- seleção de layer, aba aberta, qualquer estado de interface
- a escala de render — frames guardados são reescalados na hora de exibir,
  então dar zoom não joga o pré-render fora, só deixa ele mais macio

A assinatura percorre as layers campo a campo em vez de serializar o objeto
inteiro. É mais verboso, mas evita que adicionar um campo de UI ao modelo
passe a invalidar o cache sem motivo — o preço é lembrar de incluir ali todo
campo novo que afete a imagem.

### Memória

Frame composto é caro: a 1920×1080 são ~8 MB **cada**. O teto é 320 MB, e
`estimateRange()` calcula o custo antes de começar — se o trecho não couber, a
barra avisa e sugere uma duração viável. Sem esse aviso o pré-render
"terminaria com sucesso" e mesmo assim engasgaria, porque o começo teria sido
descartado pra dar lugar ao fim.

## Status

**Pronto:** layers de texto, imagem e vídeo com trim, timeline com arrasto,
reordenação de layers, runtime de efeitos, 9 presets, viewport com zoom/fit/pan
e resolução de render adaptativa, resolução de projeto, marcação de trecho
(in/out), pré-render com cache de frames, export de frame PNG, **arrastar
layers nas faixas da timeline** (mover no tempo e reordenar num gesto só),
**undo/redo**, **autosave** (o projeto reabre sozinho, com a mídia),
**faixas com vários clipes**, **corte no cursor** (Ctrl+B), **navegação quadro a
quadro** (setas) e **export de vídeo MP4** via WebCodecs. Base inteira em
TypeScript `strict`, com 218 testes.

**Próximo:** áudio (uma trilha na v1 — é o que falta pro arquivo exportado
ficar completo) → efeitos CSS personalizáveis (abrir o vocabulário de filtros) →
gizmo de transform e crop → chroma key (shader WebGL).

**No radar:** snap magnético entre clipes ao arrastar, e o arrasto empurrar o
vizinho em vez de recusar — os dois deixam o gesto mais parecido com o CapCut,
mas nenhum é pré-requisito de nada.

**No radar, ainda sem data:** atalhos de edição estilo CapCut (cortar no
playhead, deletar, duplicar), responsividade mobile/touch — esse último é o
maior dos três, mexe no layout inteiro, não só numa interação pontual.
