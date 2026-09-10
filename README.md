# Futebol RAG — rodada atual + forma do time

Projeto de aprendizado de RAG (Retrieval-Augmented Generation) aplicado a futebol: um índice
vetorial único, consultado por um agente multi-etapa que atende dois modos de pergunta —
"rodada atual" e "forma do time" (com decaimento temporal).

Arquitetura completa e decisões de design em [`docs/architecture.md`](docs/architecture.md).
Os conceitos de RAG por trás de cada peça em [`docs/learning/`](docs/learning/).

## Setup

```bash
nvm use          # Node >= 22.18: o projeto roda .ts sem build
npm install
cp .env.example .env
# preencha as chaves em .env (API_FUTEBOL_TOKEN é opcional até a tarefa 01)
```

## Como rodar

A tarefa 00 já entrega o caminho inteiro do RAG com um fixture de dados (3 jogos do
Brasileirão, inventados — ver `src/sources/fixtures/`), embedding real e Qdrant real:

```bash
docker compose up -d                                   # sobe o Qdrant local
npm run index                                           # indexa os passages do fixture
npm run ask -- "o Palmeiras está numa fase ruim?"        # pergunta, com o traço do agente
npm run ask -- "sua pergunta" --k=8                     # quantos passages recuperar (default 5)
npm run ask -- "sua pergunta" --no-trace                # só a resposta, sem o traço
```

Rodar os testes:

```bash
npm test                 # unidade + typecheck — sem rede, sem Docker
npm run test:integration # recall@k, regra de ouro — precisa de Docker + chaves de API
```

## Estrutura

- `src/sources/` — clientes das fontes de dados (API de futebol, notícias)
- `src/ingestion/` — pipeline de ingestão (dedup, tags, embedding)
- `src/vectorstore/` — cliente do índice vetorial
- `src/retrieval/` — os dois modos de consulta (rodada atual, forma do time)
- `src/generation/` — geração de resposta com citação

Cada pasta tem um `README.md` curto apontando pra tarefa correspondente.

## Como o trabalho está organizado

Cada tarefa em `docs/tasks/` termina em **algo que roda e que dá pra usar** — não em código
invisível. Por isso a ordem começa por uma fatia vertical, e não pela base:

| | Tarefa | O que muda |
|---|---|---|
| 00 | `00-vertical-slice.md` | o caminho inteiro do RAG com dados de mentira: fixture, embedding real, Qdrant, agente, CLI |
| 01 | `01-data-sources.md` | troca o fixture pela API de verdade |
| 02 | `02-ingestion-pipeline.md` | dedup, tags, cadência |
| 03 | `03-vector-index.md` | chunking e schema de metadados definitivos |
| 04 | `04-current-matchweek-query.md` | modo de consulta (paralela com a 05) |
| 05 | `05-team-form-query.md` | modo de consulta (paralela com a 04) |
| 06 | `06-feedback-loops.md` | grader de documentos + crítico da resposta |

Cada tarefa passa por 5 etapas: discovery → refinamento técnico → implementação → revisão →
testes. Ver o modelo em `docs/tasks/TASK_TEMPLATE.md`.

O **discovery** é sempre uma conversa direta com o usuário (skill `grill-me`, em
`.claude/skills/`). O refinamento, a implementação e a revisão usam os agentes definidos em
`.claude/agents/`, com a aprovação da spec pelo usuário entre o refinamento e a implementação.
