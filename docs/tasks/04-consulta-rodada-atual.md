# Tarefa 04: Consulta — rodada atual

Corresponde ao nó "Rodada atual" do diagrama em `docs/architecture.md`. Depende da tarefa 03.
Pode ser feita em paralelo com a tarefa 05 — são independentes, e é onde os agentes de dev-time
realmente paralelizam.

## Status
- [ ] Discovery
- [ ] Refinamento técnico
- [ ] Implementação
- [ ] Revisão
- [ ] Testes

## Discovery
- Quais os filtros rígidos exatos (rodada atual, status diferente de "agendado")?
- Como identificar automaticamente qual é a rodada atual de cada competição (via API)?
- Formato esperado da resposta (resumo da rodada, destaques, principais resultados)?

Lembrar: este modo é uma **configuração de retrieval** sobre o índice compartilhado — filtro
rígido por rodada/status mais ranking por relevância e recência. Não é um pipeline separado.
Os resultados exatos (placares, tabela) vêm de `buscar_fatos_api`; o índice entrega só a
narrativa em volta.

## Refinamento técnico
_A preencher após o discovery._

## Implementação
_A preencher._

## Revisão
_A preencher._

## Testes
_A preencher._
