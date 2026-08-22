# Escrevendo efeitos no Fragmento — o que funciona, o que não, e por quê

Este documento é a referência para quem escreve efeito. Ele não é uma lista de
regras arbitrárias: **quase tudo aqui sai de três fatos sobre como o quadro é
gerado**, e se você entender os três, consegue prever o resto sozinho.

Cada item está marcado com:

- **[medido]** — verificado com medição e conferido na imagem
- **[medido: falha]** — verificado que NÃO funciona
- **[não verificado]** — dedução a partir da arquitetura, ainda sem teste

Medições feitas em **Chrome 151 headless, GPU integrada Kaby Lake**. É hardware
antigo e o headless pode nem estar usando a GPU — então trate os custos como
**piso pessimista**: numa máquina melhor tende a ser mais rápido, não mais lento.

---

## 1. Como o seu efeito vira quadro

```
  seu HTML+CSS  →  DOM vivo  →  seek para t  →  SVG <foreignObject>
                                                        ↓
                       canvas  ←  bitmap  ←  <img> decodifica
                          ↓
                   WebCodecs → MP4
```

O **seek** é o truque central: o editor injeta

```css
animation-play-state: paused;
animation-delay: <o seu delay> - <t>s;
```

e o navegador desenha **o instante exato** daquele `@keyframes`, estático.
Você escreve animação CSS normal; o editor pede "me dá o frame de 12,4s" e
recebe. **[medido]** — exato em 26/26 instantes testados, inclusive depois do
primeiro ciclo do loop.

### Os três fatos que explicam todas as regras

**Fato 1 — JavaScript não roda dentro do snapshot.**
Um SVG carregado como `<img>` entra em modo estático: sem scripts, sem rede.
Seu JS roda **antes**, no DOM vivo, e o que é fotografado é o resultado.

**Fato 2 — nada externo carrega.**
Fonte, imagem, qualquer `url()` remota é ignorada. Tudo precisa estar embutido
como `data:` URI. O editor faz isso pelos assets do seu pacote.

**Fato 3 — cada quadro é independente.**
O quadro 420 é desenhado sem nunca ter visto o 419. É isso que permite o cache
reaproveitar quadros e o export renderizar fora de ordem — e é a regra mais
fácil de violar sem perceber.

---

## 2. Regras duras — quebrar qualquer uma destas estraga o vídeo

### 2.1 Determinismo: proibido `Math.random()` e `Date.now()`

```js
// ERRADO — cada quadro sorteia de novo, o vídeo sai tremendo
folha.style.left = Math.random() * 100 + '%';

// CERTO — a semente vem do editor, o mesmo t dá sempre o mesmo valor
folha.style.left = rng() * 100 + '%';
```

**Por quê:** Fato 3. O export renderiza quadros fora de ordem e o cache reusa
quadros antigos. Um efeito não determinístico produz preview e arquivo final
diferentes, e o arquivo pisca.

Também proibido pela mesma razão: `new Date()`, `performance.now()`,
`requestAnimationFrame` para controlar o tempo, contadores que incrementam a
cada chamada, e qualquer estado guardado entre quadros.

### 2.2 Nada de recurso externo

| Não funciona | Use no lugar |
|---|---|
| `@import url(https://fonts.googleapis.com/…)` | fonte no pacote, embutida como `data:` |
| `<img src="https://…">` | imagem no pacote |
| `background-image: url(/foto.png)` | idem |
| `fetch()`, `XMLHttpRequest` | nada — o efeito é offline |

**[medido]** Fonte embutida como `data:` URI funciona e custa **+2ms/frame**.

### 2.3 Fonte de sistema muda de máquina para máquina

```css
/* PERIGOSO: sai diferente no seu PC e no de quem for exportar */
font-family: system-ui, sans-serif;

/* CERTO: a fonte vai junto no pacote */
font-family: 'MinhaFonte';
```

**Por quê:** `system-ui` é Segoe no Windows, San Francisco no Mac, outra coisa
no Linux. O layout inteiro muda. Se o texto tem que ficar exatamente como você
desenhou, embuta a fonte.

### 2.4 `<` e `&` dentro do CSS

**[medido: falha]** O `<style>` dentro do SVG é lido como **XML**, então um `<`
solto abre uma tag e quebra a serialização inteira — o quadro vira erro, não
sai torto.

```css
/* quebra */
@property --n { syntax: '<integer>'; }
```

O editor envolve o seu CSS em `CDATA`, o que resolve o caso normal. Mas se você
colocar um `<style>` **dentro do seu HTML**, ele não passa por esse tratamento.
Regra prática: mantenha CSS no arquivo `.css`, não em `<style>` embutido.

### 2.5 `<canvas>` e WebGL não aparecem

**[medido: falha]** Conteúdo desenhado num `<canvas>` não serializa para dentro
do `foreignObject` — sai um buraco. Isso mata **Three.js, shaders WebGL e
qualquer coisa que desenhe em canvas** dentro de um overlay.

**Alternativas:** `perspective`/`rotateX/Y` + `transform-style: preserve-3d` dão
3D com profundidade real (**[medido]**, incluindo texto extrudado), sem
iluminação nem reflexo. Para o resto, exporte de outra ferramenta e importe
como mídia.

---

## 3. O que funciona — verificado

Tudo abaixo foi renderizado e conferido visualmente.

### Animação e tempo
| Recurso | |
|---|---|
| `@keyframes` + `animation` | **[medido]** seekable, exato |
| `animation-delay` do autor (positivo e negativo) | **[medido]** preservado |
| `animation-delay: calc(var(--i) * .07s)` | **[medido]** stagger só com CSS |
| `steps()`, `ease`, `cubic-bezier` | **[medido]** |
| `@property` + animar variável registrada | **[medido]** |

### Pintura e composição
| Recurso | |
|---|---|
| `filter: blur() brightness() drop-shadow() saturate()` | **[medido]** |
| `mix-blend-mode` | **[medido]** |
| `backdrop-filter` | **[medido]** — mas ver §4.1 |
| `clip-path: polygon()` | **[medido]** |
| `mask-image` / `-webkit-mask-image` | **[medido]** |
| gradientes `linear`, `radial`, `conic` | **[medido]** |
| `border-radius`, `box-shadow`, `text-shadow` (multi-camada) | **[medido]** |

### Texto
| Recurso | |
|---|---|
| `background-clip: text` + gradiente | **[medido]** |
| `-webkit-text-stroke` | **[medido]** |
| `text-shadow` empilhado (o "retrô" de 6 camadas) | **[medido]** |
| layout que se ajusta ao texto (flex, `inline-block`, quebra de linha) | **[medido]** |
| split por caractere/palavra com `--i` | **[medido]** |
| karaokê: palavra a palavra acendendo em ordem, só com CSS | **[medido]** |
| contador formatado (`R$ 1.234,56`) via prop de texto | **[medido]** |

### 3D
| Recurso | |
|---|---|
| `perspective`, `rotateX/Y/Z` | **[medido]** |
| `transform-style: preserve-3d` (extrusão real) | **[medido]** |

### Filtros SVG (aplicáveis inclusive nos pixels do vídeo)
| Recurso | |
|---|---|
| `feTurbulence` (noise/grão) | **[medido]** determinístico via `seed` |
| `feDisplacementMap` (distorção líquida) | **[medido]** |
| `feColorMatrix`, `feOffset`, `feBlend`, `feComposite` (aberração cromática) | **[medido]** |

**Cuidado com `feColorMatrix`: ele é linear e incondicional.** Não existe "só
mexe onde a cor é X" — a mesma conta é aplicada a todo pixel. **[medido]** numa
tentativa de chroma key, o despill escrito assim puxou o canal verde de um
retângulo **vermelho**, que saiu laranja; e os fios finos de cabelo foram
comidos, deixando 737 px de franja verde contra 0 de uma implementação com
`max()` de verdade.

Se o seu efeito precisa decidir **por pixel** ("se for parecido com essa cor,
então…"), filtro SVG não é o lugar. Chroma key, por isso, é recurso nativo do
editor, não efeito.

### Unidades
`vw`, `vh`, `%`, `em`, `rem` **[medido]** resolvem contra o tamanho do projeto,
não contra a página. `50vw × 20vh` deu 10% da tela tanto em 1920×1080 quanto em
1080×1920 — **o seu efeito é responsivo de graça**. Prefira unidades relativas a
pixels fixos, e trocar o formato do projeto não quebra nada.

---

## 4. Limites estruturais — não são bugs, são o desenho

### 4.1 O overlay não enxerga o vídeo

O vídeo **não está no DOM**. Consequências:

- `backdrop-filter` funciona, mas o "fundo" dele é só o que está dentro do
  próprio overlay — **não o vídeo**. Um painel de vidro sozinho desfoca nada.
- Não dá para ler, amostrar ou reagir à cor do vídeo pelo CSS.

**[medido]** Colocar um quadro 1080p dentro do overlay custaria **44,8ms e
168kb por quadro** — inviável.

### 4.1b Misturar com o que está embaixo é do MANIFESTO, não do CSS

`mix-blend-mode` dentro do seu efeito funciona — mas só enxerga o fundo do
**próprio efeito**, que é transparente. Ele nunca alcança o vídeo.

Para misturar com o que está embaixo, declare no manifesto:

```json
{ "meta": { "tipo": "filtro", "nome": "Granulado", "mistura": "overlay" } }
```

Os valores são os mesmos nomes do `mix-blend-mode`: `normal`, `screen`,
`multiply`, `overlay`, `soft-light`, `lighten`, `darken`, `difference`. Quem
compõe é o canvas, não o CSS. No editor, quem monta o vídeo pode trocar isso no
painel — o autor escolhe o padrão.

**Por que isso importa:** sem mistura, **grão de filme é impossível**.
`feTurbulence` **gera** ruído — ele não recebe o que está embaixo —, então
sozinho ele cobre o quadro com uma chapa cinza opaca em vez de granular.

Duas armadilhas relacionadas, as duas medidas:

- **`feTurbulence` também sorteia o alpha.** Boa parte do ruído sai
  transparente e some na mistura. Force `alpha = 1` com
  `<feComponentTransfer><feFuncA type="discrete" tableValues="1"/></feComponentTransfer>`.
- **Em `overlay`, pixel transparente não muda nada e cinza médio também não.**
  Uma vinheta que precise escurecer as bordas deve ter o centro
  **transparente** — um cinza opaco ali cobriria o que estiver abaixo dele
  dentro do próprio efeito.

**Como fazer mesmo assim:** declare um **slot**. Você marca o elemento, o CSS
posiciona e anima, e o **compositor desenha o vídeo ali**:

```html
<div class="painel" data-frag="vidro" data-blur="26"></div>
```

**[medido]** É assim que o efeito de vidro funciona de verdade: o CSS diz onde e
quanto, o canvas desfoca a região do vídeo, e a decoração (borda, especular,
grão) entra por cima.

### 4.2 O overlay vira UM bitmap — sem z-order intercalado

Dá para desenhar o vídeo **antes** ou **depois** do overlay inteiro, mas não
**entre dois elementos dele**. "Título passando atrás da pessoa e na frente do
fundo" exige rasterizar o overlay duas vezes (custa o dobro) ou trazer a pessoa
como uma camada separada já recortada.

### 4.3 Sem realimentação entre quadros

Pelo Fato 3, um efeito não pode nascer do quadro anterior **já renderizado**.

- **Não dá:** fogo, fumaça, água simulada, reação-difusão, partículas que
  colidem entre si, trilha que acumula indefinidamente.
- **Dá:** qualquer coisa que seja função fechada do tempo — inclusive **echo /
  rastro**, desenhando a mesma camada em `t`, `t-Δ`, `t-2Δ`… **[medido]**,
  custa cerca de N vezes um quadro normal.

---

### 4.4 O codificador também tem opinião sobre o seu efeito

Grão de filme, película e ruído em geral são **caros de codificar**, e isso não
aparece no preview — só no arquivo.

**[medido]** num export real: um efeito de grão a ~6 Mbps saiu com os degradês
lisos quebrados em macroblocos. Dentro da região estragada, o salto de
luminância nas colunas múltiplas de 16 era **4,38× maior** que nas demais — a
assinatura da grade do H.264. Na região limpa do mesmo arquivo: 0,97×. No nosso
render, antes de codificar: 0,75× (nenhuma grade).

A causa não é defeito nosso nem do codificador: ruído é alta entropia em cada
pixel, e o H.264 não tem síntese de grão. Ele gasta o orçamento inteiro no
ruído e não sobra pros degradês.

**A saída é bitrate.** O editor tem três níveis ao lado do botão de exportar;
efeito com grão, película ou desfoque pesado pede **alta**. O padrão subiu de
~6 para ~9,3 Mbps em 1080p30 por causa deste caso.

## 5. O que custa caro

**[medido]** Chrome 151, 1920×1080, mediana, GPU integrada antiga.

| | custo por quadro |
|---|---|
| passar pelo caminho DOM (sem filtro nenhum) | **7,3 ms** |
| `filter: blur(12px)` | 35,9 ms |
| `filter: blur(40px)` | 45,3 ms |
| `filter: drop-shadow(0 0 34px)` | 42,8 ms |
| `filter: brightness(1.6)` | 23 ms |
| 100 elementos animados | 27 ms |
| 500 elementos animados | 45 ms |
| 2000 elementos animados | **143 ms** |
| echo com 8 amostras | ~5× um quadro normal |
| composição de vidro (720p) | 51 ms |
| **vinheta + grão cobrindo o quadro inteiro** | **231 ms** (720p: 101 ms) |

Duas leituras que importam:

**Desfoque é o item mais caro, e não é culpa do DOM.** O mesmo `blur(40px)`
desenhado direto em canvas 2D custou **53,1ms** — mais caro que os 45,3ms do
caminho DOM. Desfoque grande em 1080p é caro em qualquer superfície.

**Número de elementos escala mal.** É o único item que cresce de verdade. Se
você precisa de milhares de pedaços (partículas, chuva, confete), use um
**slot por pedaço** desenhado pelo compositor, não milhares de nós no DOM.

### O custo só existe enquanto o efeito está na tela

Um título de 3 segundos num vídeo de 60s = 90 quadros. Mesmo a 43ms cada, são
**+3,9 segundos** no export.

Uma vinheta cobrindo o vídeo inteiro paga em **todos** os quadros. **[medido]**
a 231 ms cada, isso é:

| vídeo de | quadros | acréscimo no export |
|---|---|---|
| 30 s | 900 | +3,5 min |
| 60 s | 1800 | +6,9 min |
| 180 s | 5400 | +20,8 min |

É o pior caso conhecido, e é a razão do aviso 13 na §6. O grão por
`feTurbulence` é a parte cara: ruído procedural é gerado pixel a pixel.
Alternativa muito mais barata para grão: uma imagem de ruído pequena, embutida
no pacote e repetida com `background-repeat`.

---

## 6. Avisos que o editor dá

Esta seção era a especificação do validador; agora ela é a lista do que ele
**já checa**, ao vivo enquanto você digita no `/criar` e na hora de importar um
pacote. O código é [`src/criar/validador.ts`](src/criar/validador.ts).

Três níveis, e a diferença importa: **erro** não carrega, **aviso** carrega mas
provavelmente não faz o que você quis, **custo** funciona e vai doer no export.

### Recusa a carga (erro)
1. Falta `meta.tipo` no manifesto, ou tipo desconhecido.
2. `params` declara tipo que não existe, ou nome de param que quebraria a
   variável CSS.
3. Chaves `{}` desbalanceadas no CSS.
4. `url()` ou `@import` de host externo.

### Avisa em amarelo (carrega, mas provavelmente não faz o que você quis)
5. `Math.random()`, `Date.now()`, `new Date()`, `performance.now()`.
6. `<canvas>`, `WebGL`, `THREE.`.
7. `font-family` sem nenhuma fonte do pacote na lista.
8. `backdrop-filter` sem nenhum slot declarado — sinal quase certo de que a
   pessoa espera desfocar o vídeo e não vai.
9. `fetch(`, `XMLHttpRequest`, `import()`.
10. `<style>` dentro do HTML do efeito (não passa pelo `CDATA`).
11. **Handler inline** (`onclick=`, `onload=`…). Nunca dispara: o palco é um
    iframe com sandbox sem `allow-scripts`, e o quadro é imagem estática. O
    navegador ainda reclama no console, o que faz o autor procurar defeito no
    lugar errado.

### Avisa em cinza (funciona, mas custa)
12. Mais de 500 elementos no HTML do efeito.
13. `blur`/`drop-shadow` com raio acima de 30px.
14. Efeito que cobre mais de 20% da duração do projeto.

**Ainda não checado:** `position: fixed`, `overflow: scroll`, `iframe` — o
comportamento deles dentro do `foreignObject` não foi testado, e avisar sobre o
que não se mediu seria adivinhação.

Cada aviso vem com uma **saída**, não só a regra: "é proibido" não ensina, "o
vídeo exportado vai tremer — use `rng()`" ensina.

---

## 7. Ainda não verificado

Não confie nestes itens até alguém medir:

- `position: fixed` e `position: sticky` dentro do `foreignObject`
- `overflow: scroll` com barra de rolagem
- `@container` queries
- CSS Houdini (paint worklets)
- `<video>` ou `<audio>` dentro do overlay
- emoji (dependem de fonte do sistema — provavelmente cai na regra 2.3)
- import de vídeo **com canal alpha** (o export não tem: os codecs em
  `exportPlan.ts` são H.264 e VP9 perfil 0, nenhum com alpha)

Achou algo que não está aqui? Mede, confere **na imagem** — não só num número —
e manda pra cá.

---

## 8. Um aviso sobre medir

Durante o levantamento deste documento, **seis medições deram resultado errado**,
todas da mesma família: comparavam "mudou alguma coisa?" em vez de "apareceu a
coisa certa?". As armadilhas concretas, porque elas vão se repetir:

- contar "pixels pintados" numa cena com **fundo opaco** — dá a tela inteira
  sempre, e não distingue nada
- comparar contra um controle sem checar se a versão "com" **desenha alguma
  coisa** — quem renderiza nada também difere do controle
- medir o **mesmo quadro** várias vezes: o navegador serve do cache de imagem e
  você cronometra o cache, não o render
- ler geometria com `offsetLeft`/`offsetTop`, que **ignoram `transform`**
- comparar brilho entre elementos com **quantidades diferentes de tinta**
  (uma palavra de 6 letras sempre "ganha" de uma de 5)

Quando for testar seu efeito, olhe o quadro. Um número que sobe não prova que o
que você queria apareceu.
