# Interface personalizável e temas de usuário

**Status:** adiado por decisão, não por dificuldade.
**Motivo do adiamento:** o visual atual não é o definitivo. UI, ícones e layout
ainda vão mudar bastante, e não faz sentido congelar num sistema de temas um
design que a gente ainda quer lapidar.

---

## O que é

Personalização **visual e controlada**, não programável. A pessoa escolhe, não
escreve código:

- paleta de cores
- fonte da interface
- aparência do botão → aplica em todos os botões
- aparência das faixas da timeline

A diferença pro sistema de efeitos é essa: efeito é aberto e a pessoa programa;
tema é fechado e a pessoa escolhe. São públicos e riscos diferentes, e não
devem compartilhar mecanismo.

## Decisões tomadas

**1. O tema é do USUÁRIO, não do projeto.** Fica em `localStorage`, **fora do
`.frag`**.

O motivo: tema é preferência de quem edita, não conteúdo do vídeo. Se fosse pro
arquivo do projeto, abrir o projeto de outra pessoa reconfiguraria a sua
interface — que é claramente errado.

**2. Tem que ser exportável.** Um arquivo próprio, separado do projeto, pra
quando existir conta e comunidade os temas poderem ser salvos e compartilhados.
Formato mínimo, no espírito do resto do projeto (JSON puro, sem código):

```json
{
  "formato": 1,
  "nome": "Menta Noturna",
  "autor": "julio",
  "cores": { "void": "#0e1a17", "gold": "#7de0b0", "coral": "#e2615c" },
  "fonte": { "ui": "Silkscreen" }
}
```

Só as cores-base entram. As variantes (claro, escuro, hover) são **derivadas** —
ver a armadilha abaixo. Isso mantém o arquivo pequeno, e impede um tema de
chegar internamente inconsistente.

**3. Se um dia a decisão 1 for revertida**, o que muda é
[`serialize.ts`](../src/engine/serialize.ts) e o formato do `.frag`. Hoje nada
no motor sabe o que é tema, e é bom que continue assim.

## O estado atual — por que é barato depois

Medido em 22/08/2026:

| | |
|---|---|
| usos de `var(--cor)` nos CSS | 176 |
| cores literais fora da paleta | ~20 |
| cores hardcoded nos componentes React | **0** |
| cores decididas em JS | 1 — e é o fundo do *projeto*, não da UI |
| declarações de `font-family` | 3 |

O `:root` do [`pixel.css`](../src/styles/pixel.css) já é uma camada de tokens de
verdade: 18 variáveis de cor mais `--u: 4px`. Trocar a paleta inteira é editar
um bloco de 25 linhas, não caçar hex por 12 mil linhas de componente.

**Zero cor em TSX** é o número que decide. É por isso que isso não é nuclear.

## A armadilha — a única parte que fica cara esperando

Os ~20 vazamentos são quase todos a mesma coisa: os **realces dos bevels**
pixel-art, escritos à mão. `#ffe08a` aparece 4 vezes — é o "dourado claro" do
relevo de `--gold`.

```css
/* hoje */
.btn-gold { box-shadow: inset 2px 2px 0 #ffe08a, inset -2px -2px 0 var(--gold-d); }
```

O problema não é o vazamento. É o que ele causa **quando o tema existir**: a
pessoa escolhe roxo, o botão fica roxo, e o realce continua dourado. **Todo tema
customizado nasce quebrado** — e isso só aparece depois de a UI de temas inteira
estar pronta, que é o pior momento possível pra descobrir.

A correção é derivar em vez de escrever:

```css
--gold-hi: color-mix(in srgb, var(--gold), white 40%);
--gold-d:  color-mix(in srgb, var(--gold), black 30%);
```

Aí a paleta vira mesmo fonte única: uma cor escolhida gera o relevo correto
sozinha. É uma tarde de trabalho, mecânica, verificável no olho, e **não depende
de nenhuma decisão de design** — dá pra fazer antes de o visual estar definido,
porque não muda a aparência atual, só a forma de escrevê-la.

`color-mix()` é nativo e o editor já é Chrome-only por causa do WebCodecs (ver
[`exportPlan.ts`](../src/engine/exportPlan.ts)), então não há problema de
suporte.

## O que fica de fora do escopo

**Tamanho e densidade** ("botão maior", "faixas mais altas", "modo compacto").
`--u` é usado só **10 vezes** contra **271 px literais** em `layout.css` — essa
sim seria refatoração de verdade, bem maior que a de cor.

E é o item que ninguém pede: CapCut não tem, Premiere não tem. Fica fora até
alguém reclamar.

## Para deixar de estar adiado

O design da interface precisa estar estabilizado — ícones, layout e componentes
decididos. Enquanto estiverem em movimento, um sistema de temas só multiplica o
trabalho de cada mudança visual.
