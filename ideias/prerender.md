# Pré-render: play liso na segunda vez

**Estado:** adiado por decisão. O código existe e está desligado.
**Motivo do adiamento:** o preview ao vivo já está bom o suficiente — trava nas
primeiras passadas e roda liso da segunda em diante, que é o comportamento
normal de editor. E religar isso exige uma correção que não é pequena.

---

## O que seria

Quando você dá play num trecho novo, o editor engasga enquanto decodifica e
rasteriza. A ideia:

1. **Segurar o play** até o trecho estar pronto, em vez de tocar engasgando.
2. **Uma barrinha sobre a timeline** mostrando o que já está renderizado —
   assim dá pra saber, antes de apertar play, se vai rodar liso.

## Por que está desligado

Não é falta de código: `PrerenderBar`, `frameCache`, `ensureRangeCached` e a
barra existem. O interruptor é `PREVIEW_CACHE_ENABLED` em
[`frameSource.ts`](../src/engine/frameSource.ts), e o comentário lá explica:

> O cache guarda quadros **em que o vídeo não foi desenhado**. `drawFrame` marca
> `degraded` por dois motivos que não têm nada a ver um com o outro: o desfoque
> foi pulado (aproximação cosmética) ou o quadro não chegou — e aí o que foi
> guardado é uma composição SEM o clipe.

E ficou pior desde então: **o overlay virou uma terceira causa** de `degraded`,
também do tipo "incompleto". Hoje as três moram no mesmo booleano.

## O pré-requisito, que é o trabalho de verdade

**Separar `degraded` em duas etiquetas:**

| etiqueta | causa | pode ir pro cache? |
|---|---|---|
| `aproximado` | desfoque pulado no modo rápido | sim — é a mesma imagem, só mais barata |
| `incompleto` | quadro de vídeo ou de overlay ausente | **nunca** |

Com as duas separadas, o cache aceita a primeira e recusa a segunda, e aí ele
para de mentir. Sem isso, religar o cache traz de volta a piscada na emenda
entre clipes — que foi o que motivou desligá-lo.

Toca: [`renderer.ts`](../src/engine/renderer.ts) (devolve dois campos em vez de
um), [`frameCache.ts`](../src/engine/frameCache.ts), [`prerender.ts`](../src/engine/prerender.ts),
[`Stage.tsx`](../src/ui/Stage.tsx) e [`frameSource.ts`](../src/engine/frameSource.ts).

## A sequência, quando for a hora

1. Separar as duas etiquetas. É o passo que destrava o resto.
2. Religar `PREVIEW_CACHE_ENABLED`, agora com o cache recusando o incompleto.
3. A barra sobre a timeline — o componente já sabe desenhar.
4. Segurar o play até o trecho estar pronto. O `player` já tem `fromCache`;
   falta a decisão de esperar antes de começar.

## Para deixar de estar adiado

Quando o preview engasgar a ponto de atrapalhar de verdade, ou quando o custo
dos efeitos em HTML/CSS subir (um overlay pesado cobrindo o vídeo inteiro é o
pior caso medido: ~231 ms/quadro em 1080p — ver [LIMITES.md](../LIMITES.md) §5).
Aí o pré-render deixa de ser conforto e vira necessidade.
