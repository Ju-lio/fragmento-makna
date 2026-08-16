# FRAGMENTO — AI DEVELOPMENT RULES

Você está trabalhando no desenvolvimento do Fragmento, um editor de vídeo baseado na web.

Seu objetivo não é simplesmente produzir código.

Seu objetivo é produzir código FUNCIONAL, TESTADO, ESTÁVEL, PERFORMÁTICO e CONSISTENTE com a arquitetura existente.

---

# 1. REGRA PRINCIPAL

NUNCA considere uma tarefa concluída apenas porque o código foi escrito.

Código escrito ≠ funcionalidade concluída.

Uma funcionalidade somente pode ser considerada concluída depois de:

1. Analisar a implementação existente.
2. Planejar a alteração.
3. Implementar.
4. Executar testes.
5. Executar smoke tests.
6. Verificar erros de console/runtime.
7. Verificar o comportamento real da funcionalidade.
8. Verificar possíveis regressões.
9. Corrigir todos os problemas encontrados.
10. Executar os testes novamente.
11. Confirmar que a implementação está estável.

---

# 2. CICLO OBRIGATÓRIO DE DESENVOLVIMENTO

Para cada tarefa, siga este ciclo:

ANALISAR
↓
PLANEJAR
↓
IMPLEMENTAR
↓
TESTAR
↓
DEBUGAR
↓
CORRIGIR
↓
TESTAR NOVAMENTE
↓
VALIDAR REGRESSÕES
↓
CONCLUIR

NÃO pule diretamente de IMPLEMENTAR para CONCLUIR.

---

# 3. ANTES DE ALTERAR O CÓDIGO

Antes de modificar arquivos importantes:

* Leia o código relacionado à tarefa.
* Identifique os componentes envolvidos.
* Identifique estados compartilhados.
* Identifique dependências.
* Identifique efeitos colaterais possíveis.
* Identifique funcionalidades que podem ser afetadas.
* Entenda como a arquitetura atual funciona.

Não faça alterações grandes baseadas em suposições.

Se não entender uma parte importante do sistema, investigue antes de alterá-la.

---

# 4. IMPLEMENTAÇÃO INCREMENTAL

Prefira mudanças pequenas e verificáveis.

Não implemente várias funcionalidades independentes simultaneamente.

Quando uma tarefa possuir várias etapas:

1. Implemente uma etapa.
2. Teste.
3. Corrija.
4. Valide.
5. Só então avance.

Não acumule vários pontos de falha para testar somente no final.

---

# 5. TESTES

Depois de qualquer alteração significativa, execute os testes relevantes.

Verifique:

* aplicação inicia corretamente;
* build funciona;
* não existem erros de runtime;
* não existem erros relevantes no console;
* funcionalidade alterada funciona;
* funcionalidades relacionadas continuam funcionando;
* estados são atualizados corretamente;
* dados não são perdidos;
* interações funcionam corretamente.

Sempre que possível, teste tanto o caminho esperado quanto situações inesperadas.

---

# 6. SMOKE TESTS

Após alterações importantes, execute smoke tests.

O smoke test deve verificar rapidamente se o sistema principal continua funcionando.

No Fragmento, considere pelo menos:

* aplicação inicia;
* projeto carrega;
* interface principal renderiza;
* mídia pode ser importada;
* timeline aparece;
* preview funciona;
* play/pause funciona;
* playhead funciona;
* seleção funciona;
* operações básicas da timeline continuam funcionando.

Adicione testes específicos dependendo da funcionalidade alterada.

---

# 7. NÃO IGNORE ERROS

Nunca ignore um erro simplesmente porque ele parece não estar relacionado.

Quando encontrar um erro:

1. Investigue.
2. Determine a origem.
3. Determine se foi causado pela alteração atual.
4. Corrija se estiver relacionado.
5. Se não estiver relacionado, informe claramente.
6. Verifique se ele impede a validação da tarefa.

NUNCA esconda erros para conseguir declarar uma tarefa como concluída.

---

# 8. NÃO DEIXE BUGS CONHECIDOS PARA TRÁS

Se uma implementação criou um problema conhecido, corrija antes de avançar sempre que possível.

Não faça:

"Existe um erro, mas podemos continuar e corrigir depois."

Prefira:

"Existe um erro. Vamos investigar e corrigir antes de continuar."

Evite acumular dívida técnica durante uma implementação.

---

# 9. DEBUGGING

Quando algo não funcionar:

NÃO chute.

Use evidências.

Investigue:

* stack trace;
* console;
* estado atual;
* fluxo de dados;
* eventos;
* listeners;
* chamadas de função;
* dependências;
* timing;
* lifecycle;
* estado compartilhado.

Formule uma hipótese.

Teste a hipótese.

Depois corrija.

---

# 10. TESTE DE REGRESSÃO

Sempre considere o que pode ter quebrado.

Uma alteração em um sistema compartilhado pode afetar outros sistemas.

Antes de concluir:

* teste a funcionalidade alterada;
* teste funcionalidades diretamente relacionadas;
* teste o fluxo principal;
* procure regressões óbvias.

Quanto maior a alteração, maior deve ser a abrangência do teste.

---

# 11. NÃO REESCREVER SEM NECESSIDADE

Não reescreva componentes funcionais simplesmente porque existe uma solução teoricamente melhor.

Antes de uma grande refatoração:

1. explique o problema;
2. explique por que a mudança é necessária;
3. identifique o impacto;
4. prefira a menor mudança estrutural capaz de resolver o problema.

Evite refatorações gigantes quando uma alteração localizada for suficiente.

---

# 12. PERFORMANCE

Performance é uma prioridade no Fragmento.

O editor deve permanecer responsivo principalmente durante:

* playback;
* scrub;
* drag;
* resize;
* movimentação do playhead;
* atualização da timeline;
* interação com múltiplas layers.

Evite trabalho desnecessário em operações de alta frequência.

Tenha cuidado com:

* renders desnecessários;
* listeners duplicados;
* loops desnecessários;
* atualizações excessivas de estado;
* cálculos pesados por frame;
* criação repetida de objetos;
* operações síncronas pesadas;
* processamento desnecessário durante playback.

Não sacrifique performance sem necessidade.

---

# 13. SISTEMAS CRÍTICOS DO FRAGMENTO

Considere estes sistemas como altamente interdependentes:

* timeline;
* playhead;
* playback;
* preview;
* layers;
* seleção;
* drag;
* resize;
* duração;
* cortes;
* áudio;
* vídeo;
* thumbnails;
* seek;
* FPS;
* tempo atual;
* duração total;
* undo/redo;
* importação;
* gerenciamento de arquivos;
* persistência;
* estado do projeto.

Alterações nesses sistemas exigem atenção especial a regressões.

---

# 14. ARQUIVOS E DADOS

Não destrua dados existentes durante testes.

Antes de operações potencialmente destrutivas:

* confirme o comportamento;
* preserve dados quando necessário;
* evite apagar arquivos sem necessidade.

Não introduza comportamento destrutivo sem motivo explícito.

---

# 15. TESTE DE CASOS EXTREMOS

Quando fizer sentido para a funcionalidade, considere:

* valores vazios;
* valores inválidos;
* arquivos inexistentes;
* arquivos grandes;
* múltiplas ações consecutivas;
* ações muito rápidas;
* duplicação;
* remoção;
* undo;
* redo;
* reload;
* mudança de estado durante operação;
* carregamento incompleto;
* dados ausentes;
* componentes desmontando;
* concorrência;
* race conditions.

Não é necessário testar casos irrelevantes, mas não ignore casos extremos óbvios.

---

# 16. SUBAGENTES

Quando subagentes estiverem disponíveis, use-os de forma estratégica.

Use subagentes para tarefas independentes que possam ser analisadas em paralelo, como:

* investigação;
* análise de código;
* identificação de possíveis bugs;
* revisão;
* testes;
* análise de performance.

Não delegue uma tarefa crítica sem depois revisar o resultado.

O agente principal continua responsável pela integração e validação final.

---

# 17. NÃO INVENTE RESULTADOS

Nunca diga que um teste passou se ele não foi executado.

Nunca diga que algo foi verificado se não foi realmente verificado.

Se uma ferramenta ou teste não puder ser executado:

informe claramente:

"Não foi possível executar X."

Não invente resultados.

---

# 18. CRITÉRIO DE CONCLUSÃO

Uma tarefa NÃO está concluída quando:

* o código compila;
* o arquivo foi alterado;
* a implementação parece correta.

Uma tarefa está concluída quando:

* implementação foi realizada;
* testes relevantes foram executados;
* smoke tests foram executados;
* erros relevantes foram investigados;
* problemas encontrados foram corrigidos;
* regressões relevantes foram verificadas;
* comportamento esperado foi validado.

---

# 19. RELATÓRIO FINAL

Ao finalizar uma tarefa, responda resumidamente:

## Implementado

O que foi alterado.

## Testado

Quais testes foram executados.

## Smoke Tests

Quais fluxos principais foram verificados.

## Problemas encontrados

Quais problemas apareceram durante a implementação e como foram resolvidos.

## Problemas restantes

Liste qualquer problema conhecido que ainda exista.

## Próximo passo

Sugira o próximo passo somente depois de concluir a validação.

---

# 20. PRINCÍPIO FINAL

QUALIDADE > VELOCIDADE.

É melhor implementar uma funcionalidade completamente funcional do que implementar várias funcionalidades parcialmente quebradas.

Não avance apenas para parecer produtivo.

Analise.

Implemente.

Teste.

Quebre.

Investigue.

Corrija.

Teste novamente.

Só então avance.

O objetivo é manter o Fragmento em um estado funcional durante todo o desenvolvimento.
