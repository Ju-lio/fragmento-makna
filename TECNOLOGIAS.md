# Fragmento — tecnologias e por que cada uma

Documento de referência: o que usamos em cada parte do editor e o motivo da
escolha. Escrito pra você conseguir explicar (ou defender) qualquer decisão
técnica do projeto sem precisar reabrir o código.

---

## Visão geral do stack

| Camada | Tecnologia | Por quê |
|---|---|---|
| Linguagem | **TypeScript** (`strict`) | O modelo de domínio (layer, efeito, projeto) é o que mais quebra em silêncio |
| Build/dev server | **Vite** | Start instantâneo, HMR real, zero config pra TS/TSX |
| UI | **React 19** | Só o chrome (painéis, timeline, botões) — nunca o canvas |
| Renderização | **Canvas 2D API** | Desenha texto, imagem e vídeo; é o que também vira export |
| Animação | Runtime próprio (JSON + easings) | Efeitos como dados, não código — geráveis sob demanda |
| Estilo | **CSS puro** (sem framework) | Design system pixel-art com bevels e paleta fixa |
| Fontes | `FontFace` API + arquivos `.ttf` locais | Canvas não carrega `@font-face` sozinho (ver seção própria) |
| Testes | **`node:test`** (nativo do Node) | Zero dependência extra; roda os `.ts` direto, por type stripping |
| Vídeo | Elemento `<video>` HTML | Decodificação fica a cargo do browser |
| Áudio (reprodução) | Elementos `<audio>`/`<video>` | Mesmo caminho do vídeo; o som do clipe sai do próprio elemento |
| Áudio (export) | **Web Audio API** (`OfflineAudioContext`) | Mixa mais rápido que tempo real e alinha as fontes sozinho |
| Export de vídeo | **WebCodecs** + `mp4-muxer` | Codifica quadro a quadro no próprio navegador, sem servidor |

Não usamos: Next.js (não tem servidor, não tem rotas), Redux/Zustand (o estado
que precisa de performance vive fora do React de propósito, ver abaixo),
Tailwind (o visual pixel-art é bevels e sombras duras — não é o forte de um
framework utilitário), FFmpeg.wasm (pesado demais pro que precisamos — o export
usa a API nativa `WebCodecs`).

---

## A decisão que mais importa: o motor não conhece o React

```
src/engine/    ← TypeScript puro. Zero import de React, zero JSX.
src/ui/        ← React. Só desenha os painéis e escuta os cliques.
```

Todo o "cérebro" do editor — o relógio de reprodução, o cálculo de onde cada
layer está no tempo, o zoom/pan do preview, a sincronia de vídeo — está em
`src/engine/`, sem nenhuma dependência de framework. O React entra só pra
desenhar formulários e botões.

**Por que isso importa na prática:** se um dia o React virar um estorvo (ou a
gente quiser portar pra outra coisa), a parte que tem valor de verdade sai
inteira, sem reescrever nada. E dá pra testar o motor inteiro rodando só
`node`, sem abrir navegador nenhum — é por isso que temos 376 testes automatizados
e zero configuração de ambiente de teste tipo Jest/Vitest com DOM simulado.

---

## Por que **não** é tudo React (a regra de performance)

Um editor de vídeo redesenha a tela a até 60 vezes por segundo. Se cada esses
frame passasse pelo ciclo normal do React (`setState` → re-render → diff →
DOM), o app engasgaria — é exatamente esse tipo de trava que te fez desistir
do CapCut.

A solução, em três peças que trabalham juntas:

1. **`player.ts`** — um relógio próprio, fora do React, com um único loop
   `requestAnimationFrame` pra aplicação inteira (nunca um por componente).
2. **Assinatura direta** — canvas, barra de progresso e timecode "assinam" o
   relógio e escrevem direto no DOM (`element.style.left = ...`) a cada frame.
   Dar play ou arrastar o cursor do tempo **não dispara nenhum re-render do
   React** — só sofre quem realmente precisa mudar.
3. **Frame "sujo"** — quando nada mudou (app parado, sem edição), o loop
   simplesmente não desenha nada. Editor parado não gasta CPU nem bateria do
   notebook.

O mesmo padrão se repete no zoom/pan do preview (`viewport.ts`): arrastar a
imagem pra reposicionar custa **zero renders** — é uma única `transform` CSS
escrita direto no elemento.

Onde o React continua sendo ótimo, a gente usa sem economia: formulários,
lista de layers, painel de efeitos. Ali a atualização é rara (você clicou em
algo) e o ganho de produtividade do React compensa.

---

## Canvas 2D: o coração visual

Tudo que aparece na composição — texto, imagem, vídeo — é desenhado num único
`<canvas>` via `drawFrame(ctx, project, t)`, em `renderer.ts`. Essa função é
**pura**: não lê relógio nem estado global, só recebe "qual projeto" e "que
instante" e desenha exatamente aquilo.

Essa pureza é proposital: é o que garante que o preview mostrado na tela seja
idêntico ao que vai sair no export de vídeo, porque os dois vão chamar essa
mesma função. Sem ela, seria fácil o preview mostrar uma coisa e o vídeo
exportado sair diferente — um bug clássico de editor caseiro.

### Por que Canvas 2D e não WebGL (por enquanto)

WebGL seria mais rápido pra efeitos pixel-a-pixel (é o que o chroma key vai
precisar). Mas desenhar **texto** em WebGL exige rasterizar numa textura de
qualquer jeito — ou seja, o ganho não existe pra layers de texto/imagem, só
pra vídeo com efeito de pixel.

Por isso o plano (ainda não implementado) é híbrido: vídeo com chroma key
passa por um canvas WebGL à parte (só ele, com um shader), e o resultado entra
no canvas 2D principal via `drawImage` — que é uma cópia rápida GPU→GPU.
Texto e imagem continuam simples, no 2D.

### O truque que resolveu o lag de reprodução: resolução física ≠ resolução exibida

Todo `<canvas>` tem dois tamanhos independentes: o **atributo** `width`/
`height` (quantos pixels físicos existem pra desenhar) e o **CSS** `width`/
`height` (quão grande ele aparece na tela). A confusão comum — que era
exatamente o nosso bug — é deixar os dois amarrados: canvas nasce do tamanho
do projeto (ex. 1920×1080) e um `transform: scale()` do CSS só encolhe
*visualmente* depois. O navegador ainda roda `drawImage`, `fillText` e
principalmente o filtro de desfoque em cima dos 1920×1080 pixels físicos
inteiros, mesmo que o resultado apareça do tamanho de um selo postal na tela.

A correção (`viewport.ts` → `renderScale()`, aplicado em `Stage.tsx`) separa
os dois de propósito: o atributo físico do canvas passa a ser calculado a
partir do quão grande ele **realmente aparece** (zoom × pixel density da
tela), enquanto o CSS continua fixo no tamanho lógico do projeto. A 25% de
zoom — o caso do dia a dia em notebook pequeno — isso corta o trabalho por
frame em ~16x, sem nenhuma perda visível, porque não dá pra enxergar detalhe
que você não está exibindo.

Pra isso não quebrar o posicionamento das layers (que são todas definidas em
pixels absolutos do projeto, tipo `size: 150`), `drawFrame` desenha sempre em
coordenadas **lógicas** e abre com um `ctx.scale()` que comprime isso pro
tanto de pixels físicos que o canvas realmente tem naquele momento. A mesma
função continua valendo pro export (que usa um canvas separado, na resolução
cheia) — o `ctx.scale()` ali vira 1:1 e não muda nada.

---

## O runtime de efeitos: por que é JSON, não código

Esse é o pilar que viabiliza o fluxo "eu peço um efeito no chat, colo o JSON,
funciona na hora". Um efeito parece com isto:

```json
{
  "name": "zoom-punch",
  "duration": 0.6,
  "tracks": [
    { "prop": "scale", "keys": [[0, 0.6], [0.55, 1.06], [1, 1]], "ease": "outQuint" }
  ]
}
```

Não existe `eval`, não existe código arbitrário rodando. O vocabulário de
`prop` é fechado (`x, y, scale, rotate, opacity, blur, brightness,
letterSpacing`) e o de `ease` também (14 curvas, todas em `easings.ts`). Isso
tem duas consequências boas:

- **Segurança:** colar um JSON gerado por mim nunca executa nada além de
  números sendo interpolados.
- **Portabilidade:** o mesmo vocabulário de props mapeia tanto pra Canvas 2D
  quanto pra CSS `transform`/`filter`. Se um dia quisermos um modo de preview
  via CSS puro (mais leve), os efeitos existentes continuam funcionando sem
  reescrever nada.

A composição entre efeitos (`effects.ts`) segue uma regra fixa: `scale`,
`opacity` e `brightness` **multiplicam**; o resto **soma**. É o que permite
empilhar "entra com zoom" + "flutua pra sempre" na mesma layer sem que um
efeito destrua o outro.

---

## Vídeo: `<video>` do browser, sincronizado manualmente

Não usamos nenhuma biblioteca de vídeo. Cada layer de vídeo é um elemento
`<video>` comum, criado via `document.createElement('video')` e nunca
inserido visualmente na página — ele só existe como fonte de frames pro
`drawImage` no canvas.

O ponto delicado é manter esse `<video>` sincronizado com o relógio do editor
(`player.ts`), porque são dois relógios diferentes por natureza. A lógica
(`videoSync.ts`) trata dois casos:

- **Tocando:** deixa o vídeo rodar com o próprio tempo interno (rodar
  suavemente é o forte do decoder do browser) e só corrige se ele desviar mais
  de 80ms do esperado — corrigir a cada frame trocaria suavidade por
  travamento.
- **Pausado/arrastando o cursor do tempo:** escreve a posição exata a cada
  vez, porque aqui precisão importa mais que suavidade.

Essa decisão (qual posição buscar, se deve tocar ou pausar) foi isolada numa
função pura, `videoSyncPlan`, exatamente pra poder ser testada sem precisar de
um navegador — o efeito colateral (mexer no elemento de verdade) fica isolado
em `syncVideoLayers`, que é só "burro" o suficiente pra aplicar o que a
função pura decidiu.

### Trim (corte de início/fim)

A matemática do corte também é isolada em funções puras (`trimLeft`,
`trimRight`, em `project.ts`), sem tocar em DOM. O detalhe que fizemos questão
de acertar: arrastar a borda **esquerda** do clipe move `start` (posição na
timeline) e `trimStart` (ponto de leitura no arquivo original) **juntos**, na
mesma quantidade — assim a imagem que já estava embaixo do cursor continua lá
enquanto você arrasta, em vez de escorregar. Arrastar a borda direita só muda
a duração.

---

## Fontes: por que existe um `fonts.ts` separado do CSS

Detalhe técnico que rendeu um bug real durante o desenvolvimento, vale
registrar o motivo: **`<canvas>` não carrega fontes declaradas em `@font-face`
sozinho.** O navegador só busca o arquivo de fonte quando algum elemento do
DOM efetivamente renderiza texto com ela — e como nosso texto vive dentro do
canvas (não é HTML), isso nunca acontecia. A fonte declarada em CSS ficava
"cadastrada" mas nunca baixada, e todo texto saía na fonte de sistema
(fallback).

A correção (`engine/fonts.ts`) carrega a fonte manualmente via `FontFace` API
e registra em `document.fonts`, então tanto o preview quanto o export
esperam essa promessa resolver antes de desenhar qualquer frame.

A fonte de exibição é **Inter Black**, reduzida (subsetting) só pro alfabeto
latino com `fonttools` — de ~340KB original pra 46KB no bundle final. A fonte
da interface (a "pixel-art" mesmo) é **Silkscreen**, do Google Fonts.

---

## Testes: por que `node:test` e não Jest/Vitest

Como o motor inteiro vive fora do React e não toca em DOM (exceto os poucos
pontos que manipulam `<video>` diretamente, que ficam isolados em funções
"burras"), dá pra testar tudo com o test runner que já vem dentro do Node —
sem instalar nada, sem configurar ambiente de DOM simulado.

Hoje são **376 testes** cobrindo:
- o runtime de efeitos (interpolação, composição, validação de JSON)
- o viewport (zoom ancorado no cursor, limites de pan, fit automático,
  cálculo de resolução física de render)
- o corte de vídeo (trim nas duas bordas, casos de borda como cortar até o
  limite do arquivo original)
- a decisão de sincronia de vídeo (tocar vs. pausar vs. corrigir desvio)
- a barra de atividade (não piscar em operação rápida, aparecer em espera
  longa, avisar o React só nas transições)
- o cache de frames (o que invalida e o que não invalida, descarte por
  memória, liberação de bitmaps, estimativa de capacidade, e as regras de
  qualidade entre frames capturados na reprodução e no pré-render)
- a marcação de trecho in/out (inversão, limites do projeto)
- a verificação de cobertura que decide entre "reproduz já" e "prepara antes"
  (um único buraco no meio reprova o trecho)
- a escolha da origem de cada quadro (o instante mostrado nunca anda pra trás;
  cache e render ao vivo nunca se misturam durante a reprodução)
- a posse dos elementos `<video>`, que impede o preview e o pré-render de
  disputarem o mesmo elemento
- a sincronia de som (deriva corrigida por andamento, seek só em evento) e a
  posse do elemento de mídia quando vários clipes saem do mesmo arquivo
- a mixagem do export (recorte de um trecho pelo meio de uma faixa, ganho,
  clipe esticado além do arquivo)
- as decisões do export que não dependem do navegador (dimensão par, timestamps,
  bitrate, intervalo de keyframe)

Rodar: `npm test`.

---

## O que falta (dependências previstas, ainda não usadas)

| Fase futura | Tecnologia prevista | Motivo |
|---|---|---|
| Chroma key | Shader **WebGL** (GLSL) | Operação por pixel — inviável em Canvas 2D puro |
