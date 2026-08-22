# Plano de ação — o sistema de efeitos da comunidade

Atualizado em 22/08/2026.

## O critério desta fase

Igual ao critério de "usável" que fechou a v0.1.0, este precisa ser uma frase
que se testa, não uma lista:

> **Uma pessoa que sabe CSS escreve um efeito num arquivo, abre no editor,
> ajusta os controles no painel e exporta o vídeo — sem falar com a gente e sem
> aprender API nenhuma.**

Tudo abaixo existe pra isso. O que não serve a essa frase não entra nesta fase.

## Onde estamos

**Travado e verificado:** `v0.1.0` (tag anotada, local) — o editor completo,
573 testes, build limpo. É o ponto conhecido-bom pra voltar se o caminho de
render der errado.

**Levantamento fechado:** [LIMITES.md](LIMITES.md) — o que o navegador aguenta,
medido em Chrome 151. As três coisas que sustentam o desenho:

- `@keyframes` puro é **seekable** (`paused` + `animation-delay` negativo),
  exato em 26/26 instantes
- o caminho DOM→canvas cobra **7,3 ms/quadro** e ainda ganha do canvas 2D nos
  filtros
- o overlay **nunca** vai ler os pixels do vídeo (44,8 ms e 168 kB por quadro) —
  por isso existem slots

**Pronto:** fases **A**, **B**, o grosso da **C**, e o **F1** (validador). Um efeito escrito em HTML+CSS
já vai do `/criar` até a linha do tempo, com controles gerados do próprio
efeito, sobrevive ao autosave e entra no export. 621 testes.

---

## A ordem

Risco crescente, e cada fase depende da anterior. **O `drawFrame` só é tocado na
fase C** — até lá, dá pra parar em qualquer ponto sem deixar o editor pior.

### Fase A — o contrato (não toca o render)

**A1. PropsPanel gera campos a partir do esquema** ✅ *feito*
O painel passa a desenhar controles percorrendo `params` em vez de ter campos
fixos. Cobaia: os efeitos JSON que já existem.
*Toca:* [`PropsPanel.tsx`](src/ui/PropsPanel.tsx), [`EffectsPanel.tsx`](src/ui/EffectsPanel.tsx).
*Risco:* baixo, e confinado à UI.
*Valida quando:* mudar um slider muda o efeito na tela, e o undo/redo continua com a granularidade certa.

**A2. `criar.html` — a rota `/criar`** ✅ *feito*
Entry point separado do Vite, não um router. Isola do editor, não contamina o
estado do App, e importa o mesmo runtime. Quatro botões: efeito, filtro,
transição, texto.
*Toca:* `vite.config.ts`, arquivos novos.
*Risco:* nenhum — é uma página nova.

### Fase B — o runtime do overlay (código novo, isolado)

**B1. `criar/overlay.ts`** ✅ *feito* — DOM vivo → seek → `foreignObject` → bitmap.
Inclui, todos já resolvidos nos spikes:
- conserto do `animation-delay` do autor (ler uma vez, reescrever como `orig - t`) — custa +1 ms
- empacotar o CSS em `CDATA` (senão `<` quebra a serialização)
- embutir fontes do pacote como `data:` URI (+2 ms)
- `rng()` semeado no contexto
*Risco:* médio. A montagem do SVG é string pura, então boa parte é testável em node.

### Fase C — o overlay entra no quadro (**aqui toca o render**)

**C1. Tipo `overlay` como LAYER própria.** ✅ *feito* — e aqui o plano mudou:
em vez de o efeito decorar uma layer existente, ele virou um tipo de layer.
Risco muito menor (nenhum tipo existente foi tocado) e prova o caminho inteiro
— modelo, arquivo, assinatura, desenho, preview e export. Decorar outra layer
fica como passo seguinte, agora com o encanamento já validado.
**C2. `degraded` quando o quadro ainda não existe.** ✅ *feito* — o mecanismo já
existia em [`renderer.ts`](src/engine/renderer.ts) e ganhou a terceira causa.
**C3. `renderSignature` inclui html, css e valores.** ✅ *feito* — com teste
pros dois lados: CSS/HTML/valores invalidam, nome e schema não.

*O que apareceu no caminho:* `drawFrame` é síncrona e rasterizar HTML+CSS é
assíncrono. A saída já estava no projeto — o quadro entra por PARÂMETRO, como o
do vídeo. Preview não espera (desenha degradado); export e pré-render esperam.

**Falta em C:** aplicar um overlay SOBRE uma layer existente, em vez de ele ser
uma layer própria.

### Fase D — slots (destrava a metade interessante)

**D1. `data-frag="video1"` com geometria lida via matriz de `transform`**
(`offsetLeft`/`offsetTop` sozinhos ignoram transform — foi o bug do spike do vidro).
Destrava de uma vez: **vidro**, **vídeo em partículas**, **máscara pelo alpha do overlay**.
**D2. Tipo `filtro`** — `ctx.filter = 'url(#…)'` nos pixels do vídeo: noise,
aberração cromática, distorção. Todos medidos funcionando.

**D3. Chroma key — recurso NATIVO, não efeito da comunidade.**
Propriedade da layer de vídeo, com UI própria: conta-gotas, seletor de cor,
tolerância, suavização da borda e quantidade de sobra (spill). Nada disso é
expressável em CSS, e não deveria ser: é o tipo de coisa que precisa funcionar
igual pra todo mundo.

*Por que não filtro SVG* — foi medido, e falha onde importa. `feColorMatrix` é
**linear e incondicional**: não sabe dizer "só mexe onde tem verde". Passou nos
testes grossos (fundo a alpha 0, pele em 255, roupa verde-azulada preservada),
mas comeu os fios de cabelo, deixou **737 px de franja verde** contra 0 da
referência, e o despill **estragou o vermelho, que virou laranja**. Cada um dos
seus controles (tolerância, sobra) é uma decisão condicional por pixel, e
condição é justamente o que uma matriz linear não tem.

*Por que não laço em JS* — dá o resultado certo, mas custou 14,3 ms em 960×540,
o que é ~57 ms em 1080p. Chroma key não é um título de 3 segundos: vale pro
clipe inteiro, todo quadro. 57 ms é preview a 17 fps.

*Então WebGL* — e vale notar que já era o plano: o README do primeiro commit
listava "chroma key (shader WebGL)" na roadmap.

**Isto NÃO é WebGL dentro do overlay**, que a gente mediu que não funciona
(canvas não serializa pro `foreignObject`). É um **estágio do compositor**: uma
superfície GL que processa o quadro do vídeo antes de ele chegar no canvas 2D.
Não conflita com nada, e vira a base pra qualquer efeito futuro que precise de
matemática de verdade por pixel.

*Risco:* médio. É código novo e isolado, mas entra no caminho quente do quadro.

### Fase E — o que mexe em estrutura

**E1. Tipo `transicao`.** O único item que quebra uma invariante existente: hoje
clipes na mesma faixa **nunca se sobrepõem**, e é isso que faz a ordem de desenho
dentro da faixa não importar ([`types.ts:112`](src/engine/types.ts#L112)).
Sobreposição passa a ser permitida **só quando um link de transição une o par**.
Não precisa de material extra: B começa mais cedo, A toca até o fim, o projeto
encurta.
*Toca também:* [`magnet.ts`](src/engine/magnet.ts), [`trackDrag.ts`](src/engine/trackDrag.ts), split, serialize.
*Risco:* **alto**, e espalhado. Por isso é a última.

**E2. Tipo `texto`** — templates, e o Fragmento dividindo texto em letras/palavras
expondo `--i` e `--n`. Sem isso, typewriter e karaokê exigem JS do autor; com
isso é `animation-delay: calc(var(--i) * .05s)`, medido funcionando.

### Fase F — abrir pra comunidade

**F1. Validador** ✅ *feito* — implementa a §6 do [LIMITES.md](LIMITES.md): 4
erros que recusam a carga, 7 avisos, 3 avisos de custo. Roda ao vivo no
`/criar` enquanto se digita, e é o mesmo módulo que a importação vai usar. Puro,
27 testes — incluindo o que garante que **as quatro sementes passam limpas**,
senão a primeira coisa que a pessoa vê ao abrir a página é uma reclamação sobre
o nosso próprio código.
**F2. Sandbox** — `OffscreenCanvas` em Worker pro pixel, `iframe` isolado pro DOM.
*Importar código de terceiro sem isolamento dá acesso à aba inteira e ao
IndexedDB do projeto.* Precisa entrar no desenho antes de existir importação, não
depois.
**F3. Empacotamento e import** — o arquivo de efeito, com assets.

---

## O que NÃO entra nesta fase

| | por quê |
|---|---|
| **Temas / interface personalizável** | adiado por decisão — ver [ideias/temas.md](ideias/temas.md) |
| Segmentação automática (recortar pessoa) | projeto próprio; roda no navegador (MediaPipe), mas não depende disto |
| Rotoscopia manual (desenhar máscara) | funcionalidade do editor, não do sistema de efeitos |
| Render por servidor (Puppeteer) | só se um dia quisermos Three.js/shader; não conflita, não urge |
| WebGL como superfície de efeito | saída de emergência, não caminho principal |
| Densidade/tamanho da UI configurável | 271 px literais; ninguém pede |

---

## Decisões já tomadas (registro)

1. **O alvo de render continua sendo canvas**, e o export continua no navegador
   via WebCodecs. O caminho de navegador headless (Remotion, HyperFrames) foi
   descartado: custaria um servidor e desfaria a decisão do primeiro commit.
2. **Efeito é HTML+CSS+TS**, não JSON. O JSON de 8 props continua existindo e
   não precisa ser removido.
3. **A "estrutura mínima do Fragmento" é o manifesto** (`meta.tipo` + `params`).
   O CSS do autor não muda em nada — nem `--frag-t` ele precisa escrever.
4. **Quem precisa dos pixels do vídeo usa slot ou filtro SVG**, nunca overlay.
5. **Determinismo é regra dura**: sem `Math.random()`, `Date.now()` ou estado
   entre quadros. O `rng()` semeado vem do editor.
6. **Tema fica com o usuário**, em `localStorage`, fora do `.frag`.

## Decisões em aberto

- **Quantas camadas de rasterização um overlay pode ter** — 1 (barato) ou N por
  `z-index` (flexível, custa o dobro). Recomendação: começar com 1.
- **Import de vídeo com canal alpha** — o export não tem (H.264 e VP9 perfil 0);
  o caminho de import não foi verificado. Decide se "importar 3D pronto" usa
  alpha ou chroma key.
- **Servidor: sim ou não, algum dia.** Não urge, mas é a pergunta que governa
  tudo que hoje está na coluna "não vai dar".
