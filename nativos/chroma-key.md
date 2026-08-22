# Chroma key

**Estado:** planejado. A decisão está tomada e medida; o código não existe.
**Item no plano:** D3 em [PRIORIDADES.md](../PRIORIDADES.md).

## O que resolve

Gravou na frente de um fundo verde (ou azul) e quer trocar o fundo. O editor
apaga a cor escolhida e deixa o resto.

## Como se usa

Propriedade da layer de vídeo, com controles próprios:

| controle | o que faz |
|---|---|
| **conta-gotas** | clica no vídeo pra pegar a cor exata do fundo |
| **cor** | a mesma coisa, escolhida à mão |
| **tolerância** | quanto de variação ainda conta como "aquela cor". Fundo mal iluminado precisa de mais |
| **suavização** | largura da faixa de transição na borda. Zero recorta em serra; muito, come detalhe |
| **sobra (spill)** | quanto do reflexo verde tirar da pele e do cabelo. É o controle do "chroma verdasso" contra o "com sobras" |

## Por que é nativo e não efeito da comunidade

Bate dois dos quatro critérios: **precisa de UI que o sistema de efeitos não
sabe desenhar** (conta-gotas em cima do vídeo) e **precisa de decisão
condicional por pixel**.

O segundo é o que decide. Cada controle acima é um `if` por pixel — "se a cor
for parecida o suficiente com essa, então some". CSS não tem `if`, e filtro SVG
também não.

## A alternativa descartada, com números

**Tentativa 1 — filtro SVG (`feColorMatrix` + `feComponentTransfer`).**

Era de longe o mais barato: filtro SVG nos pixels do vídeo já está medido
funcionando ([LIMITES.md §3](../LIMITES.md)), e o chroma key parecia caber lá.
`alpha = 1 + R − 2G + B` derruba o verde e mantém pele e branco.

Testado contra uma referência correta em JS, num green screen realista — com
ruído de sensor, gradiente de iluminação, fios finos de cabelo e uma **roupa
verde-azulada que não podia sumir**:

| | fundo (quer 0) | pele (quer 255) | roupa (quer 255) | franja verde |
|---|---|---|---|---|
| referência (JS, com `max()` e despill) | 0 | 255 | 255 | **0 px** |
| filtro SVG | 0 | 255 | 255 | **748 px** |
| filtro SVG + despill | 0 | 255 | 255 | **737 px** |

Passa nos três testes grossos e falha nos finos:

- **comeu os fios de cabelo** — visível na comparação, os fios saem bem mais
  curtos que na referência
- **737 px de franja verde** na borda, contra zero
- **o despill estragou uma cor que não tinha verde**: um retângulo vermelho
  saiu laranja

A causa não é parâmetro mal ajustado, é estrutural: **`feColorMatrix` é linear
e incondicional.** Ele não sabe dizer "só mexe onde tem verde" — aplica a mesma
conta a todo pixel. E `max(R,B)`, que é o coração de um matte decente, não
existe no vocabulário dele.

**Tentativa 2 — laço por pixel em JS (`getImageData`).**

Dá o resultado certo — é a referência da tabela acima. Custou **14,3 ms em
960×540**, o que é **~57 ms em 1080p**.

Descartado pelo uso, não pela conta: chroma key não é um título de 3 segundos,
vale pro **clipe inteiro, todo quadro**. 57 ms por quadro é preview a 17 fps.

**Escolhido — shader WebGL.** Correto e rápido. Já era o plano: o README do
primeiro commit (`0e96ddf`) listava "chroma key (shader WebGL)" na roadmap.

## Onde vai viver

Ainda não existe. O desenho:

- **estágio do compositor**, entre o quadro decodificado e o canvas 2D. Recebe
  o `VideoFrame`, devolve textura com alpha.
- **não é WebGL dentro do overlay** — isso não funciona, porque `<canvas>` não
  serializa pro `foreignObject` (ver [LIMITES.md §2.5](../LIMITES.md)). É uma
  superfície GL separada, antes do desenho.
- vira campo da `VideoLayer` em [`types.ts`](../src/engine/types.ts), então
  entra no `.frag` e **precisa entrar no `renderSignature`** — senão mexer na
  tolerância não invalida os quadros já guardados.

Uma vez que essa superfície existir, ela é reutilizável por qualquer efeito
futuro que precise de matemática de verdade por pixel.

## Limites conhecidos

- **Fundo mal iluminado, com sombra forte, não tem conserto por chroma.** O
  controle de tolerância ajuda até certo ponto; depois disso o problema é a
  filmagem.
- **Não é segmentação.** Recortar uma pessoa gravada em quarto normal, sem
  fundo verde, é outro problema — modelo de ML, e projeto próprio.
- **Sem garbage matte** na primeira versão (aquele recorte manual pra ignorar
  cantos do estúdio que aparecem no quadro).
