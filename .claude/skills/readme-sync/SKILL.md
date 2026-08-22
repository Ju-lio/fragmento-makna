---
name: readme-sync
description: Mantém a documentação do projeto em dia com o código — README.md, `nativos/` (funcionalidades do editor), LIMITES.md (o que um efeito da comunidade pode fazer) e `ideias/` (o que foi adiado, com o motivo). Use SEMPRE ao terminar qualquer mudança neste projeto que altere comportamento, arquitetura, estrutura de arquivos, dependências, scripts do npm ou o schema de efeitos, e SEMPRE que entregar uma funcionalidade nativa nova — antes de dar a tarefa por concluída. Também use quando pedirem "atualiza o readme", "documenta isso" ou ao revisar se a documentação ainda bate com o código.
---

# Manter o README em dia

O README deste projeto não é uma lista de features: ele explica **por que** as
decisões difíceis são o que são. Vários trechos existem porque um bug custou
caro pra ser entendido, e a explicação é o que impede alguém (inclusive o
próprio autor, meses depois) de "simplificar" a correção e trazer o bug de
volta.

Então a regra não é "escreveu código, escreveu parágrafo". É: **o README nunca
pode descrever um sistema que não existe mais.**

## Quando atualizar

Ao terminar uma mudança, percorra esta lista. Se qualquer item bateu, o README
entra na mesma tarefa — não numa próxima.

| Mudou | Seção que provavelmente desatualizou |
|---|---|
| Arquivos criados, renomeados ou removidos em `src/` | árvore de `## Arquitetura` |
| Comportamento de reprodução, cache, seek ou pré-render | `## Performance do preview`, `## Cache automático`, `## Pré-render` |
| Um bug corrigido cuja causa não é óbvia no código | seção própria, no formato "sintoma → causa → por que a correção é essa" |
| `package.json` (scripts, dependências) | bloco `bash` do topo |
| Schema de efeitos, props ou easings | `## Efeitos` **e** `SCHEMA_DOC` em `src/engine/presets.ts` |
| Uma feature saiu do "Próximo" e ficou pronta | `## Status` (mover entre as listas, não só adicionar) |
| Tipos do domínio (`src/engine/types.ts`) | `## Arquitetura`, se a mudança for estrutural |
| **Uma funcionalidade NATIVA nova, ou mudou como uma existente se usa** | **um arquivo em `nativos/`** — ver abaixo |
| O que um efeito da comunidade pode ou não fazer | `LIMITES.md` |
| Uma decisão de adiar algo, com motivo | `ideias/` |

Mudança que **não** pede README: refactor sem efeito observável, ajuste de
estilo, teste novo pra comportamento já documentado, correção de digitação.

## Funcionalidades nativas: `nativos/`

**Toda funcionalidade nativa entregue ganha um arquivo em `nativos/`, na mesma
tarefa.** Nativa é o que o *editor* faz, em oposição ao que a *comunidade*
escreve — chroma key, corte, gizmo, export, o painel de efeitos.

Vale a pena separar do README porque são leituras diferentes: o README explica
como o motor funciona por dentro; `nativos/` explica o que a funcionalidade faz
e por que ela é nativa em vez de ser um efeito.

O contrato de cada arquivo está em [`nativos/README.md`](../../../nativos/README.md)
— resumindo: o que resolve, como se usa, **por que é nativo e não efeito**, a
alternativa descartada com números, onde vive no código, e os limites
conhecidos ditos na cara.

Três coisas que se erram fácil:

1. **Atualizar o índice** no fim de `nativos/README.md`.
2. **Marcar o estado** no topo do arquivo: implementado, parcial ou planejado.
   Um arquivo que diz "implementado" e não está é pior que arquivo nenhum.
3. **Não duplicar o README.** Se a explicação profunda do mecanismo já está lá,
   `nativos/` aponta pra ela em vez de repetir — duas cópias divergem.

## Como escrever

O README já tem uma voz. Siga-a em vez de inventar outra:

- **Português, direto, sem marketing.** Nada de "poderoso", "robusto",
  "moderno".
- **Comece pelo problema, não pela solução.** "O bug mais difícil desta fase: a
  reprodução pulava pra frente e voltava" é melhor que "Implementado sistema de
  posse de elementos de vídeo".
- **Explique a alternativa descartada.** O valor está em saber por que o
  caminho óbvio não funciona — é isso que evita a regressão.
- **Números concretos.** "~8 MB por frame a 1920×1080", "teto de 320 MB", não
  "consome bastante memória".
- **Sem tabela de API.** O código é a referência; o README é o raciocínio.
- Trechos de código só quando o formato não for adivinhável (JSON de efeito,
  por exemplo).

## Antes de fechar

1. A árvore de arquivos em `## Arquitetura` bate com `ls src/engine src/ui`?
   Confira de verdade — é o trecho que mais silenciosamente apodrece.
2. Os comandos do bloco `bash` do topo existem em `package.json`?
3. Todo caminho de arquivo citado no texto existe, com a extensão certa?
4. `## Status` ainda descreve o estado real do projeto?

## Verificação

```bash
npm run typecheck   # tsc --noEmit
npm test
npm run lint
```

Se o README passou a citar um script, rode-o antes de afirmar que ele funciona.
