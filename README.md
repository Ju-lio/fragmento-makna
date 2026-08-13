# Motion Editor

Editor de motion graphics no browser, com estética pixel-art e efeitos definidos
como **dados** (JSON) em vez de código — pra que efeitos novos possam ser gerados
sob demanda e colados direto na interface.

```bash
npm install
npm run dev      # desenvolvimento
npm test         # testes do runtime de efeitos
npm run build    # build de produção
```

## Arquitetura

A regra que sustenta tudo: **o engine não conhece o React.**

```
src/
  engine/          <- JS puro, zero dependência de framework
    easings.js       curvas de aceleração
    effects.js       runtime: sampleTrack, effectProgress, resolveState
    renderer.js      drawFrame(ctx, project, t) — função pura
    player.js        relógio + loop rAF (fora do React de propósito)
    presets.js       biblioteca inicial + doc do schema
    project.js       modelo de dados
    fonts.js         carga explícita da fonte do canvas
  ui/              <- React: só o chrome da interface
  styles/          <- design system pixel
```

Se um dia o React virar estorvo, a parte valiosa sai inteira sem alteração.

### Performance

Três decisões deliberadas:

1. **O playhead não é estado do React.** Canvas, barra de playhead e timecode
   assinam o `player` e escrevem direto no DOM. Dar play ou arrastar o playhead
   causa **zero re-render** do React.
2. **Um único loop `requestAnimationFrame`** pro app inteiro, nunca um por
   componente.
3. **Frame sujo:** parado e sem mudanças, o loop não desenha nada. Editor ocioso
   não gasta CPU.

### Preview = Export

`drawFrame(ctx, project, t)` é função pura de `(projeto, tempo)` — não lê relógio
nem estado global. É o que vai permitir que o exportador futuro produza exatamente
o que o preview mostra, rodando o mesmo código quadro a quadro.

Cuidado já resolvido: **canvas não dispara carregamento de `@font-face`.** O
browser só busca a fonte quando um nó do DOM a usa, então uma fonte usada só no
canvas nunca carregaria. Por isso `fonts.js` carrega explicitamente via `FontFace`,
e o export espera por ela antes de desenhar.

## Efeitos

Um efeito é JSON declarativo — sem `eval`, sem código arbitrário:

```json
{
  "name": "zoom-punch",
  "duration": 0.6,
  "tracks": [
    { "prop": "scale",   "keys": [[0, 0.6], [0.55, 1.06], [1, 1]], "ease": "outQuint" },
    { "prop": "opacity", "keys": [[0, 0], [0.3, 1]],               "ease": "outQuad" }
  ]
}
```

`keys` usa tempo normalizado (0 a 1), então o mesmo efeito funciona em qualquer
duração.

**Props:** `x`, `y`, `scale`, `rotate`, `opacity`, `blur`, `brightness`, `letterSpacing`.
O vocabulário é fechado de propósito: são exatamente as props que mapeiam tanto pra
CSS quanto pra canvas, o que garante que preview e export nunca divirjam.

**Composição:** `scale`, `opacity` e `brightness` multiplicam; o resto soma. É o que
permite empilhar vários efeitos na mesma layer sem que briguem.

### Fluxo de trabalho

1. Botão **SCHEMA** copia a documentação completa do formato
2. Cola no chat pedindo o efeito que você quer
3. Cola o JSON de volta na aba **Efeitos**

O app entrega um *runtime*, não um catálogo — a biblioteca cresce sob demanda.

## Viewport

O preview tem zoom, fit e pan — pensado pra editar em tela pequena.

| Ação | Atalho |
|---|---|
| Zoom no cursor | `Ctrl` + scroll |
| Zoom in / out | `Ctrl` `+` / `Ctrl` `-` |
| Fit | `Ctrl` `0` |
| Pan | arrastar, ou scroll |
| Play / pause | `Espaço` |

O estado do viewport vive em `engine/viewport.js`, fora do React: arrastar
escreve uma única `transform` no DOM, sem re-render. Formatos disponíveis:
1920×1080, 1080×1920 (Reels/Shorts), 1080×1080, 1280×720 e custom.

## Status

**Pronto:** layers de texto e imagem, timeline com arrasto, runtime de efeitos,
9 presets, viewport com zoom/fit/pan, resolução de projeto, export de frame PNG.

**Próximo:** layers de vídeo com trim → chroma key (shader WebGL) → gizmo de
transform e crop → export de vídeo via WebCodecs → áudio (uma trilha na v1).
