# Configurações: as do PROJETO e as do EXPORT

**Estado:** adiado, mas por falta de massa crítica, não de necessidade. Uma
parte já existe; a outra não tem controle nenhum.

---

## A distinção que importa

São dois conjuntos, e hoje eles são a mesma coisa:

**Configuração do PROJETO** — o que o *editor* obedece. O cursor anda na grade
dela, a seta avança um quadro dela, o decodificador pede o quadro pelo número
dela. Errar aqui não é cosmético: é o preview mostrando um instante que o
arquivo não tem.

**Configuração do EXPORT** — o que sai no arquivo. Pode legitimamente diferir:
montar em 1080p60 e entregar 720p30 é pedido comum.

Hoje o export **sempre** usa a resolução e o fps do projeto. Não há como
separá-los.

## O que já existe

| | onde | editável? |
|---|---|---|
| resolução do projeto | [`StageBar.tsx`](../src/ui/StageBar.tsx) — presets e largura/altura à mão | **sim** |
| fps do projeto | `project.fps`, no modelo | **não** — nasce 30 e fica |
| qualidade do export | seletor ao lado do botão | sim |
| resolução do export | — | não: é sempre a do projeto (`scale: 1`) |
| fps do export | — | não: é sempre `project.fps` |

## O buraco maior: o fps não tem controle

`project.fps` já é lido em toda parte, e cada um desses lugares muda de
comportamento com ele:

- [`player.ts`](../src/engine/player.ts) — a grade do cursor (`frameIndexAt`),
  o passo de quadro pelas setas, e `setFps`, que **já existe e ninguém chama
  com outro valor**
- [`videoFrames.ts`](../src/engine/videoFrames.ts) — de qual número de quadro o
  decodificador é servido
- [`prerender.ts`](../src/engine/prerender.ts) e
  [`videoExport.ts`](../src/engine/videoExport.ts) — a grade em que os quadros
  são gerados
- [`exportPlan.ts`](../src/engine/exportPlan.ts) — bitrate e intervalo de
  keyframe escalam com ele

Ou seja: o encanamento está pronto, **falta o controle e a decisão de onde ele
mora**. Um projeto filmado a 24 ou a 60 hoje é montado numa grade de 30, e o
preview não bate quadro a quadro com a fonte.

## Por que ainda não tem tela

Uma tela pra duas decisões — e uma delas, o trecho, se marca na própria
timeline olhando o tempo — é cerimônia sem função: mais um clique pra chegar no
mesmo lugar.

Ela passa a valer quando existirem **quatro ou mais**: resolução do export, fps
do export, formato (MP4/WebM), e "só vídeo / só áudio". Aí os controles soltos
viram poluição na barra e a tela organiza em vez de atrapalhar.

## O que a tela precisaria mostrar — e não é a lista de campos

O valor real é o **resumo antes de apertar**:

- **tamanho aproximado.** Já dá pra calcular: `tamanhoAproximado(bitrate,
  segundos)` existe em [`exportPlan.ts`](../src/engine/exportPlan.ts).
- **quanto tempo vai levar**, estimado pelo custo dos efeitos ativos. Um overlay
  cobrindo o quadro inteiro custa ~231 ms/quadro em 1080p; num vídeo de 60s isso
  é +7 minutos, e a pessoa merece saber ANTES.
- **o que vai ficar de fora** — faixa de áudio que não decodificou, efeito com
  erro. Hoje isso vira aviso *depois*, e depois é tarde.

## A ordem, quando for a hora

1. **fps do projeto**, com controle na StageBar ao lado da resolução. É o que
   falta pro editor ser correto, e não depende de tela nenhuma.
2. **Aviso de custo antes de exportar**, na barra mesmo. `avisoDeCobertura` em
   [`validador.ts`](../src/criar/validador.ts) já calcula; falta mostrar.
3. **Resolução e fps de saída** separados dos do projeto. Aqui já são quatro
   decisões — é onde a tela nasce.
4. **Formato e faixas.**

O passo 1 é o único que é correção; o resto é conveniência.
