# Uma tela de export

**Estado:** adiado, mas por pouco — falta massa crítica, não vontade.

---

## A pergunta

Vale a pena uma telinha pra configurar o export, em vez dos controles soltos na
barra?

## O que existe hoje

Duas decisões, e as duas já têm lugar:

- **o trecho** — marcado na própria timeline com `[ IN` e `OUT ]`, que é onde
  ele deve ser marcado mesmo: é uma decisão sobre o tempo, feita olhando o
  tempo.
- **a qualidade** — um seletor de três níveis ao lado do botão.

Uma tela pra duas decisões, sendo que uma delas nem caberia nela, é cerimônia
sem função: mais um clique pra chegar no mesmo lugar.

## Quando ela passa a valer

No momento em que existir uma terceira e uma quarta. As candidatas, em ordem de
probabilidade:

| decisão | por que ainda não existe |
|---|---|
| **resolução** | hoje o export é sempre a do projeto. Exportar 720p de um projeto 1080p é pedido comum |
| **fps** | idem — entregar 30 de um projeto 60 |
| **formato** | MP4 hoje; WebM já é a reserva automática, mas não é escolha |
| **só o vídeo / só o áudio** | pedido comum pra quem vai remixar |
| **nome do arquivo** | hoje é derivado do trecho |

Com quatro ou mais, os controles soltos viram poluição na barra e a tela passa a
organizar em vez de atrapalhar.

## O que ela precisaria mostrar (e não é a lista de campos)

O valor de uma tela de export não são os campos — é o **resumo antes de
apertar**:

- **tamanho aproximado do arquivo.** Já dá pra calcular:
  `tamanhoAproximado(bitrate, segundos)` existe em
  [`exportPlan.ts`](../src/engine/exportPlan.ts).
- **quanto tempo vai levar**, estimado pelo custo dos efeitos ativos. Um overlay
  cobrindo o quadro inteiro custa ~231 ms/quadro em 1080p; num vídeo de 60s isso
  é +7 minutos, e a pessoa merece saber ANTES.
- **o que vai ficar de fora** — faixa de áudio que não decodificou, efeito com
  erro. Hoje isso vira aviso depois, e ver depois é pior.

## Enquanto isso

O que resolveria a maior parte do incômodo sem tela nenhuma: **o aviso de custo
antes de exportar**, na barra mesmo. O validador já sabe calcular (ver
`avisoDeCobertura` em [`validador.ts`](../src/criar/validador.ts)); falta só
mostrar.
