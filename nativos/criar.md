# A página `/criar`

**Estado:** parcial. Fecha o laço do painel (declarar `params` → ver os
controles). Escrever o CSS e ver o efeito virar pixel é a fase B do
[PRIORIDADES.md](../PRIORIDADES.md).

## O que resolve

Quem vai escrever um efeito precisa saber **como ele vai aparecer no editor**
antes de publicar. Sem isso, o autor descobre que esqueceu um `min` (e o campo
saiu sem slider) ou que nomeou um param de um jeito que quebra o CSS, só depois
que alguém instalou.

## Como se usa

`criar.html`, ou `criar.html?tipo=filtro` pra abrir direto num tipo — a URL
acompanha o botão, então link e F5 não mentem.

1. Escolha o tipo: **efeito**, **filtro**, **transição** ou **texto**. Cada um
   carrega um manifesto de exemplo diferente, de propósito: quem abre em
   "texto" precisa ver `texto()` existindo, senão supõe que só dá pra declarar
   número.
2. Edite o manifesto à esquerda.
3. À direita, ao vivo: os controles que o editor vai desenhar, e **as
   variáveis CSS que o seu CSS vai receber**.

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

**A página diz o que ainda não faz**, no rodapé. Quem chega esperando escrever
CSS e ver o vídeo precisa saber onde está; esconder seria pior.

## Onde vive no código

| arquivo | |
|---|---|
| [`criar.html`](../criar.html) | a entrada |
| [`src/criar/main.tsx`](../src/criar/main.tsx) | monta o React |
| [`src/criar/Criar.tsx`](../src/criar/Criar.tsx) | a página: tipos, sementes, validação ao vivo |
| [`vite.config.ts`](../vite.config.ts) | as duas entradas do build |

Os controles são os mesmos do editor
([`CamposDeParams`](../src/ui/CamposDeParams.tsx)) — se divergissem, o preview
mentiria, que é justamente o que a página existe pra evitar.

## Limites conhecidos

- **Não escreve CSS nem mostra o efeito rodando.** É o próximo passo.
- **Sem salvar.** O que você escrever some ao recarregar.
- **Sem TypeScript.** Manifesto em JSON até haver compilador no navegador.
