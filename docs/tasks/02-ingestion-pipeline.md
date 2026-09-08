# Tarefa 02: Pipeline de ingestão

Corresponde ao nó "Pipeline de ingestão" do diagrama em `docs/architecture.md`. Depende das
tarefas 00 e 01: **substitui a ingestão de uma linha da fatia vertical por um pipeline real.**

## Status
- [ ] Discovery
- [ ] Refinamento técnico
- [ ] Implementação
- [ ] Revisão
- [ ] Testes

## Discovery
- Qual estratégia de deduplicação (hash do texto, similaridade semântica, ID da fonte)?
- Como decidir quando uma informação fica obsoleta (ex: escalação que já mudou)?
- Qual a cadência de execução do pipeline (a cada quantos minutos, via cron/worker)?
- Como taguear automaticamente os times mencionados no texto — regex pelo nome do time vs.
  extração via LLM?

Decidido no grilling de 2026-09-08: se a escolha for extração via LLM, o tagueamento é
classificação curta e de alto volume — cabe em `claude-haiku-4-5`, como a extração de entidade
do runtime. Ver a tabela de modelos em `docs/architecture.md`.

## Refinamento técnico
_A preencher após o discovery._

## Implementação
_A preencher._

## Revisão
_A preencher._

## Testes
_A preencher._
