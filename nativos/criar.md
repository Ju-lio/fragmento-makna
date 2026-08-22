# A página `/criar`

**Estado:** parcial. Escrever HTML+CSS, mexer nos controles e ver o quadro
exato de qualquer instante já funciona. Falta salvar o efeito e aplicá-lo numa
layer — fase C do [PRIORIDADES.md](../PRIORIDADES.md).

## O que resolve

Escrever um efeito e ver o resultado — o quadro e os controles — sem sair da
página.

Sem isso, o autor descobre que esqueceu um `min` (e o campo saiu sem slider),
que nomeou um param de um jeito que quebra o CSS, ou que calibrou o tamanho em
`px` e o efeito vaza da tela em formato vertical, só depois que alguém
instalou.

## Como se usa

`criar.html`, ou `criar.html?tipo=filtro` pra abrir direto num tipo — a URL
acompanha o botão, então link e F5 não mentem.

1. Escolha o tipo: **efeito**, **filtro**, **transição** ou **texto**. Cada um
   abre com um efeito de partida que **roda de verdade** — o raio, o texto
   empilhado, o grão de filme, o empurrão. São os que foram medidos durante o
   levantamento do `LIMITES.md`, não pseudocódigo.
2. Edite **CSS**, **HTML** ou **MANIFESTO** nas abas.
3. À direita, ao vivo: o quadro renderizado, um slider de tempo pra varrer a
   animação, os controles que o editor vai desenhar, e **as variáveis CSS que o
   seu CSS vai receber**.

O bloco "O SEU CSS RECEBE" é a parte do contrato que ninguém adivinha — que um
número com `unidade: "px"` chega como `34px` e não `34`, e que booleano vira
`1`/`0` porque CSS não tem booleano.

## Por que é nativo e não efeito

É a ferramenta de fazer efeito. Não se aplica a nada.

## Decisões de desenho

**Entrada separada do Vite, não uma rota.** Um router traria dependência e um
bundle único pra servir duas páginas que ninguém usa ao mesmo tempo. Duas
entradas custam três linhas em `vite.config.ts`, isolam o playground do estado
do editor (que é grande e vive fora do React) e ainda importam o mesmo
`src/criar/`.

**O manifesto entra como JSON, não TS.** Ainda não há compilador no navegador.
Não é perda: os descritores de `api.ts` são objetos simples de propósito —
`num(0.5, { max: 2 })` e `{"tipo":"num","padrao":0.5,"max":2}` são o mesmo
objeto —, então o que se testa aqui é exatamente o que o TS vai produzir.

**A página diz o que ainda não faz**, no rodapé. Quem chega esperando salvar e
aplicar numa layer precisa saber onde está; esconder seria pior.

**O preview renderiza em 1280×720 e mostra reduzido**, em vez de renderizar no
tamanho da caixa. Se ele fosse 640 de largura, quem escreve calibraria `vw`,
`%` e raio de desfoque pra uma composição que não existe — e o efeito sairia
diferente no projeto de verdade.

**O mesmo `Overlay` do editor.** Se o preview usasse outro caminho, ele
mentiria — que é exatamente o que a página existe pra evitar.

## Onde vive no código

| arquivo | |
|---|---|
| [`criar.html`](../criar.html) | a entrada |
| [`src/criar/main.tsx`](../src/criar/main.tsx) | monta o React |
| [`src/criar/Criar.tsx`](../src/criar/Criar.tsx) | a página: abas, validação e render ao vivo |
| [`src/criar/sementes.ts`](../src/criar/sementes.ts) | os efeitos de partida, um por tipo |
| [`src/criar/overlay.ts`](../src/criar/overlay.ts) | HTML+CSS → bitmap de um instante |
| [`src/criar/svg.ts`](../src/criar/svg.ts) | a montagem do SVG (pura, testada em node) |
| [`vite.config.ts`](../vite.config.ts) | as duas entradas do build |

Os controles são os mesmos do editor
([`CamposDeParams`](../src/ui/CamposDeParams.tsx)) — se divergissem, o preview
mentiria, que é justamente o que a página existe pra evitar.

## Limites conhecidos

- **Sem salvar.** O que você escrever some ao recarregar.
- **Sem aplicar numa layer.** O efeito ainda não sai desta página.
- **Sem TypeScript.** Manifesto em JSON até haver compilador no navegador.
- **Os slots (`data-frag`) ainda não estão ligados.** Na semente de transição
  eles aparecem como blocos coloridos, pra mostrar a geometria. O vídeo entra
  na fase D.
- **Sem fontes próprias.** O runtime já embute fontes, mas a página ainda não
  tem como você subir uma.
