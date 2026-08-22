# Funcionalidades nativas

O que o **editor** faz, em oposição ao que a **comunidade** escreve.

A separação importa porque as duas coisas têm públicos e garantias diferentes:

| | nativo | efeito da comunidade |
|---|---|---|
| quem faz | nós | qualquer pessoa que saiba CSS |
| linguagem | TypeScript, dentro do motor | HTML + CSS + TS, num pacote |
| interface | UI própria (conta-gotas, sliders, gizmo) | campos gerados de `params` |
| garantia | funciona igual pra todo mundo, sempre | vale o que o autor fez |
| onde documenta | **aqui** | [LIMITES.md](../LIMITES.md) |

Uma funcionalidade é nativa quando pelo menos uma destas é verdade:

1. **Precisa de UI que o sistema de efeitos não sabe desenhar** — conta-gotas
   no vídeo, arrastar alça no palco, desenhar um traçado.
2. **Precisa de decisão condicional por pixel** — CSS e filtro SVG não têm
   `if`. Foi o que empurrou o chroma key pra cá.
3. **Todo mundo espera que exista** e precisa funcionar igual em qualquer
   projeto. Corte, trim, undo, export.
4. **Mexe no modelo do projeto** — vira campo de layer, entra no `.frag` e na
   assinatura do cache.

---

## O que um arquivo daqui precisa ter

Segue a voz do README: **começa pelo problema, não pela solução.** O valor está
em quem lê meses depois entender por que o caminho óbvio não foi usado.

1. **O que resolve**, em uma frase, do ponto de vista de quem edita vídeo.
2. **Como se usa** — os controles, e o que cada um faz.
3. **Por que é nativo e não efeito** — qual dos quatro critérios acima bateu.
4. **A alternativa descartada, com o motivo.** Se houve medição, os números.
5. **Onde vive no código** — arquivos, e o que cada um decide.
6. **Limites conhecidos** — o que a funcionalidade não faz, dito na cara.

Números concretos, sem marketing. "737 px de franja verde contra 0 da
referência", não "qualidade superior".

## Estado

Cada arquivo abre dizendo o que é: **implementado**, **parcial** ou
**planejado**. Um doc de funcionalidade planejada é legítimo aqui quando a
decisão já foi tomada e medida — o que se perde primeiro é o motivo, não o
código.

## Aqui dentro

- [chroma-key.md](chroma-key.md) — planejado · recortar fundo verde
- [efeitos.md](efeitos.md) — parcial · o painel de efeitos e os controles gerados
- [criar.md](criar.md) — parcial · a página de criar efeito
- [efeitos-html-css.md](efeitos-html-css.md) — parcial · efeito da comunidade na linha do tempo
