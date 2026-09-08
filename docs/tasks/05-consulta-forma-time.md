# Tarefa 05: Consulta — forma do time

Corresponde ao nó "Forma do time" do diagrama em `docs/architecture.md`. Depende da tarefa 03.
Pode ser feita em paralelo com a tarefa 04.

## Status
- [ ] Discovery
- [ ] Refinamento técnico
- [ ] Implementação
- [ ] Revisão
- [ ] Testes

## Discovery
- Fórmula exata do decaimento temporal: janela de quantos jogos/dias, curva linear ou
  exponencial?
- Combinar com dados estruturados dos últimos N jogos (via API), além do texto recuperado no RAG?

Decidido no grilling de 2026-09-08:

- **"Qual time" já está resolvido**: a extração de entidade é um nó do agente
  (`claude-haiku-4-5`), construído na tarefa 00 e compartilhado pelos dois modos de consulta.
  Não é problema desta tarefa.
- A curva de decaimento é exatamente o tipo de mudança que só dá para avaliar com medição — usar
  o conjunto de avaliação da tarefa 00, estendido com perguntas de forma recente.

## Refinamento técnico
_A preencher após o discovery._

## Implementação
_A preencher._

## Revisão
_A preencher._

## Testes
_A preencher._
