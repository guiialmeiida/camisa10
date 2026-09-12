# Tarefa 04: Consulta — rodada atual

Corresponde ao nó "Rodada atual" do diagrama em `docs/architecture.md`. Depende da tarefa 03.
Pode ser feita em paralelo com a tarefa 05 — são independentes, e é onde os agentes de dev-time
realmente paralelizam.

## Status
- [x] Discovery  ← grilling de 2026-09-12, 8 decisões registradas abaixo
- [x] Refinamento técnico  ← spec fechada em 2026-09-12, sem pendência para o usuário
- [x] Implementação  ← 2026-09-12, `npm test` 189/189; ver detalhes em Implementação/Testes abaixo
- [ ] Revisão
- [ ] Testes

## Discovery

Concluído no grilling de 2026-09-12. As três perguntas originais eram:

- Quais os filtros rígidos exatos (rodada atual, status diferente de "agendado")?
- Como identificar automaticamente qual é a rodada atual de cada competição (via API)?
- Formato esperado da resposta (resumo da rodada, destaques, principais resultados)?

A segunda já estava resolvida desde a tarefa 01 e não foi reaberta: `getFacts()` sem `matchweek`
usa `info.currentMatchday` da football-data.org (`src/sources/facts.ts`). As outras duas viraram
as decisões abaixo.

1. **Filtro rígido de data**: no modo `current_matchweek`, `search_vector_context` recebe uma
   janela de `publishedAt` = **[data do primeiro jogo da rodada atual − 3 dias, agora]**. A data
   do "primeiro jogo" é o **mínimo** das datas em `facts.matches` — a ordem devolvida por
   `getFacts()`/`fetchMatchweek()` **não é garantidamente cronológica** (confirmado no código: não
   há `sort` em `src/sources/football-data.ts` nem em `src/sources/facts.ts`), então o cálculo é um
   `Math.min` sobre as datas, nunca `matches[0]`.
   - Se `facts.matches.length === 0` (rodada sem jogo nenhum — intervalo entre temporadas, filtro
     que não casou nada), **não aplica filtro de data nenhum**: cai no comportamento sem restrição,
     só similaridade. Mesmo espírito de "no teto, o sistema responde, nunca falha".
2. **Sem reranking e sem peso de metadado nesta tarefa.** Só filtro rígido (`filter` do Qdrant) +
   similaridade pura do `query()`. A fórmula `similaridade x peso_metadado x decaimento_temporal`
   do `docs/architecture.md` fica para a tarefa 05 (`team_form`), onde decaimento temporal é o
   conceito central — duplicar a lógica aqui, com nuance diferente, é pior que esperar.
3. **`payload.matchweek` não é usado como filtro.** Ele guarda a rodada do momento em que aquele
   passage foi indexado pela última vez: com a ingestão incremental, um passage sem mudança de
   `contentHash` nunca é reescrito, então o campo fica congelado na rodada em que entrou. Isso já
   está dito em `src/ingestion/indexer.ts:256-258`. Só `publishedAt` (timestamp real da fonte) é
   confiável para dizer "isto é da rodada atual".
4. **Filtro também por `payload.teams`, quando `entity.team` estiver presente.** O filtro do modo é
   (janela de data, ou nada, conforme o item 1) **E** (`payload.teams` contém `entity.team`, se
   `entity.team !== null`). Sem `entity.team`, só o filtro de data.
5. **O redator ganha uma instrução condicional**, só quando `mode === "current_matchweek"`:
   mencionar primeiro o que já aconteceu (`finished`/`live`) e depois o que falta
   (`scheduled`/`postponed`), **em texto corrido** — sem criar seções fixas do tipo
   "Resultados:"/"Próximos jogos:", que foram consideradas rígidas demais. O formato de
   `buildFactsSection`/`formatMatchLine` **não muda**: continuam listando todos os jogos juntos,
   misturados por status, como hoje.
6. **`measureRecall` (`tests/eval/recall.ts`) não muda.** Continua chamando `search({ vector, k })`
   sem filtro e sem olhar `question.mode`. O `recall@k` mede outra coisa (se a busca semântica acha
   o trecho certo), e a linha de base **0.929** não pode se mexer — mesma lógica já aplicada na
   tarefa 03 para não deixar o chunking mexer no fixture de avaliação. O filtro rígido é coberto por
   teste dedicado, com datas controladas.
7. **Onde a lógica entra**: `runFanOut` (`src/agent/graph.ts`) hoje ignora `state.plan.mode` por
   completo. Esta tarefa liga `plan.mode` a uma configuração de retrieval real. *Como* fazer isso é
   decisão técnica, não do usuário — inclusive a consequência de que o filtro de data depende dos
   `facts`, que vêm do fan-out, e portanto mexe no paralelismo do `Promise.allSettled` sem poder
   quebrar a resiliência já testada em `tests/graph.test.ts`. Resolvido na seção 5 do refinamento.
8. **O modo `team_form` não muda nesta tarefa** — continua sem filtro nenhum, exatamente como hoje.
   É escopo da tarefa 05.

Lembrar: este modo é uma **configuração de retrieval** sobre o índice compartilhado — filtro
rígido mais ranking por relevância. Não é um pipeline separado. Os resultados exatos (placares,
tabela) vêm de `fetch_facts_api`; o índice entrega só a narrativa em volta.

## Refinamento técnico

Spec fechada em 2026-09-12 a partir do discovery acima. Nada aqui reabre decisão do discovery.
As duas consequências técnicas que o discovery registrou sem decidir — onde construir o filtro
(item 7) e o que fazer com o paralelismo do fan-out — são resolvidas nas seções 3 e 5.

### 0. O que esta tarefa é, em uma frase

O modo `current_matchweek` deixa de ser um rótulo que ninguém lê e passa a recortar o índice antes
da similaridade: a busca vetorial só enxerga trechos publicados na janela da rodada atual e, quando
a pergunta é sobre um time, só os que mencionam aquele time — e o redator passa a ordenar a
narrativa por "o que já aconteceu, depois o que falta".

### 1. O que continua exatamente igual

- **A regra de ouro, intocada.** Nenhum número novo entra no índice, nenhum número sai dele para a
  resposta. O filtro é sobre *quais* trechos de narrativa a busca pode ver; placar, data e rodada
  continuam vindo só de `getFacts()`.
- **`src/sources/`, `src/ingestion/` e o payload do índice não mudam.** Nenhum campo novo, nenhum
  reembedding, nenhuma chamada nova a LLM. Esta tarefa é só lado-da-pergunta.
- **`searchContext()` mantém a assinatura**: o parâmetro `filter` existe em `SearchContextParams`
  desde a tarefa 03 justamente para isto. Só o comentário do arquivo muda (deixa de dizer "nesta
  tarefa, sem filtro rígido").
- **`search()` do Qdrant não muda** — ele já repassa `filter` para `query()`.
- **`measureRecall` e `tests/eval/questions.json` não mudam** (discovery, item 6). `recall@5`
  continua `>= 0.8`, com a linha de base **0.929**. Se o número mexer nesta tarefa, é regressão.
- **`team_form` não muda** (discovery, item 8): sem filtro, e sem esperar pelos `facts` (seção 5).
- **`buildFactsSection` / `formatMatchLine` não mudam** (discovery, item 5).
- **`plan.tools` continua sendo ignorado por `runFanOut`** — as duas ferramentas sempre rodam. Isso
  é dívida conhecida da tarefa 00 e não é escopo daqui (seção 13).

### 2. O modelo mental: o que um filtro rígido compra, e o que ele custa

Similaridade não sabe que dia é hoje. "Como está a rodada do Brasileirão?" e uma crônica de três
rodadas atrás sobre os mesmos times têm vetores parecidíssimos — o embedding captura *assunto*, não
*recência*. Sem recorte, a busca devolve o trecho mais parecido do corpus inteiro, e o redator
escreve com confiança sobre um jogo que acabou faz um mês.

O filtro rígido é a resposta mais barata para isso: em vez de reordenar o que veio (rerank) ou
multiplicar o score por um decaimento (tarefa 05), ele **diz ao Qdrant o que nem pode ser
considerado**. É pré-filtragem, não pós-processamento — o `k` passa a ser "os k melhores *dentre os
elegíveis*", e não "os k melhores, torcendo para que sejam elegíveis".

Isso cobra dois preços, e os dois são visíveis nesta spec:

1. **Um filtro errado é invisível como resposta ruim.** Por isso o filtro aplicado é impresso no
   trace (seção 6): você vê o JSON que foi para o Qdrant, não só o resultado.
2. **O filtro depende de um fato.** A janela de datas sai de `facts.matches`, que vem da API — ou
   seja, o lado da narrativa passa a depender do lado dos fatos, e o fan-out deixa de ser dois
   caminhos independentes. A seção 5 resolve isso sem perder a resiliência; o trace mostra quanto
   tempo a busca ficou esperando.

### 3. O construtor do filtro — `src/retrieval/filters.ts` (novo)

Função **pura**: sem rede, sem estado, sem relógio implícito (o `now` é injetável). Testável
sozinha, e é onde mora toda a decisão de recorte deste modo.

```ts
import type { Facts } from "../sources/index.ts";
import type { QdrantFilter } from "../vectorstore/qdrant.ts";

/** How far before the matchweek's first match the publication window opens. */
export const CURRENT_MATCHWEEK_LOOKBACK_DAYS = 3;

export interface CurrentMatchweekFilterParams {
  /** null when the facts call failed — then there is no date window, only the team clause. */
  facts: Facts | null;
  /** entity.team, already a team id (slug). null when the question names no team. */
  team: string | null;
  /** Injectable so the tests don't depend on the wall clock. Defaults to new Date(). */
  now?: Date | undefined;
}

/**
 * The rigid filter for the current_matchweek mode: publishedAt inside the matchweek's
 * window, and (when the question names a team) the passage must mention that team.
 * Returns null when there is no clause at all — the caller then searches unfiltered.
 */
export function buildCurrentMatchweekFilter(params: CurrentMatchweekFilterParams): QdrantFilter | null;
```

#### As regras, em ordem

1. **Janela de datas.** Sejam `times = facts.matches.map((match) => Date.parse(match.date))`,
   descartando os que não são finitos (`Number.isNaN`). Se sobrar pelo menos um:
   - `from = new Date(Math.min(...times) - CURRENT_MATCHWEEK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)`;
   - `to = now`;
   - a cláusula é `{ key: "publishedAt", range: { gte: from.toISOString(), lte: to.toISOString() } }`.
   O `Math.min` é obrigatório e não é detalhe de estilo: `facts.matches` **não vem ordenado**
   (discovery, item 1), e `matches[0].date` produziria uma janela errada sempre que a API devolver
   a rodada fora de ordem — um bug que só aparece em produção, com dados reais.
2. **Sem janela de datas**, em qualquer um destes casos (nenhum deles é erro):
   - `facts === null` (a chamada à API falhou);
   - `facts.matches.length === 0` (discovery, item 1);
   - nenhuma data parseável em `facts.matches`;
   - **janela vazia**: `from > now`. Acontece de verdade — a rodada atual da API vira logo depois
     que a anterior acaba, então na terça-feira o primeiro jogo pode estar a cinco dias de
     distância e `from` cai *no futuro*. Aplicar a janela literalmente ali excluiria justamente as
     prévias publicadas hoje, que são o contexto certo. Esta é a mesma válvula de escape que o
     discovery já decidiu para o caso degenerado do item 1 ("não dá para calcular janela útil →
     não filtra por data"), aplicada ao outro caso degenerado da mesma conta. Está explícito aqui
     porque é extrapolação da regra do usuário, não regra do usuário.
3. **Cláusula de time**, se e só se `team !== null` e não vazio depois de `trim()`:
   `{ key: "teams", match: { value: team } }`. `payload.teams` é um array de ids; o `match` do
   Qdrant casa quando **qualquer** elemento é igual ao valor.
   - Consequência aceita e declarada: um passage com `teams: []` (notícia que o `tagTeams` não
     conseguiu associar a nenhum time) **nunca** passa por esse filtro. É o que o discovery pediu
     no item 4, e é o preço de perguntar sobre um time específico.
4. **Composição**: as cláusulas existentes entram em `must` (conjunção), na ordem
   `[publishedAt, teams]`. Zero cláusula → **retorna `null`**, nunca `{}` nem `{ must: [] }` — um
   filtro vazio é uma requisição a mais dizendo "não filtre nada", e `null` deixa o chamador
   simplesmente não passar `filter`.

#### Exemplo literal

Entrada (note as datas **fora de ordem**, de propósito):

```json
{
  "facts": {
    "competition": { "id": "brasileirao-serie-a", "name": "Brasileirão Série A", "season": 2026 },
    "matchweek": 27,
    "matches": [
      { "id": "m2", "matchweek": 27, "date": "2026-09-06T18:30:00-03:00", "status": "finished", "homeTeam": "flamengo", "awayTeam": "santos", "score": { "home": 2, "away": 0 }, "venue": "Maracanã" },
      { "id": "m1", "matchweek": 27, "date": "2026-09-05T21:30:00-03:00", "status": "finished", "homeTeam": "palmeiras", "awayTeam": "fluminense", "score": { "home": 1, "away": 3 }, "venue": "Allianz Parque" },
      { "id": "m3", "matchweek": 27, "date": "2026-09-08T20:00:00-03:00", "status": "scheduled", "homeTeam": "corinthians", "awayTeam": "palmeiras", "score": null, "venue": "Neo Química Arena" }
    ],
    "teams": [],
    "source": "api"
  },
  "team": "palmeiras",
  "now": "2026-09-07T15:00:00.000Z"
}
```

Saída:

```json
{
  "must": [
    {
      "key": "publishedAt",
      "range": { "gte": "2026-09-03T00:30:00.000Z", "lte": "2026-09-07T15:00:00.000Z" }
    },
    { "key": "teams", "match": { "value": "palmeiras" } }
  ]
}
```

O `gte` saiu de `m1` (05/09 21:30 −03:00 = 06/09 00:30 UTC, menos 3 dias), que é o **terceiro** item
do array — é exatamente esse o ponto do `Math.min`.

Sem `team` e sem jogos:

```json
null
```

#### Por que `range` com string é um filtro de data de verdade

O Qdrant tem duas formas de `range` na mesma chave do schema (`RangeInterface = Range |
DatetimeRange`, confirmado em `@qdrant/js-client-rest` 1.19): números viram comparação numérica,
strings RFC 3339 viram comparação de **datetime** — não comparação lexicográfica de string. Por
isso `publishedAt` com offset `-03:00` (o formato que `toSaoPauloIso` produz desde a tarefa 01)
casa corretamente com limites em `Z`: os dois viram o mesmo instante absoluto. A seção 4 garante o
lado do servidor, e o teste de integração da seção 11 prova que funciona contra um Qdrant real —
não só que montamos o JSON da forma certa.

### 4. Índice de payload `datetime` — `src/vectorstore/qdrant.ts` (alterado)

`ensureCollection()` passa a garantir, **no fim, sempre** (tenha ela acabado de criar a coleção ou
não), um índice de payload de tipo `datetime` no campo `publishedAt`:

```ts
await qdrant.createPayloadIndex(collection, { field_name: "publishedAt", field_schema: "datetime", wait: true });
```

- É idempotente: criar de novo um índice já existente com o mesmo schema é no-op no Qdrant.
- Erro de rede/servidor **sobe**, com o mesmo embrulho já usado no arquivo
  (`could not reach Qdrant at ${url}: ...`). Não engolir: se o índice não existe, o filtro de data
  pode silenciosamente devolver zero resultado, que é o pior modo de falha possível para esta
  tarefa — a resposta continua saindo, só que sem contexto nenhum e sem ninguém saber por quê.
- Ficar **dentro** de `ensureCollection` e não numa função nova chamada por fora é o que faz um
  `npm run index` comum curar uma coleção que já existe desde antes desta tarefa. Não é preciso
  `--recreate`.

Um ponto cujo `publishedAt` não seja RFC 3339 válido simplesmente não entra no índice e nunca casa
a janela. Hoje isso não acontece (todo `publishedAt` passa por `toSaoPauloIso`, tarefa 01), e o
`z.string()` do payload continua não validando formato — registrado aqui como limitação conhecida,
não como algo a consertar nesta tarefa.

`search`, `insertPoints`, `fetchDigests`, `deleteOrphanChunks` e `countPoints` **não mudam**.

### 5. O fan-out com dependência de dado — `src/agent/graph.ts` (alterado)

Este é o ponto que o discovery deixou explicitamente para a spec resolver (item 7).

**O problema.** A janela de datas vem de `facts.matches`. Os `facts` vêm de uma das duas pontas do
`Promise.allSettled`. Logo, no modo `current_matchweek`, a busca vetorial não pode mais começar ao
mesmo tempo que a chamada da API — ela precisa do resultado dela. E o contrato já testado em
`tests/graph.test.ts` diz que **uma ponta falhar nunca derruba a outra**.

**A solução.** A ponta da busca vira uma função que espera os fatos *defensivamente*, e a estrutura
do `Promise.allSettled` não muda:

```ts
interface ContextOutcome {
  results: SearchResult[];
  /** The rigid filter actually sent to Qdrant — null when the search ran unfiltered. */
  filter: QdrantFilter | null;
  /** How long this branch sat waiting for the facts call. 0 when it didn't wait. */
  waitedForFactsMs: number;
}

/**
 * The search branch of the fan-out. In current_matchweek mode the date window comes from
 * the facts, so this branch waits for the facts call — defensively: a rejected facts call
 * becomes "no date window", never a rejected search. team_form doesn't wait at all.
 */
async function runContextCall(
  state: StateWithPlan,
  factsCall: Promise<{ value: Facts; ms: number }>,
): Promise<ContextOutcome>;
```

Passo a passo:

1. `mode !== "current_matchweek"` → `filter = null`, `waitedForFactsMs = 0`, e a chamada a
   `searchContext` sai **imediatamente**, sem tocar em `factsCall`. O modo `team_form` fica byte a
   byte com o comportamento de hoje, inclusive no paralelismo.
2. `mode === "current_matchweek"` → marca `performance.now()`, faz
   `const facts = await factsCall.then((settled) => settled.value).catch(() => null)`, mede o
   tempo de espera, e chama
   `buildCurrentMatchweekFilter({ facts, team: state.entity.team })`.
   - O `.catch(() => null)` é a peça que preserva a resiliência: sem ele, uma API de futebol fora
     do ar rejeitaria **as duas** pontas do `allSettled`, e a pergunta perderia também a narrativa —
     exatamente a regressão que os testes existentes de `runFanOut` guardam. Com ele, a busca roda
     sem janela de datas (mas ainda com a cláusula de time, que não depende da API).
   - Consumir a mesma promise duas vezes (aqui e no `allSettled`) é seguro: `factsCall` já foi
     criada antes, a rejeição continua tratada pelo `allSettled`, e o `.catch` cria uma promise
     derivada que também está tratada — não há `unhandledRejection`.
3. Chama `searchContext({ query: state.plan.searchQuery, k: state.k, ...(filter !== null ? { filter } : {}) })`
   e devolve o `ContextOutcome`.

Em `runFanOut`, o que muda:

```ts
const factsCall = measure(() => getFacts({ ... }));          // inalterado
const contextCall = measure(() => runContextCall(state, factsCall));   // era searchContext direto
const [factsSettled, contextSettled] = await Promise.allSettled([factsCall, contextCall]);
```

- `contextSettled.status === "fulfilled"` → `context = value.results`, `filter = value.filter`,
  `waitedForFactsMs = value.waitedForFactsMs`, `contextMs = ms`.
- `rejected` → `context = []`, `filter = null`, `waitedForFactsMs = 0`, `contextError` como hoje.
- O `ms` medido para essa ponta passa a ser **o galho inteiro** (espera + embedding + query). É o
  tempo de parede real do galho, então o `Math.max` do trace continua dando um total honesto; o
  quanto disso foi espera aparece separado, no campo novo.

**Por que não o contrário** (dividir `searchContext` em `embed` + `search` para embeddar em
paralelo com a API, e só depois aplicar o filtro): economizaria os ~300ms do embedding dentro de um
pipeline dominado por duas chamadas Opus, ao custo de espalhar a composição de `searchContext` pelo
grafo e de passar uma *promise* como parâmetro de biblioteca. Caro em entendimento, barato em
segundos. Se algum dia a medição do trace mostrar que esse pedaço importa, o campo
`waitedForFactsMs` é exatamente o número que vai provar isso.

**Por que não simplesmente `await getFacts()` antes do fan-out**: mataria o paralelismo também no
`team_form`, que não precisa de nada disso, e apagaria do trace o único lugar onde o projeto ensina
`Promise.allSettled` de verdade.

### 6. O trace — `src/agent/trace.ts` (alterado)

`TraceEntry` do nó `search_vector_context` ganha dois campos **obrigatórios**:

```ts
| {
    node: "search_vector_context";
    model: string;
    /** The whole branch: waiting for the facts (when the mode needs them) + embedding + query. */
    ms: number;
    k: number;
    collection: string;
    collectionSize: number;
    /** The rigid filter sent to Qdrant, or null when the search ran unfiltered. */
    filter: QdrantFilter | null;
    /** How long the branch waited for fetch_facts_api. Always 0 outside current_matchweek. */
    waitedForFactsMs: number;
    results: SearchResult[];
    error?: string;
  }
```

Obrigatórios, não opcionais, pelo mesmo motivo que `(0 fallbacks)` aparece desde a tarefa 02:
número que só aparece quando é diferente de zero é número que ninguém sabe se foi medido. O custo é
atualizar os cinco objetos de amostra em `tests/trace.test.ts`.

Na saída de `formatTrace`, duas mudanças, ambas no bloco `search_vector_context`:

1. O sufixo `    (waited 0.61s for fetch_facts_api)` na linha do `└──`, **só quando**
   `waitedForFactsMs > 0` (o que, por construção, é o mesmo que "o modo era `current_matchweek`").
2. Uma linha nova `        filter: ...` **logo depois** do `└──` e **antes** dos ramos de
   erro/vazio/`k=`, com `JSON.stringify(filter)` ou `none`. Vir antes é de propósito: é quando a
   busca devolve zero trecho que você mais quer ver o filtro que a causou.

```
    └── search_vector_context    voyage-3.5    0.94s    (waited 0.61s for fetch_facts_api)
        filter: {"must":[{"key":"publishedAt","range":{"gte":"2026-09-03T00:30:00.000Z","lte":"2026-09-07T15:00:00.000Z"}},{"key":"teams","match":{"value":"palmeiras"}}]}
        k=5 over 97 points in collection camisa10
        #1  0.612  9f2c41ab77de  chunk 2/4  matchReport  "o técnico admitiu que a equipe perdeu…"
```

```
    └── search_vector_context    voyage-3.5    0.33s
        filter: none
        no passages retrieved
```

O resto de `formatTrace` (cabeçalho do fan-out com `Math.max`, total, bloco `sources:`) **não
muda**.

### 7. O redator — `src/generation/writer.ts` (alterado)

**A assinatura de `buildPrompt` não muda.** `StateWithData extends StateWithPlan`, então
`state.plan.mode` já está lá — passar `mode` separado seria um parâmetro a mais para um dado que a
função já recebe. Os testes atuais já constroem o `state` com `plan`.

Uma linha condicional entra no array `system`, entre `"Se não houver context relevante..."` e
`"Responda em português, de forma direta."`:

```ts
...(state.plan.mode === "current_matchweek"
  ? [
      "A pergunta é sobre a rodada em andamento: em texto corrido, fale primeiro do que já aconteceu (jogos com status finished ou live) e só depois do que ainda vai acontecer (scheduled ou postponed). Não crie seções, títulos nem listas do tipo \"Resultados\" e \"Próximos jogos\" — é um texto só.",
    ]
  : []),
```

- No modo `team_form` o prompt fica **idêntico ao de hoje** — nenhuma linha a mais, nenhuma a menos.
- `buildFactsSection` e `formatMatchLine` continuam listando todos os jogos juntos, misturados por
  status (discovery, item 5). A ordenação é instrução ao redator sobre a *narrativa*, não uma
  reorganização dos dados: reordenar os fatos no prompt seria esconder do modelo a lista que a API
  devolveu, e o crítico da tarefa 06 confere a resposta contra essa lista.

### 8. A regra de ouro nesta tarefa

Um filtro é uma decisão sobre *quais trechos de narrativa podem ser vistos* — nunca sobre de onde
vem um número. Concretamente:

1. **Nada do índice vira número na resposta.** O filtro reduz o conjunto candidato; ele não
   acrescenta um único campo ao `<context>` do prompt, que continua renderizando só `passageId`,
   `type`, `source`, `title` e `text`.
2. **A data que define a janela vem da API**, de `facts.matches[].date` — não de `payload.matchweek`
   e não de nenhum trecho de notícia. O sentido da dependência é o certo: fato restringindo
   narrativa, nunca o contrário.
3. **`payload.matchweek` continua fora do caminho de decisão** (discovery, item 3), e a spec diz
   isso em voz alta para ninguém "otimizar" o filtro depois acrescentando um `match` nesse campo:
   ele é congelado no momento da indexação e mentiria sobre a rodada real do conteúdo.
4. **Nenhum número novo no prompt.** Nem o JSON do filtro, nem `waitedForFactsMs`: os dois só
   existem no trace, que não vai para LLM nenhum.
5. `tests/integration/golden-rule.test.ts` continua valendo sem alteração — é o invariante de
   ponta a ponta desta regra, e esta tarefa não muda nada que ele exercite.

### 9. Tratamento de erro

| onde | situação | comportamento |
|---|---|---|
| `buildCurrentMatchweekFilter` | `facts === null` | sem cláusula de data; a de time continua valendo |
| `buildCurrentMatchweekFilter` | `facts.matches === []` | sem cláusula de data (discovery, item 1) |
| `buildCurrentMatchweekFilter` | data não parseável em algum jogo | ignora aquele jogo; se nenhum sobrar, sem cláusula de data |
| `buildCurrentMatchweekFilter` | janela vazia (`from > now`) | sem cláusula de data (seção 3, regra 2) |
| `buildCurrentMatchweekFilter` | nenhuma cláusula aplicável | devolve `null` — **nunca lança**. Filtro é configuração de retrieval; travar a pergunta por causa dele seria o modo de falha errado |
| `runContextCall` | `getFacts` rejeitou | busca roda sem janela de datas; `facts: null` no estado e o erro no trace, como hoje |
| `runContextCall` | `searchContext` rejeitou | `context: []`, `filter: null`, erro no trace — inalterado |
| `ensureCollection` | `createPayloadIndex` falhou | **lança**, com `could not reach Qdrant at ${url}: ...` |
| busca filtrada devolve 0 resultado | — | `context: []` → `computeLowConfidence` já devolve `true` → resposta sai avisando que não houve contexto. **Sem retry sem filtro** (seção 13) |

### 10. Arquivos a criar ou alterar

**Criar**
```
src/retrieval/filters.ts                  buildCurrentMatchweekFilter + CURRENT_MATCHWEEK_LOOKBACK_DAYS
tests/retrieval/filters.test.ts           os casos da seção 11
docs/learning/05-rigid-filters.md         o conceito desta tarefa
```

**Alterar**
```
src/agent/graph.ts                        runContextCall + ContextOutcome; fan-out com a dependência
src/agent/trace.ts                        filter + waitedForFactsMs na entrada e na impressão
src/generation/writer.ts                  a instrução condicional de current_matchweek
src/retrieval/search-context.ts           só o comentário do topo (o filtro agora é usado)
src/vectorstore/qdrant.ts                 índice de payload datetime em ensureCollection
tests/graph.test.ts                       casos da seção 11 (filtro, ordem, resiliência)
tests/trace.test.ts                       campos novos nos 5 objetos de amostra + 2 casos novos
tests/writer.test.ts                      instrução presente em current_matchweek, ausente em team_form
tests/integration/vectorstore.test.ts     prova do range de datetime e do match em teams no Qdrant real
docs/architecture.md                      glossário (3 linhas) + nota na seção da fórmula de scoring
docs/learning/README.md                   linha nova no índice
README.md                                 nota: rode `npm run index` uma vez depois do merge (cria o índice de payload)
```

**Nada a apagar.**

Linhas a acrescentar no glossário de `docs/architecture.md`:

| Português | Inglês |
|---|---|
| filtro rígido | `filter` |
| janela de publicação | `publishedAt window` |
| janela retroativa | `lookback` |

Na seção "Fórmula de scoring", uma frase: a tarefa 04 implementou **só** o filtro rígido do
`current_matchweek`; `peso_metadado` e `decaimento_temporal` continuam pendentes e são escopo da
tarefa 05.

`docs/learning/05-rigid-filters.md` cobre: por que similaridade não sabe que dia é hoje; a diferença
entre pré-filtrar (o `filter` do Qdrant, que muda o conjunto candidato) e pós-processar (rerank, que
só reordena o que já veio); por que a data confiável é `publishedAt` e não `payload.matchweek`
(ingestão incremental congela o segundo); e por que um filtro cria uma dependência de dado que
custa paralelismo. Termina no bloco **"Por que não X?"**: por que não filtrar por `matchweek`, por
que não rerank/decaimento aqui (tarefa 05), por que não cair para busca sem filtro quando dá zero,
por que não filtrar por status do jogo (a decisão da tarefa 03 continua valendo: status muda no
tempo e não pode ser congelado no índice), e por que não sequenciar o fan-out inteiro.

### 11. Casos de teste

Unidade (`npm test` = `tsc --noEmit && vitest run`, sem rede e sem Docker):

`tests/retrieval/filters.test.ts` (novo) — nenhum mock, a função é pura:
- **A janela sai do mínimo, não do primeiro elemento**: `matches` em ordem não cronológica (o jogo
  mais antigo na última posição) → `gte` é `data_mínima − 3 dias`. É o teste que trava o bug do
  `matches[0]`.
- Igualdade literal do objeto devolvido, com `now` fixo, para o exemplo da seção 3 (`must` com as
  duas cláusulas, nessa ordem).
- `lte` é exatamente `now.toISOString()`.
- `team: null` → só a cláusula de `publishedAt`.
- `facts.matches: []` com `team: "palmeiras"` → só a cláusula de `teams`.
- `facts: null` com `team: null` → **`null`**.
- `facts: null` com `team: "palmeiras"` → só a cláusula de `teams`.
- Janela vazia (todos os jogos a 5 dias de `now`) → sem cláusula de data.
- Datas inválidas: um jogo com `date: "not a date"` entre jogos válidos → ignorado, janela sai dos
  válidos; **todos** inválidos → sem cláusula de data.
- `team: "  "` (só espaço) → tratado como ausente.
- `CURRENT_MATCHWEEK_LOOKBACK_DAYS` é 3 e a conta usa dias inteiros (jogo às 21:30 −03:00 → `gte`
  três dias antes, no mesmo horário).

`tests/graph.test.ts` (alterado; `getFacts`, `searchContext` e `countPoints` já são mockados lá):
- **`current_matchweek` filtra**: `searchContext` é chamado com um `filter` cujo `must` contém o
  range de `publishedAt` derivado da data mínima dos jogos mockados e o `match` de `teams` com
  `entity.team`.
- **`team_form` não filtra**: `searchContext` é chamado **sem** `filter` (a propriedade nem existe
  no objeto), e a entrada do trace tem `filter: null` e `waitedForFactsMs: 0`.
- **`team_form` não espera pelos fatos**: com `getFacts` devolvendo uma promise ainda pendente,
  `searchContext` já foi chamado antes de ela resolver.
- **`current_matchweek` espera pelos fatos**: com `getFacts` pendente, `searchContext` **não** foi
  chamado; depois de resolver, foi — com o filtro. É o contrato da seção 5 virando teste executável.
- **Resiliência sob a dependência nova**: `mode: "current_matchweek"` com `getFacts` **rejeitando**
  → `searchContext` ainda é chamado (com filtro só de time, ou sem filtro se `entity.team` for
  `null`), `result.facts === null`, `result.context` preservado, erro só na entrada
  `fetch_facts_api` do trace. Sem isso, uma API fora do ar levaria a busca junto.
- **(mantidos)** os três casos atuais de `Promise.allSettled` e o do `QDRANT_COLLECTION` real.
- A entrada de trace `search_vector_context` traz `filter` e `waitedForFactsMs` em todos os casos.

`tests/trace.test.ts` (alterado):
- Os 5 objetos de amostra ganham os dois campos (typecheck).
- `filter: null` → a saída contém `filter: none` e **não** contém `waited`.
- `filter` presente e `waitedForFactsMs: 610` → a saída contém o JSON do filtro e
  `(waited 0.61s for fetch_facts_api)`.
- Com `results: []` e filtro presente, a linha `filter:` ainda aparece (o caso em que ela mais
  importa).

`tests/writer.test.ts` (alterado):
- `mode: "current_matchweek"` → `prompt.system` contém a instrução de ordenar
  aconteceu-depois-falta e a proibição de criar seções.
- `mode: "team_form"` → `prompt.system` **não** contém nada disso, e permanece igual ao de hoje.
- `buildFactsSection` inalterada: com um jogo `finished` e um `scheduled`, as linhas saem na ordem
  em que estão em `facts.matches` (nada de reordenação no prompt).

Integração (`npm run test:integration`, Qdrant real):

`tests/integration/vectorstore.test.ts` (alterado) — um caso novo, na coleção própria do arquivo:
- Insere 4 points com `publishedAt` controlados: um **antes** da janela, dois **dentro**, um no
  **futuro** (depois do `lte`); dois deles com `teams: ["palmeiras"]` e dois com
  `teams: ["santos"]`.
- `search({ vector, k: 10, filter })` com o filtro de data → só os dois de dentro da janela voltam.
- O mesmo filtro com a cláusula de `teams` → só o point que satisfaz as duas.
- É a prova de que o `range` de datetime funciona **no servidor**, sobre `publishedAt` guardado com
  offset `-03:00`, e não só que montamos o JSON com a forma certa. Um filtro que passa no mock e
  devolve vazio na vida real é exatamente o modo de falha desta tarefa.

`tests/integration/recall.test.ts` (inalterado) — `recall@5` continua **0.929**. Qualquer mudança
aqui é regressão, não ajuste (discovery, item 6).

### 12. O que roda no fim

Sem CLI nova: `src/cli/ask.ts` já imprime o trace, e o trace é onde o filtro fica visível.

```
$ npm run index            # uma vez após o merge: cria o índice de payload datetime
$ npm run ask -- "como está a rodada do Brasileirão?"
$ npm run ask -- "o que rolou com o Palmeiras nessa rodada?"
```

A segunda pergunta é a demonstração completa do modo: no trace, `planner` diz
`mode: current_matchweek`, e o bloco `search_vector_context` mostra o `filter:` com as duas
cláusulas e o `(waited ...s for fetch_facts_api)` — a dependência de dado desta tarefa, visível em
uma linha. A resposta cita as fontes e fala primeiro dos jogos já encerrados.

Para ver o contraste, `npm run ask -- "o Palmeiras está numa fase ruim?"` cai em `team_form` e
imprime `filter: none`, sem espera — o modo que esta tarefa não toca.

### 13. Fora de escopo

- **Rerank e decaimento temporal.** A fórmula `similaridade x peso_metadado x decaimento_temporal`
  do `docs/architecture.md` não é implementada aqui (discovery, item 2) — tarefa 05.
- **Qualquer mudança no modo `team_form`** (discovery, item 8) — tarefa 05.
- **Fallback para busca sem filtro quando o filtro devolve zero resultado.** Deliberado: o caminho
  de baixa confiança já existe (`computeLowConfidence`), e um fallback silencioso faria o trace
  mentir sobre o que foi aplicado. Retry é o assunto do loop de reescrita de query da tarefa 06,
  onde ele tem um teto e aparece no traço.
- **Filtrar por `payload.matchweek` ou por status do jogo.** O primeiro está vetado pelo discovery
  (item 3); o segundo, pela tarefa 03 (status muda no tempo e não pode ser congelado no índice).
- **Filtrar por `competition`.** Hoje o índice tem uma competição só; a cláusula seria sempre
  verdadeira. Volta quando existir a segunda.
- **Mudanças em `measureRecall`/`questions.json`** (discovery, item 6).
- **Fazer `runFanOut` respeitar `plan.tools`.** Continua chamando as duas ferramentas sempre —
  dívida da tarefa 00, não desta.
- **Ingestão, payload e reembedding.** Nenhum campo novo no índice; esta tarefa é só do lado da
  pergunta.
- **Paralelizar o embedding com a chamada de fatos** (seção 5). O campo `waitedForFactsMs` existe
  para que essa decisão, se voltar, volte com um número na mão.

## Implementação

Implementado em 2026-09-12, contra a spec fechada acima, sem reinterpretação.

**Criados**
- `src/retrieval/filters.ts` — `buildCurrentMatchweekFilter` + `CURRENT_MATCHWEEK_LOOKBACK_DAYS`.
  Função pura: janela de `publishedAt` a partir do `Math.min` das datas de `facts.matches` (nunca
  `matches[0]`), cláusula de `teams` condicional a `entity.team`, `null` quando não há cláusula
  nenhuma. Todos os casos degenerados da seção 9 (facts nulo, sem jogos, datas inválidas, janela
  vazia) devolvem "sem cláusula de data" em vez de lançar.
- `tests/retrieval/filters.test.ts` — os 12 casos da seção 11, incluindo o teste da ordem não
  cronológica (o jogo mais antigo na última posição do array) e a igualdade literal com o exemplo
  da seção 3.
- `docs/learning/05-rigid-filters.md` — o conceito da tarefa: pré-filtrar vs. pós-processar, por
  que `publishedAt` e não `payload.matchweek`, por que `Math.min` e não `matches[0]`, e o custo em
  paralelismo de um filtro que depende de um fato. Termina em "Por que não X?".

**Alterados**
- `src/vectorstore/qdrant.ts` — `ensureCollection` passa a garantir, sempre e no fim, um índice de
  payload `datetime` em `publishedAt` (idempotente; erro de rede sobe embrulhado, como o resto do
  arquivo).
- `src/agent/graph.ts` — `runContextCall` substitui a chamada direta a `searchContext` no fan-out:
  em `current_matchweek` espera `factsCall` defensivamente (`.catch(() => null)`, preservando a
  resiliência do `Promise.allSettled`) e monta o filtro; em `team_form` chama `searchContext`
  imediatamente, byte a byte como antes. `runFanOut` propaga `filter`/`waitedForFactsMs` ao trace.
- `src/agent/trace.ts` — `TraceEntry` (`search_vector_context`) ganhou `filter` e
  `waitedForFactsMs`, ambos obrigatórios. `formatTrace` imprime o sufixo `(waited Xs for
  fetch_facts_api)` quando `waitedForFactsMs > 0` e a linha `filter: ...`/`filter: none` antes dos
  ramos de erro/vazio/resultados.
- `src/generation/writer.ts` — instrução condicional no `system` quando `plan.mode ===
  "current_matchweek"` (falar do que já aconteceu antes do que falta, em texto corrido, sem
  seções fixas). `buildFactsSection`/`formatMatchLine` intocados.
- `src/retrieval/search-context.ts` — só o comentário do topo.
- `tests/graph.test.ts` — novo describe (`spec §5`) com os 6 casos da seção 11: filtro aplicado em
  `current_matchweek`, ausência de `filter` em `team_form`, não-espera em `team_form`, espera em
  `current_matchweek`, resiliência com `getFacts` rejeitando (com e sem `entity.team`).
- `tests/trace.test.ts` — os 5 objetos de amostra ganharam os campos novos; 3 casos novos
  (`filter: none` sem sufixo, filtro + wait, filtro presente com `results: []`).
- `tests/writer.test.ts` — 3 casos novos: instrução presente em `current_matchweek`, ausente em
  `team_form`, `buildFactsSection` mantendo a ordem de `facts.matches` sem reordenar.
- `tests/integration/vectorstore.test.ts` — um caso novo contra Qdrant real: 4 points com
  `publishedAt` controlados (antes da janela, dois dentro, um no futuro) e `teams` variados;
  confirma que o `range` de datetime e o `match` de `teams` filtram corretamente no servidor.
- `docs/architecture.md` — 3 linhas de glossário (`filter`, `publishedAt window`, `lookback`) e a
  nota de que a tarefa 04 implementou só o filtro rígido; `peso_metadado`/`decaimento_temporal`
  seguem pendentes (tarefa 05).
- `docs/learning/README.md` — linha nova apontando para `05-rigid-filters.md`.
- `README.md` — nota de migração pós-merge (`npm run index` uma vez, sem `--recreate`, cria o
  índice de payload).

**Sem desvio da spec.** Um ponto exigiu decisão de implementação não detalhada na spec: o tipo
`QdrantFilter["must"]`, gerado pelo cliente do Qdrant, é `Condition | Condition[] |
Record<string, unknown>` — largo demais para montar incrementalmente com `.push`. Resolvido com um
tipo `FilterClause` local (a forma concreta das duas cláusulas que este módulo produz), estruturalmente
compatível com `FieldCondition` do Qdrant — não é uma reinterpretação da spec, só o encaixe de tipo
que a seção 3 não precisava especificar.

**Commits** (branch `feat/04-current-matchweek-query`, a partir de `main`):
1. `docs(task-04): close discovery and technical spec`
2. `feat(retrieval): add the current_matchweek rigid filter`
3. `feat(vectorstore): ensure a datetime payload index on publishedAt`
4. `feat(agent): wire the current_matchweek filter into the fan-out and trace`
5. `feat(generation): order the current_matchweek narrative by what already happened`
6. `test(vectorstore): prove the publishedAt datetime range works server-side`

## Revisão
_A preencher._

## Testes

- `npm test` (typecheck + vitest, sem rede/Docker): **189/189 passando**, 20 arquivos.
- `npx vitest run --config vitest.integration.config.ts tests/integration/vectorstore.test.ts`
  contra Qdrant real: **6/6 passando**, incluindo o novo caso do filtro de datetime/teams.
- `npm run test:integration` completo, sem `LLM_CASSETTE` (chamadas reais): a suíte inteira tem
  flakiness pré-existente e não relacionada a esta tarefa — a chave Voyage do ambiente está sem
  método de pagamento (rate limit de 3 RPM), e `golden-rule.test.ts`/`recall.test.ts`/
  `ingestion-incremental.test.ts` competem pela mesma cota ao rodar em sequência; numa das rodadas,
  `golden-rule.test.ts` também bateu numa variação de fraseio do LLM (o redator escreveu "3 a 1",
  placar do visitante primeiro, em vez do padrão "1 a 3" que o regex do teste exige) — o texto
  citava o placar oficial corretamente, só numa ordem diferente da que o teste antecipa; o próprio
  arquivo já documenta que precisou de várias tentativas para gravar uma geração que passasse. Em
  `LLM_CASSETTE=replay`, `golden-rule.test.ts` falha porque o prompt do redator mudou (a instrução
  condicional desta tarefa) e o cassette commitado é anterior a essa mudança — esperado, e fora do
  escopo desta tarefa recravar o cassette (`golden-rule.test.ts` está explicitamente marcado como
  "não muda" na spec, seção 1). Isolado das outras suítes, o teste novo de `vectorstore.test.ts`
  passa de forma consistente contra Qdrant real (rodado 2x, 6/6 nas duas vezes).

Correção sugerida (fora do escopo desta tarefa, deixada para quem tocar `golden-rule.test.ts`
depois): regravar o cassette (`LLM_CASSETTE=record`) e considerar adicionar um método de pagamento
à chave Voyage do ambiente de teste, se o rate limit continuar incomodando `npm run test:integration`.
