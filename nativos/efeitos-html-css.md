# Efeitos em HTML e CSS

**Estado:** funcionando de ponta a ponta para o tipo **efeito**. Filtro,
transição e texto ainda não têm tratamento próprio no editor — ver
[PRIORIDADES.md](../PRIORIDADES.md).

## O que resolve

Qualquer pessoa que saiba CSS escreve um efeito e usa no editor. Sem aprender
API nenhuma, sem plugin compilado, sem pedir pra gente.

## Como se usa

**No editor:** `+ EFEITO` na barra de cima põe um efeito na linha do tempo. Ele
ocupa faixa e tempo como qualquer clipe — dá pra arrastar, cortar, esticar,
apagar e desfazer.

Com a layer selecionada, a aba **PROPS** mostra os controles **que vieram junto
com o efeito**. Nenhum campo ali foi escrito por nós: o painel percorre o
`schema` do próprio efeito.

**No `/criar`:** escreve o CSS, vê o quadro, ajusta, e clica em **USAR NO
EDITOR**. De volta no editor, `+ EFEITO` traz o que você acabou de fazer.

Sem nada na bandeja, `+ EFEITO` adiciona o **raio** de exemplo — um botão que
adiciona uma layer vazia não ensina nada, e a primeira coisa que a pessoa quer
é ver alguma coisa acontecer.

## Por que é nativo e não efeito

É a máquina que faz efeito de terceiro funcionar. A moldura, não o quadro.

## Decisões de desenho

**O tipo se chama `overlay` no modelo, `efeito` pro autor.** O modelo descreve
o que a coisa é no caminho de render — uma camada rasterizada por cima; o autor
escreve `meta.tipo: "efeito"`. São vocabulários diferentes servindo leitores
diferentes, e forçar um só deixaria um dos dois pior.

**HTML, CSS e schema vão JUNTO no `.frag`,** não por referência a um efeito
instalado. É o acervo de mídia levado até o fim: abrir um projeto na máquina de
outra pessoa não pode depender de ela ter o mesmo efeito. Custa alguns kB por
layer; paga o projeto continuar abrindo daqui a um ano.

**O quadro entra por parâmetro, como o do vídeo.** `drawFrame` é síncrona e
pura; rasterizar HTML+CSS é assíncrono. Então `overlayFrames` prepara e
`drawFrame` só consulta. Enquanto o quadro não existe, a layer **não desenha** e
o quadro é marcado `degraded`.

**Quadro do instante errado não é desenhado.** A regra é copiada de `drawVideo`:
pintar o vizinho porque o certo ainda não ficou pronto é a mentira que tirar o
`<video>` do caminho veio matar. Ver o README, seção "De onde vem o quadro de
vídeo".

**O preview não espera; o export e o pré-render esperam.** O arquivo final não
pode sair com uma layer faltando, e o pré-render guarda quadros como
definitivos — servir um sem o overlay envenenaria o cache.

**A bandeja é deliberadamente burra:** um slot em `localStorage`, sobrescrito a
cada envio e consumido na chegada. Não é biblioteca de efeitos — isso é a fase
F, e vai precisar de decisões (versão, atualização, conflito) que não cabem num
`setItem`.

**O palco é um iframe.** Se fosse uma `div` na página, um `body{background:#000}`
no CSS do autor pintaria o editor inteiro. E é a base do sandbox que a
importação de terceiros vai exigir.

## Onde vive no código

| arquivo | o que decide |
|---|---|
| [`criar/overlay.ts`](../src/criar/overlay.ts) | HTML+CSS → bitmap de um instante (o seek mora aqui) |
| [`criar/svg.ts`](../src/criar/svg.ts) | a montagem do SVG (pura, testada em node) |
| [`engine/overlayFrames.ts`](../src/engine/overlayFrames.ts) | quem prepara e quem guarda; a regra do instante certo |
| [`engine/renderer.ts`](../src/engine/renderer.ts) | o desenho, e o `degraded` |
| [`engine/types.ts`](../src/engine/types.ts) | `OverlayLayer` |
| [`engine/serialize.ts`](../src/engine/serialize.ts) | o pacote indo e voltando do `.frag` |
| [`engine/frameCache.ts`](../src/engine/frameCache.ts) | a assinatura: editar o CSS invalida os quadros |
| [`criar/bandeja.ts`](../src/criar/bandeja.ts) | o slot entre `/criar` e o editor |

## Limites conhecidos

- **Só o tipo `efeito`.** Filtro, transição e texto abrem no `/criar` mas ainda
  não têm comportamento próprio no editor: viram uma camada por cima, como um
  efeito comum. Slots (`data-frag="video1"`) não estão ligados.
- **Um efeito por vez na bandeja.** Sem biblioteca, sem salvar, sem importar
  arquivo de terceiro.
- **Sem sandbox de verdade.** O iframe isola o CSS, mas o pacote ainda vem de
  quem está usando o editor. Importar de terceiros exige a fase F antes.
- **Sem fontes próprias.** O runtime embute fontes, mas nada na interface deixa
  você subir uma.
- **Custo real.** Um overlay cobrindo o quadro inteiro o tempo todo é o pior
  caso de export medido: ~231 ms/quadro em 1080p. Ver
  [LIMITES.md](../LIMITES.md) §5.
