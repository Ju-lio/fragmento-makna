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
    timelineView.ts    zoom e rolagem da timeline
    gizmo.ts           posicionar, escalar e girar no palco
    videoSync.ts       alinha os <video> ao relógio
    mediaOwner.ts      quem conduz cada elemento quando vários clipes o dividem
    frameCache.ts      cache de frames compostos + assinatura
    frameSource.ts     de onde tirar cada quadro (cache ou ao vivo)
    prerender.ts       preenche um trecho quadro a quadro
    videoExport.ts     compõe o trecho e codifica (WebCodecs)
    exportPlan.ts      as decisões do export que não dependem do browser
    progress.ts        observável de progresso (pré-render, export)
    audioMix.ts        o que toca, quando, e de onde do arquivo
    audioSync.ts       trilhas alinhadas ao relógio do player
    audioRender.ts     mixagem offline pro export
    waveform.ts        envelope de picos e recorte pra desenho (puro)
    waveformStore.ts   decodifica uma vez por arquivo e guarda o envelope
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

## Acervo de mídia

A aba lateral listava as layers — as mesmas da timeline, na mesma ordem, com
menos informação do que o desenho dos clipes já dá. Virou o **acervo**: os
arquivos importados no projeto, usados ou não.

A diferença não é de tela, é de modelo. Antes a mídia existia só enquanto
alguma layer a referenciasse: apagar o clipe apagava o arquivo, e reimportar o
mesmo vídeo guardava uma segunda cópia dos mesmos bytes. Agora o arquivo
pertence ao projeto (`project.media`) e as layers apenas o referenciam — que é o
que permite usar o mesmo material em vários pontos da linha do tempo de graça.

Consequência direta: `mediaIdsOf` passou a olhar o acervo, não as layers. Um
arquivo importado e ainda não usado continua sendo do projeto, e varrer só as
layers o apagaria na próxima abertura.

Arquivos entram arrastando pra qualquer lugar do editor. O `preventDefault` no
`dragover` não é detalhe: sem ele o navegador **abre** o arquivo, troca o editor
pelo vídeo, e leva junto o que ainda não tinha sido salvo.

## Áudio

Antes disso o editor descartava som em silêncio: `attachVideoElement` forçava
`muted = true`, então **nem a trilha do próprio vídeo existia** — você importava
uma entrevista e exportava um arquivo mudo sem nada avisar.

Vídeo e áudio compartilham a interface `Audible` (volume, mudo). Tratar a
trilha de um clipe de vídeo como "áudio de segunda classe" duplicaria volume,
mudo e mixagem em dois caminhos que divergiriam.

**Som não entra na assinatura do cache.** `renderSignature` percorre a ordem de
desenho, que já exclui layers de áudio — então ajustar o volume da música, ou
adicionar uma trilha inteira, não joga o trecho pré-renderizado fora. Um cache
de quadros que se invalida ao você mexer no volume seria absurdo, e é exatamente
o que aconteceria se a assinatura varresse `project.layers` cru.

### Vídeo e áudio têm espaços de faixa separados

Era um espaço só, e o modelo ficava ambíguo: a faixa 2 podia ter um clipe de
vídeo **e** um de áudio, sem nada os distinguindo. Funcionava porque a ordem de
desenho já ignora áudio, mas a numeração não queria dizer a mesma coisa nos dois
casos — no vídeo é profundidade, no áudio não é nada — e a timeline não tinha
como agrupar o som embaixo.

Com dois espaços, "faixa 0" significa uma coisa só dentro de cada tipo, e as
duas perguntas que o editor faz o tempo todo (quem colide comigo, qual é a de
cima) ficam bem definidas. `compactTracks` renumera cada tipo por conta própria,
`freeWindow` e `pasteSlot` só enxergam o próprio espaço.

**O arrasto não precisou mudar** — e isso é consequência de uma escolha, não
sorte. Como cada gesto acontece dentro do espaço de faixa do próprio tipo,
atravessar pro outro grupo simplesmente não é representável: os dois grupos são
contíguos na tela, então converter faixa em linha virou um deslocamento.

Duas coisas quase passaram batido, as duas encontradas rodando:

- **A direção é oposta nos dois grupos.** No vídeo as linhas são invertidas
  (faixa 0 desenha no fundo, aparece embaixo), no áudio são naturais. Isso era
  uma constante dentro do `clipDragPlan` e virou parâmetro. O sintoma era
  silencioso: arrastar áudio pra baixo pedia a faixa -2, o `clamp` prendia em 0,
  e o clipe não saía do lugar sem nada indicar por quê.
- **O traço que separa os grupos não pode ter margem.** O cálculo do arrasto
  mede o espaçamento entre as duas primeiras linhas e assume que vale pra todas
  — uma margem só na fronteira tornaria isso mentira. O traço vive dentro do vão
  de 4px que já existia. (Medido depois: 28px entre todas as linhas.)

A migração de projetos salvos é a própria compactação: no formato 5 uma faixa de
áudio podia ser a 3 só porque existiam três de vídeo, e renumerar cada tipo
traduz isso sem mover clipe nenhum no tempo.

### A onda, e por que o clipe de áudio não é só outra cor

Cortar no ritmo é impossível olhando um retângulo colorido: o que se procura é a
batida, o silêncio entre as frases, o ponto onde a voz entra. Isso está no
envelope do sinal.

O clipe de áudio ganhou tratamento próprio, não outro matiz. O clipe visual é um
bloco chanfrado com relevo pra fora; o de áudio é o oposto — um **visor
afundado**, fundo mais escuro que a faixa, moldura clara, com a onda desenhada
dentro. Dá pra reconhecer o tipo pela silhueta, de canto de olho, sem ler o nome
nem comparar cor com o vizinho. (Primeira tentativa igualou o fundo do clipe ao
da faixa: a borda sumia e o clipe ficava sem limite visível.)

**Duas etapas, porque têm custos opostos.** `computePeaks` varre os samples uma
vez por arquivo e guarda um envelope de resolução fixa (120 baldes por segundo);
`barsFor` recorta a janela do clipe e reamostra pro número de barras que cabem
na largura atual. Guardar o envelope em vez do PCM é o que torna isso viável na
memória — 400x menor, e a diferença não aparece em 24 pixels de altura.

Vale **e** pico por balde, nunca a média: a média tende a zero em qualquer sinal
simétrico e desenharia uma linha reta pra música e pra silêncio igualmente. E a
reamostragem é pelo extremo, não "um balde a cada N" — senão a onda cintilaria a
cada passo de zoom, porque a barra desenhada passaria a ser um balde diferente e
arbitrário. Medido: ampliar de 735 para 2994 pixels de largura deixou o perfil
idêntico.

### A onda é normalizada, e isso foi uma decisão

Desenhar em valor absoluto parece o certo e falha justo onde importa. O primeiro
teste no navegador saiu com o perfil `[2,1,2,1,2]` — praticamente uma linha
reta — porque o arquivo tinha pico em -18 dB, que em 16 pixels de altura dá
menos de um pixel. E -18 dB é o normal de fala e de material não masterizado.

Então a onda é dividida pelo pico **do arquivo**, com piso em -26 dB pra um
arquivo quase mudo não ser amplificado até virar ruído desenhado como conteúdo.
Silêncio interno continua silêncio (a divisão é pelo arquivo, não por trecho),
então o que se ganha é contraste, não uma mentira. O mesmo arquivo passou a
`[12,1,12,1,12]`.

O envelope não é persistido em IndexedDB de propósito: recalcular na abertura
custa alguns décimos por arquivo e não bloqueia nada, enquanto um cache em disco
precisaria de invalidação própria. É otimização, e otimização depois.

### Separar o áudio do vídeo

Um clipe de vídeo carrega o próprio som. Separar põe esse som numa faixa
própria e **cala** o vídeo — cala, não remove: é o que permite desfazer voltando
o `mute`, e o que mantém o `mediaId` de pé nos dois lados, então o export
continua decodificando o arquivo uma vez e servindo os dois clipes.

A parte que exigiu mexer na fundação: a faixa destacada precisa de um `<audio>`
**próprio**. Dividir o `<video>` com a imagem seria pedir pro editor calar uma
das duas — exatamente o que separar veio desfazer. Os dois elementos leem a
mesma `blob:`, então não há byte a mais nem download extra.

Isso obrigou a mudar a chave da eleição de dono, de arquivo pra **elemento**
(`ownersByElement`): as duas layers têm o mesmo `mediaId` e elementos
diferentes, e agrupar por arquivo faria uma silenciar a outra — o bug do clipe
cortado chegando pelo lado oposto. A pergunta certa nunca foi "qual arquivo é
este", e sim "quem está mexendo neste cursor".

O `MediaResolver` também passou a receber o tipo da layer junto com o id, senão
reabrir o projeto devolveria o `<video>` pra uma layer de áudio e a disputa
voltaria pela porta dos fundos.

Verificado exportando: fonte a -21,1 dB de média, arquivo exportado a -21,1 dB —
o som sai uma vez só, sem o vídeo mudo somar de novo por cima.

### Um elemento por arquivo, não por clipe

O sintoma: depois de cortar uma música com Ctrl+B, a **primeira** metade tocava
muda. Cortar de novo, e a penúltima metade também. Nada na timeline parecia
errado.

A causa está no `splitLayer`: ele copia a layer com spread, e `audio` é uma
referência a um elemento do DOM — as duas metades ficam apontando pro **mesmo**
`<audio>`. O acervo faz o mesmo ao reaproveitar um arquivo, e a restauração de
um projeto salvo também (um elemento por `mediaId`, não por layer). O
`syncSoundLayers` então percorria as duas e deixava as duas escreverem no
elemento: a metade ativa mandava `play()`, a inativa mandava `pause()`, e a que
vinha depois no array ganhava. Como a segunda metade é sempre a de trás, ela
calava a primeira durante todo o trecho dela.

A correção (`ownersByMedia`) elege **uma layer por arquivo** a cada instante,
antes de qualquer escrita: quem está em uso ganha; entre dois em uso, o último
da lista, que é o que está por cima. Sem ninguém em uso sobra o primeiro, cujo
plano é justamente parar o elemento — senão ele rolaria pra sempre depois do
último clipe.

A mesma disputa existia na **imagem**, com sintoma diferente: o clipe congelava
logo depois de um corte, porque a metade inativa pausava o `<video>` que a ativa
tinha soltado. E no pré-render, dois clipes sobrepostos do mesmo arquivo mandavam
o elemento pra dois instantes e esperavam os dois seeks — resolvia com o quadro
de um dos dois, sem dizer qual. Por isso o eleitor é genérico e vive em
`mediaOwner.ts`: só o critério de "em uso" muda entre `soundOwners` (estar
soando) e `videoOwners` (estar no ar). Três cópias divergiriam, e o modo de
divergir é ficar mudo ou piscando.

Fica um limite honesto: dois clipes do mesmo arquivo **sobrepostos** tocam só
um. Um elemento tem um cursor só; não é escolha, é o que ele é. É exatamente
por isso que o export não usa elementos, e sim um `OfflineAudioContext` com uma
fonte própria por clipe.

### Deriva: por velocidade, como no vídeo

Aqui a explicação anterior estava errada, e o erro custou os estalos.

O argumento era: o vídeo corrige por `playbackRate`, mas em áudio isso mudaria o
**tom**, e meio semitom de desafinação é mais audível que um quadro repetido é
visível. Logo, som corrigiria por seek, com tolerância folgada de 150ms.

A premissa não vale há anos: `preservesPitch` é o padrão dos navegadores, então
`playbackRate` muda o **andamento** sem mexer no tom. E os dois lados da conta
estavam ruins:

- Um seek num elemento que está tocando é um corte no som **toda vez**. Pior, a
  correção nascia atrasada da própria latência do seek — o que a fazia se
  repetir. Eram os estalos.
- 150ms de som atrasado passa longe do limiar em que se percebe o desencontro
  com a imagem: ~45ms (ITU-R BT.1359). A tolerância folgada não era prudência,
  era o desencontro sendo tolerado por construção — inclusive o atraso de
  partida do `play()`, que é justo dessa ordem e nunca chegava a ser corrigido.

Hoje o som corrige como o vídeo: `playbackRate` com teto de ±4% (inaudível com o
tom preservado), acima de 45ms de deriva. `preservesPitch = true` fica explícito
nos dois lados — é o que separa "4% mais rápido" de "dois semitons acima", e um
padrão que se assume calado é um padrão que muda sem ninguém perceber.

Seek continua existindo, mas só acima de 400ms, onde não é mais deriva e sim
evento: o loop voltou ao início, você arrastou o cursor durante a reprodução, o
decoder engasgou. Aí o corte no som é o mal menor.

Uma armadilha que só apareceu testando: tocando **do cache**, `handlePlay`
pausava os `<video>` — eles não pintavam nada, então deixá-los rodando só
gastaria decoder. Isso valia enquanto o editor não tinha som. Depois, era o que
fazia o pré-render reproduzir mudo: o elemento deixa de ser fonte da imagem e
continua sendo fonte do **som**, e nesse estado ninguém cuidava dele. Hoje o
`syncSoundLayers` o conduz, e pausa sozinho o que estiver em silêncio.

Duas outras diferenças que caem da mesma lógica:

- **Não existe scrub sonoro.** Arrastar o cursor tocando pedacinhos de áudio é
  ruído, não informação. Som só existe durante a reprodução.
- **A ponta final do clipe é exclusiva.** O quadro final de um clipe visual
  ainda aparece; som tocando um instante além do fim se ouve como estalo.

O som anda no `onTick`, não no `onFrame`. `onFrame` é pulado quando nada mudou
na tela — que é exatamente o momento em que a música precisa continuar tocando.

### No export

`OfflineAudioContext` mixa tudo antes do primeiro quadro de vídeo. É a
ferramenta certa: renderiza mais rápido que tempo real e resolve sozinho a soma
das fontes, o ganho e o alinhamento. Somar `Float32Array` na mão daria o mesmo
com muito mais chance de errar um sample.

Antes do vídeo, não em paralelo: a mixagem decodifica os arquivos inteiros, e
fazer isso enquanto o `<video>` está sendo levado quadro a quadro põe os dois
disputando o mesmo decoder — que é a situação em que os seeks começam a falhar
por timeout.

O recorte é onde se erra: uma música que começa antes do trecho exportado entra
**pelo meio**. Sem isso, exportar de 10s a 20s reiniciaria a música em 10s e o
arquivo soaria diferente do preview.

O PCM sai em `f32-planar` (canais em sequência, não intercalados). Trocar os
dois formatos produz um arquivo que toca, com os canais embaralhados — o tipo de
erro que só se percebe ouvindo.

**O som cobre a grade de quadros, não `from..to`.** O vídeo não começa em
`from`: começa no quadro da grade mais próximo, e o último quadro dura mais
1/fps depois de `to`. Mixar no intervalo cru punha as duas trilhas em origens
diferentes — até meio quadro de desencontro sempre que o IN foi marcado no
cursor, que quase nunca cai na grade porque `player.t` vem do rAF — e deixava o
último quadro sem som.

**A barra de progresso nasce antes da mixagem.** `exportStatus.begin()` e
`activeToken` ficavam depois dela, e a mixagem é justamente a fase que decodifica
os arquivos inteiros: pelo trecho mais demorado do export a aba ficava parada,
sem barra e com o PARAR inerte. Quem exportava uma música de três minutos passava
esse tempo sem saber se tinha travado. O laço de áudio também ganhou o mesmo
freio de fila do laço de vídeo — sem ele, três minutos viravam ~2100 blocos de
PCM empilhados de uma vez, síncronos, sem nada devolver a vez ao navegador.

**Faixa que não decodifica agora avisa.** O `failed` do `renderAudio` era
calculado e descartado: uma trilha que este navegador não abre sumia do arquivo
em silêncio, e você descobria assistindo o resultado.

### AAC não existe em toda build — e falhar nele não parece falhar nele

O sintoma era `AudioEncoder.encode: Encoder must be configured first`, depois de
a mixagem inteira já ter rodado. A mensagem não menciona codec nenhum, e o
`configure()` logo acima não tinha lançado nada.

A causa: **AAC é proprietário e o encoder não vem em toda build de Chromium** —
no Linux, com frequência não vem. Medido neste navegador:
`AudioEncoder.isConfigSupported('mp4a.40.2')` → `false`, `'opus'` → `true`. E
`configure()` de um codec ausente **não lança**: ele derruba o encoder em
silêncio pelo callback de erro, e quem reclama é o `encode()` seguinte — com uma
mensagem sobre configuração, não sobre suporte.

A correção é a que o vídeo já usava: uma lista de candidatos e uma pergunta
antes (`isConfigSupported`), não um `configure()` na esperança.
`AUDIO_CODEC_CANDIDATES` tenta AAC e cai pra **Opus**, que é livre, está em todo
lugar e o MP4 aceita. O codec escolhido é decidido **antes do muxer**, porque é
ele que nomeia a trilha na construção — declarar uma trilha e não ter encoder
pra preenchê-la deixa o arquivo com uma faixa vazia.

Sem nenhum dos dois, o export segue sem som e diz isso (`audioSkipped`), em vez
de morrer levando o vídeo junto. E o rótulo do resultado leva os dois codecs
("H.264 High + Opus"): o arquivo continua abrindo em todo lugar, mas é bom você
saber que caiu pra reserva.

## Zoom e rolagem na timeline

A régua espremia o projeto inteiro na largura da janela, sempre. Num projeto de
60s um clipe de 2s virava **93 pixels** — largo demais pra mirar a alça de trim,
estreito demais pra ler o nome. Era a parede entre o editor e "montar um Reels
de 60s".

O que fez isso ficar barato foi o modelo de coordenadas. A alternativa óbvia —
reposicionar cada clipe em pixels quando o zoom muda — obrigaria a recalcular a
timeline inteira a cada passo. Em vez disso a timeline ganhou um elemento de
conteúdo de `duration × pxPerSecond` pixels, e **clipes, marcas e cursor
continuam posicionados em porcentagem dele**, exatamente como antes. Dar zoom é
mudar uma largura; a porcentagem de cada clipe nunca muda. É o mesmo truque do
palco, onde o zoom é uma `transform` só.

O efeito colateral bom: nenhuma das contas de scrub, trim ou arrasto precisou
mudar. Todas mediam o elemento de verdade com `getBoundingClientRect`, que agora
cresce junto — arrastar 300px a 136 px/s move exatamente 2,21s.

A rolagem é a nativa do navegador (`overflow-x`), não uma reimplementação:
`scrollLeft` é escrita direta no DOM, então rolar custa **zero re-render**. O
zoom, esse sim, re-renderiza — mas é ação discreta (um clique, um passo de roda),
e é ele que redistribui as marcas da régua.

Três detalhes que só apareceram rodando o app de verdade:

- **A roda vertical não rolava nada.** O navegador só rola um contêiner
  horizontal sozinho com `deltaX` — trackpad de dois dedos ou Shift+roda. Um
  mouse comum ficava sem saída, então a roda passou a ser tratada aqui.
- **A barra de rolagem é de sobreposição** e some quando você não está rolando —
  some justamente no estado em que ela seria a única coisa dizendo "tem mais
  projeto pra esse lado". Nem `scrollbar-color` nem `::-webkit-scrollbar`
  reservam espaço no Chromium testado. A afordância virou o rótulo do trecho
  visível (`18.6–27.7s`), que de quebra diz *onde* você está — coisa que a barra
  nunca disse.
- **O rótulo da última marca vazava** pra fora do conteúdo e criava ~28px de
  rolagem fantasma: a timeline "cabendo inteira" e mesmo assim rolando um
  pouco. Perto do fim o rótulo agora vira pra dentro.

O passo das marcas sai do **zoom**, não da duração — é quanto espaço um rótulo
tem na tela que decide se ele cabe. Sai de uma escada fixa (`0.1, 0.25, 0.5, 1,
2, 5, 10, 15, 30, 60, 120, 300`): passos de 0,3s ou 7s são tão legíveis quanto
um relógio quebrado.

Durante a reprodução a vista segue o cursor **por página**, não continuamente:
seguir pixel a pixel deixa a timeline inteira deslizando debaixo do olho, e aí
não dá pra ler nem mirar nada enquanto toca. Quando o cursor sai, ele reaparece
na outra ponta com uma página inteira pela frente. Só tocando — enquanto você
arrasta o cursor, quem manda na vista é você.

| Ação | Atalho |
|---|---|
| Zoom no cursor | `Ctrl` + roda sobre a timeline |
| Zoom in / out | botões `−` / `+` |
| Mostrar o projeto inteiro | botão `TUDO` |
| Rolar | roda, ou arrastar a barra |

## Copiar, recortar, colar

A área de transferência é **própria**, não a do sistema. Uma layer não é texto:
ela carrega efeitos e uma referência ao elemento de mídia. Passar pelo clipboard
do sistema significaria serializar e reanexar a mídia na volta, e colar num
projeto que não tem aquele arquivo daria uma layer quebrada.

Colar cai no **cursor**, não onde o original estava — colar é um jeito de dizer
"quero isto aqui". A parte que precisa de regra é a faixa: ela não aceita
sobreposição, então o lugar pedido pode simplesmente não caber. `pasteSlot`
procura de baixo pra cima a partir da faixa de origem (pra que colar perto
mantenha a camada) e abre uma faixa nova no topo se nenhuma servir. Recusar
seria a pior resposta possível — a pessoa acabou de mandar colar.

Os efeitos são clonados **na cópia e na colagem**: colar duas vezes não pode
produzir duas layers que dividem a mesma lista de efeitos.

| Ação | Atalho |
|---|---|
| Copiar / recortar / colar | `Ctrl` `C` / `X` / `V` |
| Duplicar | `Ctrl` `D` |
| Cortar no cursor | `Ctrl` `B` |
| Apagar | `Delete` |

## Gizmo no palco

Ninguém posiciona um título digitando coordenada. Arrastar move, as quinas
escalam, a alça de cima gira (com `Shift` prendendo de 15 em 15).

**A decisão que dispensou toda conta de zoom:** o gizmo mora *dentro* da
`.stage-holder`, junto do canvas. O holder já carrega a `transform` do viewport,
então basta escrever tudo em pixels **lógicos da composição** — os mesmos do
`drawFrame` — e o navegador põe no lugar. A única coisa que precisa desfazer o
zoom são as alças em si, porque uma alça de 11px viraria 2px a 25%, e isso é uma
variável CSS (`--unzoom`).

A matemática toda vive em `gizmo.ts`, pura e testável sem DOM: a caixa da layer,
a conversão pro referencial dela, o acerto, o fator de escala e o delta de
rotação. Três detalhes que valem registro:

- **A caixa tem que sair da mesma conta do desenho.** `layerBox` repete a
  entrelinha do `drawText` e o `Math.min` do `drawSource` de propósito — duas
  contas em lugares diferentes é exatamente o que faria a moldura não coincidir
  com o que está na tela.
- **Escalar mede distância ao centro, não projeção num eixo.** Numa layer
  girada, "pra fora" não é nem horizontal nem vertical. E é uniforme porque o
  modelo tem um tamanho só (`size` no texto, `fit` na mídia): inventar largura e
  altura separadas aqui criaria um estado que o renderer não sabe desenhar.
- **Girar precisou de um campo novo.** `rotate` só existia como prop de efeito;
  o gizmo não teria onde escrever. Virou campo de base da layer, somado ao dos
  efeitos — `rotate` é aditiva, então "deitado 15°" mais "balança ±3°" dá o que
  se espera.

### O bug que só apareceu rodando

Mover o título pra direita e depois tentar escalá-lo não fazia nada. A alça
existia, respondia a `elementFromPoint`, e o handler até calculava o fator
certo — mas com a layer deslocada a quina caía em x=1107 numa janela de palco
que termina em 1075, e o `overflow: hidden` do viewport a recortava.

A causa real era o fit: ele deixava 24px fixos de folga, então o canvas
praticamente encostava nas bordas e **qualquer** conteúdo posicionado meio pra
fora da composição ficava inalcançável. A margem virou fração do contêiner
(`FIT_MARGIN`), o que dá área clicável em volta do canvas — e o que sobrar disso
se alcança com zoom, que já tem atalho.

## Legibilidade do texto: contorno e sombra

Título claro sobre imagem clara simplesmente some, e é o caso mais comum de
todos — legenda por cima de footage. Duas saídas clássicas, que servem a
situações diferentes: o contorno segura sobre fundo agitado, a sombra é mais
discreta sobre fundo liso.

Ficam **fora do vocabulário de efeitos** de propósito: `prop` é fechado e mapeia
pra CSS/canvas, e isto é aparência fixa da layer, não algo que anima. Nascem
zerados — texto que já se lê não precisa deles, e ligá-los por padrão mudaria a
cara de todo projeto existente. O botão `LEGÍVEL` vem antes dos números porque a
resposta certa é quase sempre a mesma (contorno escuro grosso, proporcional ao
corpo), e ninguém quer descobrir isso ajustando dois campos.

O desenho é em três passadas, e a ordem é o que faz o resultado ficar legível:
a **sombra** primeiro, projetada sobre a silhueta mais externa (o contorno, se
houver) pra que ela siga a forma final em vez de escapar por baixo; depois o
**contorno**, sem sombra — senão cada passada projetaria a sua e as duas
engrossariam num borrão; por fim o **preenchimento**. O contorno vai com
`lineWidth` dobrado, porque `strokeText` centra o traço na borda do glifo e
metade cai dentro da letra, e com `lineJoin: 'round'`, senão os vértices agudos
de uma fonte pesada disparam farpas mais longas que a espessura pedida.

### A armadilha: sombra de canvas não é afetada pela transformação

`lineWidth` está em coordenadas do usuário, então o contorno acompanha o zoom
sozinho. `shadowBlur` e `shadowOffsetY`, **não** — estão em pixels de tela, e o
preview desenha numa fração da resolução do export (ver "resolução física ≠
exibida"). A mesma sombra sairia várias vezes maior no preview do que no
arquivo, quebrando a promessa "Preview = Export" no lugar mais difícil de
notar: você ajusta a sombra vendo uma coisa e entrega outra.

Por isso `drawText` recebe um `shadowScale` — a escala do canvas vezes a da
própria layer — e multiplica os dois valores. Medido no navegador, comparando a
mesma composição em canvas de 934×526 e de 330×186 (2,8× de diferença), pela
fração da tela que a sombra ocupa:

| | desvio entre as duas resoluções |
|---|---|
| sem escalar (controle) | **64,2%** — e a sombra cresce quando a resolução cai, como previsto |
| escalando | **10,9%** — resíduo de limiar num gradiente suave |

## Duração: derivada, não digitada

Era um campo que você preenchia, com dois defeitos que se somavam. Clipe que
passasse do número ficava **fora do export sem nada avisar** — você montava 12s,
o campo dizia 8, o arquivo saía cortado. E o número não era serializado, então
reabrir um projeto de 60s o devolvia com 8 e encolhia a régua inteira.

Agora `projectDuration` devolve onde termina o último clipe, e um efeito só no
`App` mantém o relógio em dia. Um efeito, e não uma chamada em cada lugar que
mexe em layer: edição, undo, importação, arrasto e restauração do disco passam
todos por ele, e o que esquecesse produziria de volta exatamente o bug.

**A parte não óbvia: derivar sozinho trava o projeto.** O arrasto prende o clipe
dentro da duração, e a duração passou a vir dos clipes — circular, e o projeto
nunca mais poderia crescer. (Foi o que o primeiro teste no navegador mostrou:
arrastar o último clipe pra frente não mexia em nada.)

A saída foi separar duas medidas que estavam conflatadas:

- **duração** = o conteúdo. Quem **executa** usa esta: export, loop, limite do
  scrub.
- **régua** = conteúdo + uma pista de sobra. Quem **desenha** usa esta: clipes,
  marcas, cursor, zoom.

A pista é proporcional (15%, entre 1s e 5s). Fixa em 5s ela sufocava projeto
curto — num de 8s seriam 38% da régua em vazio — e sumia em projeto longo.

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

### Inserir uma faixa, não só trocar de faixa

Cada linha tem **três zonas**: o miolo pousa o clipe naquela faixa, e as bordas
abrem uma faixa nova ali, empurrando as de cima. Sem isso a faixa 0 era o piso —
não existia gesto que mandasse um clipe pra baixo de outro, nem que abrisse
espaço no meio da pilha.

O indicador mostra a diferença: barra fina sólida na fronteira para inserir,
caixa tracejada para pousar. São ações diferentes e precisam parecer diferentes.

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

Desde que o editor tem som, esse mesmo `playbackRate` carrega a **fala** do
clipe junto. Por isso `preservesPitch = true` é explícito no
`attachVideoElement`: sem ele, 12% de velocidade seriam ~2 semitons de
desafinação. O caminho do áudio usa o mesmo mecanismo, com teto bem mais
apertado — ver "Deriva: por velocidade, como no vídeo".

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
quadro** (setas), **áudio** (importar, volume, mudo, mixado no export),
**export de vídeo MP4** via WebCodecs, **acervo de mídia** com importar
arrastando, **zoom e rolagem na timeline**, **duração derivada do conteúdo**, **contorno e sombra no texto**, **gizmo no canvas** (posicionar, escalar, girar), **separar o áudio do vídeo**, **forma de onda nos clipes de áudio**, **faixas de áudio separadas das de vídeo**, e atalhos de Delete/duplicar/copiar/colar. Base inteira em TypeScript `strict`,
com 370 testes.

### O caminho até "usável"

O critério: **montar um vídeo de 60s pra Reels — cortes, música, títulos — e
exportar, sem bater numa parede.**

**Falta pra chegar lá:** nada — o critério foi cumprido. O que vem abaixo é o
que separa de um clone, não pré-requisito.


**Depois disso, o que separa de um clone:** transições, velocidade do clipe,
snap magnético, presets de texto, pool de mídia, presets de export.

**O diferencial:** abrir o vocabulário de efeitos CSS — `contrast`, `saturate`,
`hue-rotate`, `drop-shadow`, `sepia`, `invert`. O `ctx.filter` já aceita a
sintaxe de CSS filter e o renderer já a usa, então é o item mais barato da lista
e o único que ninguém mais tem.

**No radar:** snap magnético entre clipes ao arrastar, e o arrasto empurrar o
vizinho em vez de recusar — os dois deixam o gesto mais parecido com o CapCut,
mas nenhum é pré-requisito de nada.

**No radar, ainda sem data:** atalhos de edição estilo CapCut (cortar no
playhead, deletar, duplicar), responsividade mobile/touch — esse último é o
maior dos três, mexe no layout inteiro, não só numa interação pontual.
