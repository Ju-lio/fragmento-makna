# Painel de efeitos

**Estado:** parcial. Os controles gerados de esquema funcionam; o formato de
efeito em HTML/CSS ainda não existe (fases B em diante do
[PRIORIDADES.md](../PRIORIDADES.md)).

## O que resolve

Aplicar um efeito numa layer e **ajustá-lo sem editar JSON**.

Até aqui, mudar a duração de um efeito aplicado — a coisa mais comum que se
quer fazer depois de aplicar — exigia clicar em ✎, editar o JSON no textarea e
adicionar de novo. Agora o efeito abre com controles.

## Como se usa

Aba **EFEITOS**, com uma layer selecionada.

| ação | o que faz |
|---|---|
| clicar num **preset** | adiciona o efeito à layer e pula o cursor pro início dela, pra você ver disparar |
| clicar no **nome** do efeito | abre e fecha os controles |
| **Duração** / **Atraso** | slider pra tatear, campo numérico pra cravar. Em segundos |
| **Âncora** | `start` = animação de entrada · `end` = de saída, ancorada no fim da layer |
| **Repetir** | recomeça pra sempre enquanto a layer estiver na tela |
| **✎** | carrega o efeito no textarea como JSON — o caminho antigo, ainda vivo |
| **✕** | remove |

Os selos no chip (`loop`, `out`) refletem o estado, então dá pra ver o que cada
efeito faz sem abrir.

## Por que é nativo e não efeito

Não é uma funcionalidade "aplicada" a nada — **é o painel onde os efeitos dos
outros vão aparecer**. É a moldura, não o quadro.

O detalhe que importa pro futuro: os campos **não são escritos à mão**. Eles
nascem de um esquema (`ESQUEMA_JANELA`) percorrido por
[`CamposDeParams`](../src/ui/CamposDeParams.tsx), que não sabe o que é um
efeito. É exatamente o mesmo caminho que um efeito de terceiro vai usar pra
ganhar painel — só que o esquema virá do pacote dele em vez de vir daqui.

A janela de tempo foi escolhida como primeira cobaia de propósito: já existia,
já era editada, e se o esquema não desse conta nem dela não daria conta de
nada.

## Decisões de desenho

**Slider *e* campo numérico, lado a lado, quando o param tem `min` e `max`.**
O slider sozinho não deixa digitar valor exato; o número sozinho não deixa
*tatear* — e efeito se ajusta tateando, arrastando e olhando o palco. Sem faixa
declarada, sobra só o campo: um slider sem limites não significa nada.

**Botões, não `<select>`, pras opções.** A lista é curta por natureza (é uma
escolha de efeito, não um país), e ver tudo de uma vez é mais rápido que abrir
menu. Mesmo espírito dos swatches de cor no PROPS.

**Arrastar slider funde no histórico; clicar em botão, não.** Um gesto contínuo
vira UM passo de undo, senão o Ctrl+Z desfaz pixel a pixel. É o `coalesce` que
[`history.ts`](../src/engine/history.ts) já expunha.

**Campos no padrão são omitidos do efeito.** `delay: 0` e `anchor: 'start'` são
exatamente o que a ausência já significa; escrevê-los incharia todo efeito
colado e o `.frag` carregaria isso pra sempre. É por isso que `comJanela`
**remove** o campo em vez de gravar o valor padrão.

## Onde vive no código

| arquivo | o que decide |
|---|---|
| [`src/criar/api.ts`](../src/criar/api.ts) | o contrato: tipos de param, validação, normalização |
| [`src/criar/janela.ts`](../src/criar/janela.ts) | o esquema da janela de tempo, e a conversão efeito ↔ valores (puro) |
| [`src/ui/CamposDeParams.tsx`](../src/ui/CamposDeParams.tsx) | esquema → controles. Não conhece efeito |
| [`src/ui/EffectsPanel.tsx`](../src/ui/EffectsPanel.tsx) | a lista, os presets e o textarea de JSON |

O raciocínio do runtime de efeitos (props, composição, easings) está no
`## Efeitos` do [README](../README.md) — não é repetido aqui.

## Limites conhecidos

- **Só a janela de tempo é editável por controle.** As `tracks` (o que anima, e
  como) continuam só por JSON. Um editor de curvas é outra funcionalidade.
- **Não dá pra reordenar efeitos** na lista. A ordem importa pouco hoje, porque
  a composição é por soma e multiplicação — mas vai importar quando existir
  efeito que substitui em vez de compor.
- **Sem duplicar efeito.** Adicionar o mesmo preset duas vezes funciona, mas
  copiar um já ajustado, não.
