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
# preencha as chaves em .env:
#   FOOTBALL_DATA_TOKEN — obrigatória, gratuita em https://www.football-data.org/client/register
#   API_FOOTBALL_KEY    — opcional, só enriquece o placar de jogo em andamento
#   VOYAGE_API_KEY, ANTHROPIC_API_KEY — como antes
```

## Como rodar

Desde a tarefa 01 as fontes são reais: `football-data.org` + `API-Football` para placar/rodada,
o feed RSS da Gazeta Esportiva para notícia. Ver `docs/tasks/01-data-sources.md` e
`docs/learning/02-data-sources.md`.

```bash
docker compose up -d                                   # sobe o Qdrant local
npm run sources                                         # mostra a fonte real, sem gastar LLM nem tocar o Qdrant
npm run index                                           # indexa incrementalmente: só o que é novo ou mudou
npm run index -- --recreate                             # apaga a coleção e reconstrói do zero
npm run ask -- "o Palmeiras está numa fase ruim?"        # pergunta, com o traço do agente
npm run ask -- "sua pergunta" --k=8                     # quantos passages recuperar (default 5)
npm run ask -- "sua pergunta" --no-trace                # só a resposta, sem o traço
```

Desde a tarefa 02 (`docs/tasks/02-ingestion-pipeline.md`, `docs/learning/03-ingestion-pipeline.md`)
`npm run index` é incremental: só passages novos ou com o texto/título mudado pagam embedding e
classificação de gênero (`PassageType`, via LLM); rodar de novo sem nada ter mudado não gasta
nada. Desde a tarefa 03 (`docs/tasks/03-vector-index.md`, `docs/learning/04-chunking.md`), cada
passage é cortado em pedaços (`chunk`) de tamanho fixo antes de virar vetor — um point do Qdrant
é um chunk, não um passage inteiro.

**Migração pós-merge da tarefa 03**: os ids de point mudaram (agora dependem também da posição do
chunk) e o payload ganhou dois campos obrigatórios (`chunkIndex`, `chunkCount`) — um point
indexado antes desta tarefa fica inalcançável pelo diff incremental e faz `search()`/`npm run ask`
lançar ao encontrá-lo. Rode `npm run index -- --recreate` **uma vez** depois de atualizar para
reconstruir a coleção do zero com o novo schema; depois disso, `npm run index` incremental é o
comando do dia a dia.

**Migração pós-merge da tarefa 04**: `ensureCollection()` passa a garantir um índice de payload
`datetime` em `publishedAt`, usado pelo filtro rígido do modo `current_matchweek`
(`docs/tasks/04-current-matchweek-query.md`, `docs/learning/05-rigid-filters.md`). A criação do
índice é idempotente e roda dentro do `ensureCollection` de sempre — basta rodar `npm run index`
(sem `--recreate`) **uma vez** depois de atualizar, para a coleção já existente ganhar o índice
novo.

**Migração pós-merge da tarefa 06**: sem mudança de schema do índice — os dois loops de feedback
(`docs/tasks/06-feedback-loops.md`, `docs/learning/07-feedback-loops.md`) vivem só no lado da
pergunta. Nenhum `npm run index` extra é necessário. O `npm run ask` continua igual de fora; o que
muda é o que o traço mostra quando um dos dois loops dispara — ver abaixo.

Desde a tarefa 06, o agente tem dois loops de feedback, visíveis no traço quando disparam: um
grader (`claude-haiku-4-5`) julga cada trecho recuperado por relevância antes de escrever, e
reescreve a busca até 2 vezes se sobrar pouco de aproveitável; depois de escrever, uma checagem
determinística confere que nenhum número da resposta é órfão (sem lastro nos fatos da API) — se
achar um, o crítico (`claude-opus-5`) tem 1 chance de reescrever, e no pior caso a frase problemática
é removida por código, nunca um número inventado chega ao usuário. Como o caminho normal raramente
aciona os dois, `npm run demo:loops` força o cenário e mostra os dois loops em ação:

```bash
npm run demo:loops                                       # força e mostra o loop de self-check disparando
```

Ferramenta de inspeção manual do chunking (não entra no `npm test`, não tem "passou/falhou"):

```bash
npm run eval:chunking                                    # distribuição de chunks com os parâmetros default
npm run eval:chunking -- --size=600 --overlap=100        # distribuição com outros parâmetros, offline (não toca o índice)
npm run eval:chunking -- "como o Palmeiras vem jogando?" # distribuição + top-k contra o índice atual
```

Rodar os testes:

```bash
npm test                 # unidade + typecheck — sem rede, sem Docker
npm run test:integration # recall@k, regra de ouro — precisa de Docker + chaves de API
```

`npm run test:integration` ainda precisa de `VOYAGE_API_KEY`/`ANTHROPIC_API_KEY`/
`FOOTBALL_DATA_TOKEN` preenchidas no `.env` mesmo em replay (`loadEnv()` exige presença antes de
qualquer chamada) — mas `recall.test.ts` e `golden-rule.test.ts` não precisam que nenhuma delas
seja uma chave real, porque essas duas suítes indexam o fixture (`tests/fixtures/`) numa coleção
própria (`camisa10-eval`) em vez de dependerem do índice real, e o cassette cobre as chamadas de
LLM/embedding. A exceção é `tests/integration/live-sources.test.ts`, que fala com a API real e
**precisa** de um `FOOTBALL_DATA_TOKEN` de verdade — ele é pulado automaticamente só em
`LLM_CASSETTE=replay` (não há cassette para as APIs de futebol/RSS, ver
`docs/tasks/01-data-sources.md` §15):

```bash
LLM_CASSETTE=record npm run test:integration  # chama Anthropic/Voyage de verdade e grava a resposta
LLM_CASSETTE=replay npm run test:integration  # reusa o que já foi gravado, sem rede, sem custo
npm run test:integration                      # sem LLM_CASSETTE: sempre API real (padrão)
```

O cassette gravado (`tests/integration/__cassettes__/llm-calls.json`) já está commitado, então
`LLM_CASSETTE=replay` funciona de graça pra maioria dos testes assim que você clona o repo — até
que os prompts mudem e precisem ser regravados. Ver `tests/integration/support/llm-cassette.ts`
para os detalhes, e o aviso impresso em modo replay: ele reproduz gerações já gravadas, não
reprova o invariante da regra de ouro contra uma geração nova — para isso, rode sem
`LLM_CASSETTE`.

**Exceção conhecida**: `tests/integration/golden-rule.test.ts` não fecha em `LLM_CASSETTE=replay`
desde a tarefa 06 (limitação estrutural, não bug de gravação — ver "Acompanhamento" em
`docs/tasks/06-feedback-loops.md` § Testes). O Qdrant nunca fica no cassette (só Anthropic/Voyage
ficam), e a coleção é reconstruída do zero a cada execução; a busca aproximada por HNSW não
garante composição/ordem idêntica do top-k entre duas reconstruções, e com grading + crítico no
meio, isso já é o bastante pra mudar o corpo exato da chamada do redator e descasar do cassette.
O teste passa de forma confiável contra a API real (sem `LLM_CASSETTE`).

## Estrutura

- `src/sources/` — clientes das fontes de dados (API de futebol, notícias)
- `src/ingestion/` — pipeline de ingestão (dedup, tags, embedding)
- `src/vectorstore/` — cliente do índice vetorial
- `src/retrieval/` — os dois modos de consulta (rodada atual, forma do time)
- `src/agent/` — o grafo do agente: extração de entidade, planner, os dois loops de feedback
  (grader + crítico), traço
- `src/generation/` — geração de resposta com citação

Cada pasta tem um `README.md` curto apontando pra tarefa correspondente.

## Como o trabalho está organizado

Cada tarefa em `docs/tasks/` termina em **algo que roda e que dá pra usar** — não em código
invisível. Por isso a ordem começa por uma fatia vertical, e não pela base:

| | Tarefa | O que muda |
|---|---|---|
| 00 | `00-vertical-slice.md` | o caminho inteiro do RAG com dados de mentira: fixture, embedding real, Qdrant, agente, CLI |
| 01 | `01-data-sources.md` | troca o fixture pela API de verdade (football-data.org, API-Football, RSS) |
| 02 | `02-ingestion-pipeline.md` | dedup, tags, cadência |
| 03 | `03-vector-index.md` | chunking e schema de metadados definitivos |
| 04 | `04-current-matchweek-query.md` | modo de consulta (paralela com a 05) |
| 05 | `05-team-form-query.md` | modo de consulta (paralela com a 04) |
| 06 | `06-feedback-loops.md` | grader de documentos + crítico da resposta |

Cada tarefa passa por 5 etapas: discovery → refinamento técnico → implementação → revisão →
testes. Ver o modelo em `docs/tasks/TASK_TEMPLATE.md`.

O **discovery** é sempre uma conversa direta com o usuário (skill `grill-me`, em
`.claude/skills/`). O refinamento, a implementação e a revisão usam os agentes definidos em
`.claude/agents/`. O usuário entra em dois pontos: quando o `refinador` deixa uma decisão em
aberto (aí o ciclo para até ele decidir), e para revisar o PR já pronto no final — a revisão do
`revisor` roda localmente, antes de existir PR, e o PR só abre depois que ela não acha mais nada
(ou o teto de 3 rodadas de correção é atingido).
