# Tarefa 06: Loops de feedback

Fecha os dois loops descritos em `docs/architecture.md` § "Os dois loops de feedback". Depende
das tarefas 04 e 05 — os loops precisam de respostas reais para corrigir.

Até esta tarefa, o sistema responde **sem rede de proteção contra alucinação de placar**: a regra
de ouro vale por convenção e pelo contrato das ferramentas, mas nada a verifica em runtime.

## Status
- [x] Discovery  ← contexto de 2026-09-08; as 4 perguntas em aberto fecharam no grilling de
      2026-09-13, 6 decisões registradas abaixo
- [x] Refinamento técnico  ← spec fechada em 2026-09-13, sem pendência para o usuário
- [x] Implementação  ← concluída em 2026-09-13, em duas rodadas (ver seção abaixo)
- [ ] Revisão
- [ ] Testes

## Discovery

### O que já estava decidido (grilling de 2026-09-08, decisões 2 e 7 de `docs/architecture.md`)

- **Loop 1 — grading de documentos (*Corrective RAG*)**: um grader (`claude-haiku-4-5`) julga
  cada trecho recuperado, em paralelo, antes da geração. Se sobrar pouco, a query é reescrita e
  a busca refeita. **Teto: 2 reescritas.**
- **Loop 2 — self-check da resposta**: um crítico (`claude-opus-5`, effort `medium`) confere
  cada número da resposta contra os fatos vindos da API. **Teto: 1 refação.**
- **No teto, responder — nunca falhar.** A resposta sai marcada como baixa confiança, dizendo o
  que não foi encontrado.
- **Feedback humano persistido está fora de escopo.** Exige armazenar avaliações e um mecanismo
  para usar esse sinal; é projeto próprio.

### O que fechou no grilling de 2026-09-13

As quatro perguntas que o discovery de 2026-09-08 deixou em aberto — o critério de "sobrou pouco",
quem reescreve a query, como o crítico distingue número com e sem lastro, e o que o traço mostra —
foram respondidas assim:

1. **O crítico decide *se* há número órfão por verificação determinística, não por julgamento de
   modelo.** A função `findOrphanNumbers(state)` que hoje existe só como código de teste em
   `tests/integration/golden-rule.test.ts` — extrai os números da resposta por regex (descartando
   antes as citações `[pNN]`), monta o conjunto "permitido" a partir de `state.facts` e chama de
   órfão todo número fora dele — **é promovida a código de produção**. O `claude-opus-5` effort
   `medium` do crítico entra **depois** dessa checagem, e só para decidir **como** reescrever a
   resposta quando algo já foi sinalizado; nunca para decidir se algo está errado.

   O motivo: a regra de ouro é regra absoluta, não questão de julgamento. A checagem literal já
   está provada pelo teste que existe; reservar essa decisão ao modelo reintroduziria variância
   numa verificação que devia ser determinística, e custaria uma chamada de LLM até no caminho
   feliz — a resposta limpa, sem número órfão, que é o caso comum.

2. **O conjunto "permitido" precisa cobrir `recentForm`, não só `facts`** — consequência direta de
   a tarefa 05 já estar em `main`. Uma resposta de `team_form` cita legitimamente o placar de um
   dos 5 últimos jogos (`recentForm.matches[].score`) e o da partida de outra competição
   (`recentForm.otherCompetitionMatch.score`), que vêm de `getTeamForm` (API), não do índice. Sem
   estender o conjunto, **toda resposta de `team_form` que cumprisse seu próprio propósito seria
   marcada como alucinação.** A lista exata de números esperados nasce do que as seções com
   `source="api"` do prompt (`buildFactsSection` e `buildRecentFormSection`, em
   `src/generation/writer.ts`) realmente renderizam — não de uma lista arbitrária.

3. **O gatilho de reescrita do loop 1 é por proporção, não por número absoluto.** Se a proporção de
   trechos aprovados sobre os trechos julgados cair abaixo de um limiar, a query é reescrita e a
   busca é refeita. O limiar e sua justificativa são decisão técnica (seção 5 do refinamento). A
   razão de ser proporção: o número de trechos julgados varia — a tarefa 05 busca um pool de
   `k * CANDIDATE_POOL_FACTOR` antes do corte final, a tarefa 04 não amplia pool nenhum, e um
   filtro rígido pode devolver menos que `k`. **Teto: 2 reescritas.**

4. **A reescrita de query reusa o nó `planner`** (`src/agent/nodes/plan.ts`, `opus-5` effort
   `medium`), que passa a receber também o motivo da reprovação — quais trechos foram reprovados e
   por quê, resumido. Não entra modelo novo nem um terceiro estilo de prompt de busca no código.
   Como estender a assinatura sem quebrar a chamada original (a primeira, sem reescrita) é decisão
   técnica (seção 5).

5. **No teto do loop 2** — o crítico já refez a resposta uma vez e a checagem determinística ainda
   encontra número órfão — **a frase que contém o número órfão é removida por código
   determinístico**, não por mais uma chamada de LLM. A mecânica exata e os casos de borda (o
   número órfão está na mesma frase de uma citação válida; a resposta inteira gira em torno do
   número e removê-lo esvazia tudo) são decisão técnica (seção 9). O `answer` final sai com
   `lowConfidence: true` e uma explicação de que uma afirmação foi removida por falta de
   confirmação, em cima do que `computeLowConfidence`/`FinalState.answer` já fazem.

6. **O traço mostra as tentativas descartadas dos dois loops**: trechos reprovados pelo grader com
   o motivo, queries reescritas e por quê, e a refação do crítico — incluindo a resposta anterior e
   o que foi sinalizado nela. `TraceEntry` ganha os nós novos, seguindo o padrão já estabelecido no
   arquivo: **campo obrigatório mesmo quando vazio**, pela mesma razão que `filter`,
   `waitedForFactsMs` e `recentForm` já são obrigatórios desde as tarefas 04/05 — campo que só
   aparece quando tem valor é campo que ninguém sabe se foi medido.

## Refinamento técnico

Spec fechada em 2026-09-13 a partir do discovery acima. Nada aqui reabre decisão do discovery. As
quatro consequências que o discovery deixou explicitamente como "decisão técnica" — o limiar da
proporção (item 3), a forma de estender o `planner` (item 4), a mecânica da remoção de frase (item
5) e onde a checagem determinística mora (item 1) — são resolvidas nas seções 5, 5, 9 e 7.

### 0. O que esta tarefa é, em uma frase

O grafo deixa de ser uma linha reta: entre a busca e a escrita entra um grader que reprova trecho
irrelevante e manda reescrever a query (até 2x), e entre a escrita e a resposta entra um crítico
que **primeiro** confere, em código determinístico, se todo número da resposta tem lastro numa
chamada de API, e só chama o modelo quando algo foi sinalizado (até 1 refação) — e, se ainda assim
sobrar número sem lastro, a frase sai, determinísticamente, com aviso de baixa confiança.

### 1. Sobre qual base esta spec foi escrita

Contra `main` com as tarefas 00–05 mergeadas. O que já existe e esta spec **usa como está**:

- `src/agent/graph.ts`: `answer`, `runFanOut`, `runContextCall`, `runFactsCall`, `forceNonEmptyTools`;
- `src/agent/state.ts`: `InitialState → StateWithEntity → StateWithPlan → StateWithData → FinalState`,
  e `Answer { text, citedPassages, lowConfidence }`;
- `src/agent/trace.ts`: `TraceEntry` (união discriminada por `node`), `measure`, `record`,
  `formatTrace`, `describeLowConfidence`;
- `src/agent/llm.ts`: `callStructured` (saída validada por `zod`) e `callText` (prosa);
- `src/generation/writer.ts`: `buildPrompt`, `buildRecentFormSection`, `write`,
  `computeLowConfidence`, `extractCitations`;
- `src/generation/match-format.ts`: `isoDateParts`, `formatMatchDate`, `teamName`;
- `src/config/models.ts`: `MODELS`, com o comentário `// grader and critic arrive in task 06`.

**Esta é a primeira tarefa a tocar o desenho dos dois loops depois de ele ser puramente
arquitetural.** Até aqui o grafo é `extractEntity → plan → fan-out → write`, sem ciclo nenhum — o
comentário de `answer()` diz literalmente "No cycles (those are task 06)".

### 2. O modelo mental: dois loops, duas naturezas

Os dois loops parecem simétricos ("gera, confere, refaz") e **não são**. A diferença é o que está
sendo conferido, e ela decide quem julga:

| | Loop 1 — grading | Loop 2 — self-check |
|---|---|---|
| o que se pergunta | "este trecho ajuda a responder?" | "este número tem lastro na API?" |
| natureza da pergunta | **julgamento** — depende de sentido | **fato verificável** — é pertencimento a conjunto |
| quem decide | modelo (`haiku-4-5`, N em paralelo) | **código** (`findOrphanNumbers`) |
| o que o modelo faz | decide *se* reprova, e diz por quê | decide só *como* consertar |
| o que se corrige | a **entrada** (a query, e portanto os trechos) | a **saída** (o texto da resposta) |
| teto | 2 reescritas | 1 refação |

"Relevância" não tem definição fechada — por isso ali um LLM é a ferramenta certa. "Este número
saiu de `facts` ou não?" tem: é uma comparação de conjuntos. Usar um LLM para responder isso seria
trocar uma verificação exata por uma amostra de uma distribuição — e ainda pagar uma chamada em
toda resposta limpa. É essa assimetria que o doc de aprendizado desta tarefa tem de deixar clara:
**num RAG, "avaliar relevância" e "verificar fato" não são o mesmo problema, e não pedem a mesma
ferramenta.**

A consequência de custo é direta: no caminho feliz (resposta limpa), o loop 2 custa **zero** chamada
de LLM.

### 3. Modelos e constantes — `src/config/models.ts` (alterado)

As duas linhas que faltavam, exatamente como a tabela de `docs/architecture.md` fixa:

```ts
export const MODELS = {
  entityExtraction: { model: "claude-haiku-4-5", maxTokens: 512 },
  passageClassification: { model: "claude-haiku-4-5", maxTokens: 128 },
  planner: { model: "claude-opus-5", effort: "medium", maxTokens: 1024 },
  /** One call per retrieved passage, N in parallel — the answer is a boolean plus one sentence. */
  grader: { model: "claude-haiku-4-5", maxTokens: 256 },
  writer: { model: "claude-opus-5", effort: "high", maxTokens: 2048 },
  /** Only ever called after the deterministic check flagged something — it rewrites a whole
   *  answer, so it gets the writer's token budget, not the grader's. */
  critic: { model: "claude-opus-5", effort: "medium", maxTokens: 2048 },
} as const satisfies Record<string, ModelConfig>;
```

O comentário `// grader and critic arrive in task 06` sai. `EMBEDDING` não muda.

As constantes de política dos loops moram junto do nó que as usa, não num arquivo de config: elas
são a decisão desta tarefa, e o teste que as trava tem de importá-las.

```ts
// src/agent/nodes/grade.ts
/** Below this ratio of approved passages the query gets rewritten (spec §5). */
export const GRADER_APPROVAL_THRESHOLD = 0.4;
/** Ceiling of decision 7 in docs/architecture.md: at most 2 rewrites, so at most 3 searches. */
export const MAX_QUERY_REWRITES = 2;

// src/agent/nodes/critic.ts
/** Ceiling of decision 7 in docs/architecture.md: the model gets exactly one shot at fixing
 *  the answer; after that the fix is deterministic (spec §9). */
export const MAX_ANSWER_REWRITES = 1;
```

### 4. Loop 1, o grader — `src/agent/nodes/grade.ts` (novo)

```ts
import { z } from "zod";
import type { SearchResult } from "../../vectorstore/types.ts";

export const passageGradeSchema = z.strictObject({
  relevant: z.boolean(),
  /** One short sentence, in Portuguese — it shows up in the trace, like plan.rationale. */
  reason: z.string().min(1),
});

export interface PassageGrade {
  passageId: string;
  chunkIndex: number;
  relevant: boolean;
  reason: string;
  /** Set when the grader call itself failed. In that case `relevant` is true: an infra
   *  failure never silently drops a passage the search did retrieve. */
  error?: string;
}

export interface GradeOutcome {
  /** One per input result, in the same order — length always equals results.length. */
  grades: PassageGrade[];
  /** What the writer gets: every result whose grade came back `relevant`, plus the ones
   *  whose grader call failed. Same relative order as the input. */
  approved: SearchResult[];
  /** How many grader calls actually answered. Failures don't count. */
  judged: number;
  /** approved-among-judged / judged. `null` when judged === 0 — nothing was judged, so
   *  there is no evidence either way about the query. */
  approvedRatio: number | null;
}

/**
 * Judges each retrieved passage against the question, one call per passage, all in parallel.
 * Never rejects: a failed call becomes a kept passage with `error` set.
 */
export async function gradePassages(params: { question: string; results: SearchResult[] }): Promise<GradeOutcome>;

/** The rewrite trigger (discovery, item 3). Pure — no LLM, no I/O. */
export function shouldRewriteQuery(outcome: GradeOutcome): boolean;

/** The one-line summary that goes into the rewrite prompt and into the trace. */
export function summarizeRejections(outcome: GradeOutcome): { passageId: string; reason: string }[];
```

**Uma chamada por trecho, não uma chamada com todos.** Duas razões: é o paralelismo que o diagrama
de `docs/architecture.md` promete ("grader de relevancia, haiku-4-5, N em paralelo") e que esta
tarefa existe para tornar visível; e julgamentos independentes não se contaminam — num prompt único
com cinco trechos, o modelo compara os trechos entre si e produz um ranking disfarçado de
avaliação, quando a pergunta é "este trecho, sozinho, ajuda?".

`Promise.allSettled` sobre as N chamadas. N é `results.length`, no máximo `k` (padrão 5): não há
limitador de concorrência, e não precisa haver.

Prompt do grader (system), em português como os outros:

```
Você avalia se um trecho de notícia ajuda a responder uma pergunta sobre futebol brasileiro.
Responda relevant: true se o trecho traz contexto, narrativa ou explicação útil para a pergunta.
Responda relevant: false se ele é sobre outro assunto, outro jogo ou outro time, ou se é só ruído
(nota de bilheteria, tabela de transmissão, chamada para outra matéria).
Julgue RELEVÂNCIA, não correção: um trecho que fala do jogo certo continua sendo relevante mesmo
que os números dele estejam errados — conferir número é trabalho de outra etapa.
reason é uma frase curta dizendo por quê.
```

A penúltima linha não é detalhe: o corpus de avaliação tem, de propósito, uma crônica com o placar
errado (`p07`), e o teste da regra de ouro depende dela **chegar ao redator** para provar que o
redator não a copia. Um grader que reprovasse trecho por ter número errado quebraria esse teste e,
pior, esconderia justamente o caso que o loop 2 existe para pegar.

User message: a pergunta, e o trecho com `passageId`, `type`, `source`, `title` e `text` — o mesmo
recorte que `buildContextSection` já manda ao redator.

`shouldRewriteQuery`, literal:

1. `grades.length === 0` (a busca não trouxe nada) → **`true`**. Retrieval vazio é a evidência mais
   forte possível de que a query não está funcionando.
2. `approvedRatio === null` (nenhuma chamada de grader respondeu) → **`false`**. Reescrever aqui
   seria tratar uma falha de infraestrutura como sinal sobre a query, e gastar duas chamadas de
   `opus-5` + dois embeddings para chegar ao mesmo lugar.
3. caso contrário → `approvedRatio < GRADER_APPROVAL_THRESHOLD`, **estritamente menor**.

#### Por que 0.4, e por que proporção

Com o `k` padrão de 5, `< 0.4` significa: reescreve quando **no máximo 1 dos 5** trechos sobrevive.
Dois de cinco (`0.4`) não dispara — é pouco, mas é contexto suficiente para uma resposta honesta
com citação, e reescrever custaria uma chamada de `opus-5` e um embedding para talvez trocar dois
trechos bons por dois trechos bons diferentes.

Proporção e não contagem absoluta porque **o denominador varia por motivo que nada tem a ver com a
qualidade da query**: o modo `team_form` busca um pool de `k * CANDIDATE_POOL_FACTOR` e corta em `k`
depois do decaimento; o `current_matchweek` não amplia pool nenhum; e o filtro rígido dos dois modos
pode devolver menos que `k` (coleção pequena, janela de `publishedAt` estreita, time pouco citado).
Um gatilho "menos de 2 aprovados" trataria "1 de 2 recuperados" (metade do que veio serve) igual a
"1 de 5" (quase nada serve) — e o primeiro caso é comum num índice recém-populado, onde reescrever
duas vezes não vai fazer aparecer trecho que não foi indexado.

**O grading roda sobre o `context` final — o top-`k` já cortado —, não sobre o pool de candidatos.**
O pool existe para o decaimento reordenar (tarefa 05); julgar os 20 custaria 20 chamadas de haiku
por pergunta para descartar informação que o ranking já descartou.

#### Exemplo literal

Entrada: pergunta `"o Palmeiras está numa fase ruim?"`, 3 resultados (`p03`, `p11`, `p07`).

Saída de `gradePassages` (com o `payload` dos `SearchResult` abreviado):

```json
{
  "grades": [
    { "passageId": "p03", "chunkIndex": 0, "relevant": true,  "reason": "analisa a sequência recente do Palmeiras, que é exatamente o assunto da pergunta" },
    { "passageId": "p11", "chunkIndex": 0, "relevant": false, "reason": "é nota sobre venda de ingressos, não fala da fase do time" },
    { "passageId": "p07", "chunkIndex": 0, "relevant": true,  "reason": "crônica do último jogo do Palmeiras, dá contexto para a fase" }
  ],
  "approved": [
    { "id": 3, "score": 0.557, "payload": { "passageId": "p03" } },
    { "id": 7, "score": 0.421, "payload": { "passageId": "p07" } }
  ],
  "judged": 3,
  "approvedRatio": 0.6666666666666666
}
```

`shouldRewriteQuery` desse `GradeOutcome` é `false` (`0.667 >= 0.4`). Se `p03` e `p07` também
tivessem sido reprovados, `approvedRatio` seria `0` e o loop reescreveria.

### 5. Loop 1, a reescrita de query — `src/agent/nodes/plan.ts` (alterado)

O `planner` ganha um **segundo parâmetro opcional**. A chamada original — `plan(state)`, na primeira
tentativa — não muda de forma nem de comportamento.

```ts
export interface QueryRewriteContext {
  /** The searchQuery that produced the rejected passages. */
  previousQuery: string;
  /** Which passages the grader rejected, and why — this is what makes the rewrite
   *  *corrective* instead of a second guess at the same question. Empty when the search
   *  returned nothing at all. */
  rejected: { passageId: string; reason: string }[];
  /** 1-based; MAX_QUERY_REWRITES is the ceiling. Goes in the prompt so the model knows it
   *  is already on a retry. */
  attempt: number;
}

export async function plan(state: StateWithEntity, rewrite?: QueryRewriteContext): Promise<StateWithPlan>;
```

Por que estender o `plan` e não criar `rewriteQuery` ao lado: o trabalho é o mesmo — transformar
pergunta em query de busca semântica —, e duas funções significariam dois prompts para manter em
sincronia, com a garantia de divergirem. O parâmetro opcional deixa o caminho de hoje intacto e
soma umas poucas linhas ao prompt quando há correção a fazer. É a menor mudança que satisfaz o
item 4 do discovery.

Quando `rewrite` é passado, o **system** ganha, no fim:

```
Esta é uma REESCRITA: a busca anterior trouxe trechos que um avaliador considerou irrelevantes.
Mantenha o mesmo mode e as mesmas tools — mude apenas o searchQuery.
O novo searchQuery tem de ser realmente diferente do anterior: troque os termos, generalize ou
especifique. Reordenar as mesmas palavras não muda a busca vetorial.
```

e o **user** ganha um bloco, depois da entidade:

```
Busca anterior: "sequência recente do Palmeiras"
Trechos reprovados pelo avaliador:
- [p11] é nota sobre venda de ingressos, não fala da fase do time
- [p04] fala do time feminino, não do elenco principal
Tentativa de reescrita: 1 de 2
```

Com `rejected` vazio (nada foi recuperado), a segunda linha vira
`A busca anterior não recuperou nenhum trecho.`

**O grafo aproveita só o `searchQuery` do resultado.** `mode`, `tools` e `rationale` continuam os da
primeira chamada:

```ts
const plan = { ...state.plan, searchQuery: rewritten.plan.searchQuery };
```

Isso não é desconfiança gratuita do modelo: `mode` escolhe a configuração de retrieval inteira
(filtro rígido de time, pool ampliado, decaimento) e já decidiu, três nós atrás, que chamadas de
fato fazer. Um `mode` que vira no meio do loop produziria uma busca com filtro diferente da que o
resto do estado descreve, e um trace que mente. A instrução no prompt pede que ele mantenha; o
grafo garante.

**Guarda de query idêntica**: se o `searchQuery` novo for igual ao anterior depois de `trim()` e
`toLowerCase()`, o loop **para** — refazer a mesma busca devolve os mesmos trechos e os mesmos
julgamentos, e só queimaria chamadas. Isso é registrado no traço (`queryRewrite` com
`newQuery === previousQuery` e o passo seguinte ausente).

### 6. Loop 1, o laço no grafo — `src/agent/graph.ts` (alterado)

#### Uma extração antes: a busca sem a espera

`runContextCall` hoje faz duas coisas: espera os fatos (no `current_matchweek`) e busca. A retentativa
precisa só da segunda — os fatos já responderam, e a rodada não muda em três segundos. Então:

```ts
/**
 * The search itself, with this mode's retrieval configuration. Extracted from
 * runContextCall so the grading loop can re-run only this half on a rewrite: the facts
 * branch already answered, and refetching it would be a second call to the football API
 * for data that cannot have changed mid-question.
 */
async function runSearch(state: StateWithPlan, facts: Facts | null): Promise<ContextOutcome>;
```

`runContextCall(state, factsCall)` passa a: esperar os fatos (só no `current_matchweek`), medir a
espera e delegar a `runSearch`, sobrescrevendo `waitedForFactsMs`. Os três caminhos de retrieval
(janela + time; time + pool + decaimento; nada) ficam **byte a byte** os de hoje, dentro de
`runSearch`. Nenhum teste de `tests/graph.test.ts` sobre o fan-out muda de resultado.

#### O laço

```ts
/**
 * Loop 1 (Corrective RAG): grades what the search brought, and rewrites the query when too
 * little survives. Exported separately so the whole loop is testable with mocked nodes.
 */
export async function runGradingLoop(state: StateWithData, trace: TraceEntry[]): Promise<StateWithData>;
```

O algoritmo, em ordem:

1. `attempt = 1`, `results = state.context`, `bestApproved = null`, `bestAttempt = 1`.
2. Chama `gradePassages({ question: state.question, results })` dentro de `measure`, e grava a
   entrada de traço `grader` com `attempt`.
3. Se `outcome.approved.length > (bestApproved?.length ?? -1)`, `bestApproved = outcome.approved` e
   `bestAttempt = attempt`. **Estritamente maior**: em empate fica a tentativa mais antiga.
4. Se `!shouldRewriteQuery(outcome)` → sai do laço.
5. Se `attempt > MAX_QUERY_REWRITES` (ou seja, já houve 2 reescritas) → sai do laço. **Teto
   atingido: o sistema responde, não falha.**
6. Chama `plan(state, { previousQuery, rejected: summarizeRejections(outcome), attempt })` dentro de
   `measure`, e grava a entrada `queryRewrite`. Se a chamada **rejeitar**, grava a entrada com
   `error` e sai do laço com o que já tem.
7. Se o `searchQuery` novo for igual ao anterior (`trim().toLowerCase()`), sai do laço.
8. `state.plan.searchQuery` passa a ser o novo. Chama `runSearch({ ...state, plan }, state.facts)`
   dentro de `measure`, grava uma nova entrada `search_vector_context` com `attempt = attempt + 1` e
   a `query` nova. Se `runSearch` **rejeitar**, grava a entrada com `error` e `results: []`, e sai do
   laço.
9. `results` = o que voltou, `attempt += 1`, volta ao passo 2.

No fim, devolve `{ ...state, context: bestApproved ?? [], plan }` — com `plan` carregando o
`searchQuery` que efetivamente produziu o contexto escolhido.

**Por que "a melhor tentativa" e não "a última".** Uma reescrita pode piorar: a tentativa 1 aprova 2
trechos, a 3 aprova 0. Entregar a última seria deixar o loop de correção corrigir para baixo. A
regra é uma linha de bookkeeping e o traço mostra as três tentativas de qualquer jeito — quem lê vê
que a 1 ganhou. A entrada `writer` registra `contextFromAttempt`, para isso não ser invisível.

**Custo no pior caso**: 3 buscas (3 embeddings), 3 rodadas de grading (≤ 15 chamadas de haiku) e 2
chamadas de `opus-5` medium. É o teto que a decisão 7 de `docs/architecture.md` fixou; o traço
imprime o total de chamadas de LLM, então o custo fica visível em vez de suposto.

#### Onde o laço entra em `answer()`

```
extractEntity → plan → runFanOut (fatos ‖ busca #1) → runGradingLoop → write → critique → FinalState
```

`answer()` continua devolvendo `FinalState`, e esse tipo de retorno continua sendo a garantia de que
nenhum caminho sai do grafo sem resposta.

### 7. Loop 2, a checagem determinística — `src/agent/nodes/critic.ts` (novo)

```ts
import type { StateWithData, FinalState } from "../state.ts";

/**
 * Every number the api-sourced sections of the prompt legitimately render (discovery, item 2).
 * Pure: no LLM, no I/O, no clock.
 */
export function allowedNumbers(state: Pick<StateWithData, "facts" | "recentForm">): Set<number>;

/**
 * The numbers in `text` that are in no way backed by the API. Citations are stripped first —
 * the digits in `[p07]` belong to a passage id, not to a fact.
 */
export function findOrphanNumbers(text: string, allowed: Set<number>): number[];
```

`allowedNumbers` monta o conjunto assim — e a lista não é arbitrária, ela **espelha o que
`buildFactsSection` e `buildRecentFormSection` renderizam**:

De `state.facts`, quando não é `null`:
- `facts.matchweek` e `facts.competition.season`;
- todo dígito de `facts.competition.name` (a seção imprime o nome do campeonato; se um dia ele tiver
  ano no meio, esse ano é fato de API);
- por jogo de `facts.matches`: `day` e `month` de `isoDateParts(match.date)` — **exatamente como
  `formatMatchDate` faz**, lendo os dígitos da string ISO, nunca `new Date(...).getDate()`, que
  depende do fuso da máquina (foi o bug que a revisão da tarefa 00 consertou);
- por jogo com `status === "finished"` ou `"live"`: `score.home` e `score.away`;
- por jogo `live` com `minute !== null`: `minute`.

De `state.recentForm`, quando não é `null` (só existe no modo `team_form`):
- `recentForm.matches.length` — a seção escreve "últimos N jogos";
- `record.wins`, `record.draws`, `record.losses`;
- por jogo de `recentForm.matches`: `day`, `month`, `score.home`, `score.away`;
- de `recentForm.otherCompetitionMatch`, quando não é `null`: os mesmos quatro, mais todo dígito de
  `competition.name`.

Nada mais. Em particular, **hora e minuto da data não entram**: `formatMatchDate` só renderiza
`dd/mm`, então um horário na resposta é número que o redator não recebeu de fonte nenhuma.

`findOrphanNumbers`, literal:

1. `text.replace(/\[[a-zA-Z0-9]+\]/g, "")` — as citações saem primeiro;
2. `[...semCitacoes.matchAll(/\d+/g)].map(Number)`;
3. devolve, **sem repetição e na ordem de aparição**, os que não estão em `allowed`.

#### Exemplo literal

Estado (recorte): `facts` com `matchweek: 12`, `competition.season: 2026`, um jogo encerrado
`1 x 3` em `2026-09-05T21:30:00-03:00` e um jogo `live` `0 x 0` aos `67'` em
`2026-09-06T16:00:00-03:00`; `recentForm` com 5 jogos, `record { wins: 2, draws: 1, losses: 2 }`,
placares `1x3` (05/09), `0x2` (31/08), `2x1` (24/08), `1x1` (17/08), `3x0` (10/08), e
`otherCompetitionMatch` `2 x 0` em `2026-09-03`, `competition.name: "Copa Libertadores"`.

`allowedNumbers(state)`, ordenado para leitura:

```json
[0, 1, 2, 3, 5, 6, 8, 9, 10, 12, 17, 24, 31, 67, 2026]
```

Resposta gerada:

```
O Palmeiras perdeu por 1 x 3 para o Fluminense [p03] e vinha de uma sequência de 4 vitórias
seguidas. O time soma 2V 1E 2D nos últimos 5 jogos do Brasileirão.
```

`findOrphanNumbers(text, allowed)` → `[4]`. O `1`, o `3`, o `2`, o `5` e o `1` do retrospecto têm
lastro; o `4` de "4 vitórias seguidas" é uma contagem que o redator derivou sozinho — e é
exatamente o tipo de número que a regra de ouro proíbe.

#### Limitação declarada: só dígitos

A checagem vê `4`, não vê "quatro". Um número **por extenso** ("dois a zero") passa por ela. Isso é
aceito e não é regressão: (a) o system prompt do redator já proíbe repetir número do `<context>` em
qualquer grafia; (b) `tests/integration/golden-rule.test.ts` trava as grafias por extenso do placar
armadilha com `WRONG_SCORE_PATTERNS`, e continua fazendo isso; (c) a alternativa — pedir ao modelo
que encontre números por extenso — devolveria a decisão "há erro?" ao julgamento, que é justamente o
que o item 1 do discovery tirou dele.

#### Por que dentro de `src/agent/nodes/`, e não num `src/critic/`

O crítico é um nó do grafo, como o grader, o planner e a extração de entidade — e os nós moram em
`src/agent/nodes/`. Um diretório de topo só para ele sugeriria um subsistema, e o arquivo tem duas
funções puras e uma chamada de modelo. Pela mesma razão as funções puras ficam **no mesmo arquivo**
do nó, exportadas: é o padrão que o repositório já usa em `writer.ts` (`buildPrompt`/`write`) e em
`team-form.ts` (`mapTeamForm`/`getTeamForm`) — metade pura testável sem gastar API, metade que fala
com o mundo.

### 8. Loop 2, a refação pelo modelo

```ts
export interface CriticReport {
  /** What the deterministic check found on the answer the writer produced. */
  orphanNumbers: number[];
  /** Whether the model was called at all. False on the happy path. */
  rewritten: boolean;
  /** What the deterministic check found on the rewritten answer. [] when it wasn't needed. */
  remainingOrphanNumbers: number[];
  /** The sentences the deterministic redaction removed at the ceiling. [] otherwise. */
  redactedSentences: string[];
  /** The answer before the rewrite. null when there was no rewrite. */
  previousAnswer: string | null;
  /** The critic call itself failed — the one allowed rewrite is spent either way, so the
   *  deterministic redaction still runs on the original answer (same as a rewrite that ran
   *  and still left an orphan number); `redactedSentences` may be non-empty here too. */
  error?: string;
}

/**
 * Loop 2 (self-check): deterministic check first, model only to fix what it flagged.
 * Returns the state to hand back to the CLI plus the report the graph turns into a trace entry.
 */
export async function critique(state: FinalState): Promise<{ state: FinalState; report: CriticReport }>;
```

Ordem exata:

1. `allowed = allowedNumbers(state)`; `orphans = findOrphanNumbers(state.answer.text, allowed)`.
2. `orphans.length === 0` → devolve o estado **intacto**, com
   `{ orphanNumbers: [], rewritten: false, remainingOrphanNumbers: [], redactedSentences: [], previousAnswer: null }`.
   **Zero chamada de LLM.**
3. Senão, uma chamada `callText({ config: MODELS.critic, ... })`. Se ela rejeitar, **não** devolve
   o estado intacto: a refação por LLM está gasta (o teto de `MAX_ANSWER_REWRITES` já foi
   consumido, com ou sem sucesso), então cai direto na mesma remoção determinística da seção 9 —
   como se a refação tivesse rodado e ainda deixado o número órfão. O relatório sai com `error`
   preenchido, `rewritten: false`, e `redactedSentences` pode não estar vazio (correção registrada
   na "Rodada de correção" ao fim deste arquivo — a versão original desta spec previa a resposta
   original intacta nesse caminho, o que deixava um número sem lastro vazar).
4. Com o texto novo: `citedPassages = extractCitations(novoTexto, retrievedIds)` — recalculado, não
   herdado: a refação pode ter tirado a frase que carregava uma citação, e uma lista de fontes que
   não aparecem mais no texto é um traço que mente.
5. `remaining = findOrphanNumbers(novoTexto, allowed)`.
   - `[]` → resposta nova, `lowConfidence` continua sendo `computeLowConfidence(state)` — **sem
     penalidade**. O número sem lastro sumiu; marcar baixa confiança aqui seria punir o sistema por
     ter funcionado. Quem quiser saber que houve refação lê o traço.
   - não vazio → seção 9.

Prompt do crítico. O user message é montado **só com as seções `source="api"`** — nunca com o
`<context>`:

```
Pergunta: <question>

<facts source="api">…</facts>
<recent_form source="api">…</recent_form>     (só no modo team_form)

Números permitidos: 0, 1, 2, 3, 5, 6, 8, 9, 10, 12, 17, 24, 31, 67, 2026
Números sem lastro encontrados na resposta: 4

Resposta a corrigir:
<answer>…</answer>
```

Passar o `<context>` ao crítico seria colocar na mesa do revisor exatamente a fonte dos números que
ele está removendo. O prompt (system):

```
Você revisa uma resposta sobre futebol brasileiro que contém números sem lastro nos dados oficiais.
Reescreva a resposta removendo ou generalizando TODA afirmação que dependa de um número da lista de
números sem lastro. Os únicos números que podem aparecer no texto corrigido são os da lista de
números permitidos.
Preserve o resto: o sentido, o tom, o idioma e as citações [passageId] das frases que ficarem.
Nunca invente número, nunca troque um número errado por outro.
Devolva apenas o texto corrigido, sem comentário, sem explicação e sem marcação.
```

As seções vêm de `buildFactsSection` e `buildRecentFormSection` de `src/generation/writer.ts`. A
segunda já é exportada; **`buildFactsSection` passa a ser exportada** (nenhuma mudança de
comportamento) para o crítico reusar a renderização exata que o redator viu. Duas renderizações
diferentes dos mesmos fatos é como um crítico passa a discordar do redator por formatação.

### 9. Loop 2, o teto: a remoção determinística (discovery, item 5)

```ts
/** The sentence that replaces an answer whose every sentence had to go. */
export const REDACTED_ANSWER_NOTICE =
  "Não consegui responder com números confirmados pela API: toda a resposta gerada dependia de números sem confirmação nos dados oficiais, e foi removida.";

/** Appended to a partially redacted answer. */
export const REDACTION_NOTICE =
  "(Uma ou mais afirmações foram removidas desta resposta: continham números sem confirmação nos dados oficiais da API.)";

export interface RedactionResult {
  text: string;
  /** The sentences that were dropped, verbatim — the trace prints them. */
  removedSentences: string[];
}

/** Deterministic, no LLM: drops every sentence that carries an orphan number. */
export function redactOrphanSentences(text: string, orphans: number[]): RedactionResult;
```

As duas constantes são **texto da resposta ao usuário**, e a resposta é em português — mesma regra
que já põe os prompts e `"agendado"`/`"adiado"` em português dentro do código. Identificador,
mensagem de erro e comentário continuam em inglês.

Mecânica, literal:

1. **Segmentação por sentença** com `/[^.!?…]+[.!?…]+\s*|[^.!?…]+$/g`. Cada fatia carrega a própria
   pontuação final e o espaço em branco que a segue, de modo que `fatias.join("")` reproduz a
   entrada **exatamente** — nenhum espaço duplicado, nenhuma quebra de linha perdida quando uma
   fatia sai.
2. Uma fatia é removida se, depois de tirar as citações `[pNN]`, os números dela (mesma extração
   `/\d+/g` do `findOrphanNumbers`) intersectam `orphans`. Comparar por número extraído, e não por
   substring, é o que impede `12` de casar dentro de `2026`.
3. Sobreviventes: `join("")` e `trim()`.
4. **Se sobrar pelo menos uma frase** → `text = sobreviventes + " " + REDACTION_NOTICE`.
5. **Se não sobrar nenhuma** (ou o que sobrou for vazio depois do `trim()`) → `text =
   REDACTED_ANSWER_NOTICE`. Sem tentar remontar uma resposta a partir dos fatos: seria um segundo
   redator escondido no crítico, e o traço logo acima já imprime os jogos com placar e data.

Depois da remoção, dentro de `critique`:

- `citedPassages = extractCitations(textoFinal, retrievedIds)` — a frase que saiu levou a citação
  dela junto. Esse é o **caso de borda do número órfão na mesma frase de uma citação válida**: a
  frase inteira sai. Manter meia frase exigiria entender a estrutura da sentença, e a alternativa —
  apagar só o numeral — produz "o time vinha de vitórias seguidas", uma afirmação que ninguém
  escreveu e cuja fonte não confirma nada;
- `lowConfidence: true`, sempre, mesmo quando `computeLowConfidence(state)` é `false`. É o "no teto,
  responder — nunca falhar" desta tarefa: a resposta sai, mutilada e avisada.

#### Exemplo literal

Entrada (`orphans = [4]`):

```
O Palmeiras perdeu por 1 x 3 para o Fluminense [p03]. O time vinha de 4 vitórias seguidas [p05]. A pressão sobre o técnico aumentou.
```

Saída:

```json
{
  "text": "O Palmeiras perdeu por 1 x 3 para o Fluminense [p03]. A pressão sobre o técnico aumentou. (Uma ou mais afirmações foram removidas desta resposta: continham números sem confirmação nos dados oficiais da API.)",
  "removedSentences": ["O time vinha de 4 vitórias seguidas [p05]. "]
}
```

`citedPassages` passa de `["p03", "p05"]` para `["p03"]`.

### 10. O redator — `src/generation/writer.ts` (alterado)

Duas mudanças pequenas, nenhuma delas na forma de `buildPrompt`/`write`.

**1. Uma instrução nova no system**, logo depois da proibição de repetir número do `<context>`:

```ts
"Não calcule nem derive números novos (somas, médias, totais, sequências do tipo \"4 jogos sem vencer\"): só escreva números que apareçam literalmente nas seções com source=\"api\".",
```

Isso não é enfeite: a checagem determinística do crítico é, por construção, **literal**, e um total
que o redator soma de cabeça não está em `facts` nem em `recentForm`. Sem essa linha, o loop 2
dispararia no caminho feliz — um loop de correção que corrige o efeito de uma instrução que falta
é um loop caro para consertar um prompt.

**2. `buildFactsSection` passa a ser exportada** (seção 8). Nenhuma outra mudança: o corpo, o texto
das seções e `computeLowConfidence` ficam idênticos.

### 11. O traço — `src/agent/trace.ts` (alterado)

Três variantes novas na união, e dois campos novos em variantes existentes. Tudo **obrigatório**,
mesmo quando vazio — campo que só aparece quando tem valor é campo que ninguém sabe se foi medido
(tarefas 04/05, mesma regra).

```ts
| {
    node: "grader";
    /** MODELS.grader.model — the N parallel calls all use it. */
    model: string;
    /** The whole parallel batch, not the sum of the calls. */
    ms: number;
    /** 1-based: 1 is the fan-out's search, 2 and 3 come after a rewrite. */
    attempt: number;
    /** One per judged passage, in retrieval order. [] when nothing was retrieved. */
    grades: PassageGrade[];
    /** grades.filter(g => g.relevant).length — kept explicit so the trace doesn't have to
     *  recompute the number the decision was made on. */
    approved: number;
    judged: number;
    /** null when judged === 0. */
    approvedRatio: number | null;
    threshold: number;
    /** Whether this grading round triggered a query rewrite. */
    rewriting: boolean;
  }
| {
    node: "queryRewrite";
    model: string;
    ms: number;
    /** 1-based, at most MAX_QUERY_REWRITES. */
    attempt: number;
    previousQuery: string;
    /** Equal to previousQuery when the planner produced no real change — the loop stops there. */
    newQuery: string;
    rejected: { passageId: string; reason: string }[];
    /** The rewrite call itself failed; the loop stops with the context it already had. */
    error?: string;
  }
| {
    node: "critic";
    /** null when no LLM call was needed — the happy path. */
    model: string | null;
    ms: number;
    orphanNumbers: number[];
    rewritten: boolean;
    remainingOrphanNumbers: number[];
    redactedSentences: string[];
    previousAnswer: string | null;
    error?: string;
  }
```

Em `search_vector_context`, dois campos novos obrigatórios:

```ts
    /** 1-based: which search of the grading loop this was. */
    attempt: number;
    /** The searchQuery actually embedded. Implicit in the planner entry until task 06 — from
     *  now on it changes per attempt, so it has to be on the entry that used it. */
    query: string;
```

Em `writer`, um campo novo obrigatório:

```ts
    /** Which grading attempt's approved context the writer actually saw (spec §6). */
    contextFromAttempt: number;
```

#### Impressão

`grader`, `queryRewrite` e `critic` são passos numerados (incrementam `stepNumber`), como o
`planner` e o `writer`. A entrada `search_vector_context` com `attempt === 1` continua sendo
impressa **exatamente como hoje**, dentro do bloco de fan-out; com `attempt > 1` vira um passo
numerado próprio.

```
[4] grader    claude-haiku-4-5 ×3 in parallel    1.12s    attempt 1/3
    approved 1 of 3 judged   ratio 0.33 < threshold 0.40   → rewriting the query
    ✓ p03  "analisa a sequência recente do Palmeiras"
    ✗ p11  "é nota sobre venda de ingressos, não fala da fase do time"
    ✗ p04  "fala do time feminino, não do elenco principal"

[5] queryRewrite    claude-opus-5 (effort medium)    2.30s    attempt 1/2
    from: "sequência recente do Palmeiras"
    to:   "fase do Palmeiras: desempenho e resultados das últimas semanas"

[6] search_vector_context (attempt 2)    voyage-3.5    0.80s
    query: "fase do Palmeiras: desempenho e resultados das últimas semanas"
    filter: {"must":[{"key":"teams","match":{"value":"palmeiras"}}]}
    k=5 over 97 points in collection camisa10   (pool of 20, time decay: half-life 14d)
    #1  0.612  p09  chronicle  "o time chegou ao quarto jogo sem vencer…"

[7] grader    claude-haiku-4-5 ×4 in parallel    0.98s    attempt 2/3
    approved 3 of 4 judged   ratio 0.75 >= threshold 0.40   → keeping this context

[8] writer    claude-opus-5 (effort high)    6.10s
    allowed numbers: only the API facts above
    context from attempt 2
    cited: p09, p12   (retrieved but not cited: p03)

[9] critic    deterministic check    0.00s
    orphan numbers: none → answer unchanged
```

Quando o loop 2 dispara, o passo 9 vira:

```
[9] critic    claude-opus-5 (effort medium)    3.40s
    orphan numbers found: 4   → answer rewritten (1 of 1)
    before: "…e vinha de uma sequência de 4 vitórias seguidas."
    after the rewrite: clean
```

e, no teto:

```
[9] critic    claude-opus-5 (effort medium)    3.40s
    orphan numbers found: 4   → answer rewritten (1 of 1)
    before: "…e vinha de uma sequência de 4 vitórias seguidas."
    after the rewrite: still orphan: 4   → 1 sentence removed (deterministic)
    removed: "O time vinha de 4 vitórias seguidas [p05]."
```

`previousAnswer` é impresso **truncado** com o `truncate` que o arquivo já tem (120 caracteres), e
as frases removidas, inteiras — elas são curtas e são o ponto.

Regras de contagem no rodapé:

- `llmCalls += entry.grades.length` na entrada `grader` (são N chamadas de verdade, e esconder isso
  faria o traço mentir sobre o custo do loop);
- `llmCalls += 1` em `queryRewrite`, e em `critic` **só quando `model !== null`**;
- `embeddingCalls += 1` por entrada `search_vector_context`, como hoje — agora podendo ser 3;
- o `ms` de `search_vector_context` com `attempt > 1` **entra no `totalMs` normalmente**; só a
  entrada de `attempt === 1` continua no `Math.max` do fan-out, porque só ela roda em paralelo com
  os fatos.

#### `describeLowConfidence`

Ganha um terceiro motivo, sem alterar uma vírgula dos que existem. A função procura a última entrada
`critic` do traço; se ela tiver `redactedSentences.length > 0`, o motivo é:

```
1 claim removed from the answer: number(s) 4 had no API backing
```

Composição com os motivos atuais pelo mesmo `; ` que já junta o motivo de `team_form`: se houver
outro motivo, o do crítico vem por último; se não houver nenhum, ele aparece sozinho, sem o
`"low confidence"` genérico.

Ler o motivo do traço, em vez de guardar um campo novo em `Answer`, é deliberado: o traço já é o
registro do que aconteceu no grafo (`findPassageSource` já o lê para montar a lista de fontes), e um
`Answer.lowConfidenceReason` duplicaria uma informação que teria de ser mantida em sincronia com a
entrada do crítico.

### 12. A regra de ouro nesta tarefa

Esta é a tarefa em que a regra de ouro deixa de ser convenção e vira verificação em runtime — é
literalmente o que `docs/architecture.md` promete quando diz "é verificado em runtime pelo crítico".

1. **O crítico não consulta o índice vetorial.** O conjunto permitido sai só de `facts` e
   `recentForm`, os dois `source: "api"`. O `<context>` nem entra no prompt dele (seção 8).
2. **O grader não produz número nenhum.** Ele devolve um booleano e uma frase; nada do que ele
   escreve chega à resposta.
3. **A reescrita de query não vê fatos nem inventa números** — ela vê a pergunta, a entidade, a
   query anterior e os motivos de reprovação.
4. **A remoção determinística só tira texto.** Nenhum caminho desta tarefa acrescenta um número à
   resposta; no máximo remove um.
5. **O invariante fica executável em dois níveis**: a unidade (`findOrphanNumbers` sobre estados
   montados à mão) e a integração (`tests/integration/golden-rule.test.ts`, agora usando a função de
   produção em vez de uma cópia).

### 13. Tratamento de erro

| onde | situação | comportamento |
|---|---|---|
| `gradePassages` | uma chamada de grader rejeita | aquele trecho é **mantido**, com `error` no `PassageGrade`; não conta em `judged` nem no numerador |
| `gradePassages` | **todas** as chamadas rejeitam | `approvedRatio: null` → **não reescreve** (infra não é evidência sobre a query); o contexto segue inteiro |
| `gradePassages` | saída não valida contra `passageGradeSchema` | `callStructured` já lança → cai no caso acima, um trecho só |
| `runGradingLoop` | `context` veio vazio da busca | dispara reescrita (até o teto). Se a busca tinha falhado, as reescritas são inúteis e o traço mostra o erro da busca ao lado delas — **aceito**: distinguir "query ruim" de "Qdrant fora" exigiria propagar erro pelo fan-out, e o engano custa no máximo 2 chamadas, visíveis |
| `runGradingLoop` | `plan()` da reescrita rejeita | entrada `queryRewrite` com `error`, laço termina com o melhor contexto até ali |
| `runGradingLoop` | `runSearch` da retentativa rejeita | entrada `search_vector_context` com `error` e `results: []`, laço termina com o melhor contexto até ali |
| `runGradingLoop` | query reescrita idêntica à anterior | laço termina; a entrada `queryRewrite` registra as duas iguais |
| `runGradingLoop` | teto de 2 reescritas | laço termina com o melhor contexto; **responde, nunca falha** |
| `runGradingLoop` | nenhuma tentativa aprovou nada | `context: []` → `computeLowConfidence` já devolve `true` → resposta com aviso |
| `critique` | `facts === null` (API caiu) e a resposta tem dígito | todo número é órfão — **está certo**: sem fatos, nenhum número é verificável. O crítico gasta 1 chamada e, no teto, remove. A resposta já era de baixa confiança |
| `critique` | a chamada do crítico rejeita | cai na mesma remoção determinística da seção 9 (como se a refação tivesse rodado e ainda deixado o número órfão) — a resposta é redigida, não preservada intacta; `error` no relatório, `rewritten: false`, `lowConfidence: true`. O crítico nunca impede a resposta de sair (correção registrada na "Rodada de correção" ao fim deste arquivo) |
| `critique` | a refação ainda tem órfão | remoção determinística (seção 9) + `lowConfidence: true` |
| `redactOrphanSentences` | nenhuma frase sobrevive | `REDACTED_ANSWER_NOTICE` + `lowConfidence: true` |
| `redactOrphanSentences` | `orphans` vazio | devolve o texto **idêntico**, `removedSentences: []` (função pura, sem surpresa) |

### 14. Arquivos a criar ou alterar

**Criar**
```
src/agent/nodes/grade.ts              gradePassages, shouldRewriteQuery, summarizeRejections, as 2 constantes
src/agent/nodes/critic.ts             allowedNumbers, findOrphanNumbers, redactOrphanSentences, critique
tests/agent/grade.test.ts             os casos da seção 15
tests/agent/critic.test.ts            idem
tests/eval/loops-demo.ts              a demonstração executável do loop 2 (seção 16)
docs/learning/07-feedback-loops.md    o conceito desta tarefa
```

**Alterar**
```
src/config/models.ts                  grader + critic
src/agent/nodes/plan.ts               QueryRewriteContext, o segundo parâmetro opcional
src/agent/graph.ts                    runSearch extraído, runGradingLoop, critique em answer()
src/agent/trace.ts                    3 variantes novas, attempt/query/contextFromAttempt, impressão, describeLowConfidence
src/generation/writer.ts              a instrução de não derivar números, export de buildFactsSection
package.json                          script "demo:loops"
tests/graph.test.ts                   os novos campos obrigatórios + os casos do loop 1
tests/trace.test.ts                   novos campos nos objetos de amostra + impressão dos nós novos
tests/writer.test.ts                  a instrução nova no system
tests/integration/golden-rule.test.ts passa a usar findOrphanNumbers/allowedNumbers de produção
docs/architecture.md                  glossário, diagrama, status dos loops
docs/learning/README.md               linha nova no índice
```

**Nada a apagar** além da cópia local de `findOrphanNumbers` no teste de integração. Nenhuma
variável de ambiente nova, nenhuma mudança em ingestão, no payload do índice ou em `recall@k`.

#### Glossário de `docs/architecture.md`

Linhas novas (os nomes de nó `grader`/`critic` já estão fixados no parágrafo abaixo da tabela):

| Português | Inglês |
|---|---|
| reescrita da query (loop 1) | `queryRewrite` |
| refação da resposta (loop 2) | `answerRewrite` |
| número órfão (sem lastro na API) | `orphanNumber` |
| remoção de frase sem lastro | `redaction` |
| trecho aprovado / reprovado | `approved` / `rejected` |
| limiar de aprovação | `approvalThreshold` |
| tentativa (do loop) | `attempt` |

**Dois termos, não um.** "Reescrita" e "refação" são coisas diferentes — uma reescreve a *entrada*
(a query) e a outra a *saída* (a resposta) —, e o código precisa nomear as duas sem ambiguidade:
`queryRewrite` é nó do traço, `answerRewrite` é o que o crítico faz por dentro (`CriticReport.rewritten`).
Um `rewrite` sozinho obrigaria todo leitor a olhar o contexto para saber qual dos dois loops está
sendo discutido.

#### Diagrama de `docs/architecture.md`

O diagrama de hoje tem `CR -->|numero sem lastro na API| RED`, isto é: o crítico devolve ao redator.
O item 1 do discovery decidiu diferente — a checagem é determinística e **quem refaz a resposta é o
próprio crítico** (`opus-5 medium`), não o redator (`opus-5 high`). O diagrama passa a refletir o que
foi decidido:

```mermaid
  RED --> CHK{numeros sem lastro?<br/>checagem deterministica}
  CHK -->|sim, 1a vez| CR[refaz a resposta<br/>opus-5 medium] --> CHK
  CHK -->|sim, no teto| RDC[remove a frase<br/>deterministico] --> OUT
  CHK -->|nao| OUT[resposta com citacao<br/>+ traco do agente]
```

A prosa da seção "Os dois loops de feedback" ganha uma frase dizendo que o self-check começa
determinístico e só chama o modelo para consertar. Os tetos (2 e 1) **não mudam**.

`docs/learning/07-feedback-loops.md` cobre: o que é *Corrective RAG* e por que graduar documento é
diferente de buscar melhor; por que o grader julga um trecho por vez, em paralelo; por que
proporção e não contagem; por que o self-check **não** é um segundo LLM revisando o primeiro (e por
que "LLM as a judge" é a ferramenta errada para uma pergunta que tem resposta exata); o que um teto
compra num loop de correção, e por que no teto se responde em vez de falhar. Termina no bloco
**"Por que não X?"**: por que não deixar o crítico decidir se há erro; por que não graduar o pool
inteiro; por que não regenerar a resposta do zero com `write` em vez de refazê-la; por que não
pedir ao redator que se autoavalie na mesma chamada; por que não um framework de agente para os
ciclos (decisão 9); e por que não persistir feedback humano (discovery).

### 15. Casos de teste

Unidade (`npm test` = `tsc --noEmit && vitest run`, sem rede, sem Docker):

`tests/agent/critic.test.ts` (novo) — as funções puras, nenhum mock, e `critique` com `callText`
mockado:
- **`allowedNumbers` com o exemplo literal da seção 7** → o conjunto bate, item a item;
- `facts: null` e `recentForm: null` → conjunto **vazio**;
- dia/mês vêm de `isoDateParts`, não de `new Date().getDate()`: o mesmo estado produz o mesmo
  conjunto com `TZ=UTC` e com `TZ=America/Sao_Paulo` (a regressão que a revisão da tarefa 00
  consertou no código de produção e que esta tarefa não pode trazer de volta);
- jogo `scheduled`/`postponed` → placar **não** entra (não há placar); jogo `live` com `minute` →
  o minuto entra; `live` com `minute: null` → nada a acrescentar;
- **`recentForm` entra no conjunto** (discovery, item 2): o placar de um jogo do retrospecto e o de
  `otherCompetitionMatch` são permitidos, e `matches.length` e `record.{wins,draws,losses}` também.
  Este é o caso que impede toda resposta de `team_form` de ser marcada como alucinação;
- `findOrphanNumbers` descarta citações: uma resposta que só cita `[p07]` e `[p12]` e não traz
  número nenhum → `[]`, mesmo com `allowed` vazio;
- `findOrphanNumbers` não casa subnúmero: `allowed` com `2026` e resposta com `12` → `[12]` é
  órfão; `allowed` com `12` e resposta com `2026` → `[2026]` é órfão;
- ordem de aparição preservada e sem repetição (`"4 e 4 e 7"` com ambos fora → `[4, 7]`);
- `redactOrphanSentences` com o exemplo literal da seção 9 → texto e `removedSentences` batem;
- `redactOrphanSentences` com `orphans: []` → texto **idêntico** ao de entrada, `removedSentences: []`;
- **toda frase tem órfão** → `REDACTED_ANSWER_NOTICE`, e `removedSentences` tem todas;
- **órfão na mesma frase de uma citação válida** → a frase sai inteira, e `critique` devolve
  `citedPassages` **sem** aquele passageId;
- frase sem pontuação final (o texto acaba sem ponto) → ainda é segmentada e tratada;
- o `join` das fatias reproduz a entrada quando nada é removido (invariante da segmentação);
- `critique` com resposta limpa → `callText` **não é chamado**, estado devolvido por identidade,
  `report.rewritten === false`;
- `critique` com órfão, refação limpa → `callText` chamado **uma vez**, `answer.text` é o novo,
  `citedPassages` recalculado, `lowConfidence` **não** sobe sozinho;
- `critique` com órfão e refação ainda suja → `redactedSentences` não vazio,
  `answer.lowConfidence === true`, e `callText` chamado **uma vez só** (`MAX_ANSWER_REWRITES`);
- `critique` com `callText` rejeitando → resposta original preservada, `report.error` preenchido;
- o prompt do crítico **não contém** `<context source="vector_index">` (regra de ouro, seção 12);
- `MAX_ANSWER_REWRITES === 1` travado por teste.

`tests/agent/grade.test.ts` (novo) — `callStructured` mockado:
- N resultados → N chamadas, e o `GradeOutcome` tem `grades.length === N` na mesma ordem;
- `approved` traz só os `relevant: true`, preservando a ordem relativa;
- uma chamada rejeitando → aquele trecho **fica** em `approved`, com `error` no grade, e `judged`
  é `N - 1`; o `approvedRatio` é calculado só sobre os julgados;
- **todas** rejeitando → `judged === 0`, `approvedRatio === null`, `shouldRewriteQuery === false`;
- `shouldRewriteQuery` na fronteira: `2/5 = 0.4` → **`false`**; `1/5 = 0.2` → **`true`**;
  `1/2 = 0.5` → `false` (o caso que motiva proporção em vez de contagem);
- `grades: []` (nada recuperado) → `shouldRewriteQuery === true`;
- `GRADER_APPROVAL_THRESHOLD === 0.4` e `MAX_QUERY_REWRITES === 2` travados por teste;
- o system prompt contém a instrução "julgue relevância, não correção" (é ela que mantém a crônica
  armadilha no contexto e o teste da regra de ouro válido).

`tests/graph.test.ts` (alterado; `runGradingLoop` passa a ser importado, e
`../src/agent/nodes/grade.ts` e `../src/agent/nodes/plan.ts` são mockados):
- **caminho feliz**: grading aprova o bastante → **nenhuma** reescrita, `plan` não é chamado de
  novo, `runSearch` não roda de novo, `context` é o aprovado;
- **uma reescrita**: primeira rodada abaixo do limiar → `plan` é chamado com o segundo argumento
  contendo `previousQuery` e os `rejected`; `searchContext` é chamado uma segunda vez com a query
  nova; o `mode` e as `tools` do plano final são os originais **mesmo quando o planner devolve
  outros** (a garantia da seção 5);
- **teto**: grading abaixo do limiar nas três rodadas → exatamente **2** entradas `queryRewrite`, 3
  `grader`, 3 `search_vector_context`, e a resposta sai;
- **melhor tentativa vence**: tentativa 1 aprova 2, tentativa 2 aprova 0, tentativa 3 aprova 1 →
  `context` é o da tentativa 1 e a entrada `writer` traz `contextFromAttempt: 1`;
- **empate** entre tentativas → fica a mais antiga;
- query reescrita idêntica → o laço para, e não há segunda busca;
- `plan` rejeitando na reescrita → entrada com `error`, laço termina, resposta sai;
- `runSearch` rejeitando na retentativa → entrada com `error` e `results: []`, laço termina com o
  melhor contexto anterior;
- a retentativa **não** chama `getFacts`/`getTeamForm` de novo;
- as entradas `search_vector_context` trazem `attempt` e `query` em **todos** os casos, e a primeira
  tem `attempt === 1`;
- **(mantidos)** todos os casos atuais de `runFanOut` — resiliência do `Promise.allSettled`, filtro
  do `current_matchweek`, pool e decaimento do `team_form`, `recentForm` sempre presente no traço.

`tests/trace.test.ts` (alterado):
- os objetos de amostra ganham `attempt`, `query` e `contextFromAttempt` (typecheck);
- entrada `grader` → a saída traz a linha de ratio com limiar, um `✓`/`✗` por trecho com o motivo, e
  `attempt 1/3`;
- entrada `queryRewrite` → a saída traz `from:`/`to:`;
- entrada `critic` sem órfão → a saída diz `orphan numbers: none` e **não** conta uma chamada de LLM;
- entrada `critic` com refação → conta **uma** chamada de LLM e imprime a resposta anterior truncada;
- entrada `critic` com remoção → imprime as frases removidas, e `describeLowConfidence` menciona a
  afirmação removida e o número sem lastro;
- **as frases atuais de `describeLowConfidence` continuam idênticas** nos casos que já existiam;
- o rodapé conta `grades.length` chamadas por entrada `grader` (uma pergunta com 2 rodadas de 5
  trechos conta 10, não 2);
- `search_vector_context` com `attempt === 1` imprime **exatamente como hoje**; com `attempt > 1`
  vira passo numerado com o cabeçalho `(attempt N)` e a linha `query:`.

`tests/writer.test.ts` (alterado):
- `prompt.system` contém a instrução de não derivar números;
- todo o resto do arquivo continua passando sem alteração.

Integração (`npm run test:integration`):
- `tests/integration/golden-rule.test.ts` (alterado) — **passa a importar `allowedNumbers` e
  `findOrphanNumbers` de `src/agent/nodes/critic.ts`** e apaga a cópia local. O caso de teste não
  muda de asserção: o placar errado (`2 x 0`, em todas as grafias) não aparece, o certo (`1 x 3`)
  aparece, e não há número órfão. Agora ele exercita o código de produção, e não uma reimplementação
  que poderia divergir dele — que era precisamente o risco anotado na seção 11 da tarefa 05. A
  checagem de setup (`p07` tem de estar em `state.context`) continua sobre `state.context`, que
  depois desta tarefa é o contexto **aprovado**: se o grader reprovar a crônica armadilha, o teste
  falha com "invalid setup", que é o aviso correto — um grader que descarta o trecho de número
  errado torna o teste incapaz de provar o que ele existe para provar;
- `tests/integration/feedback-loops.test.ts` (novo, com o mesmo `skipIf` e o suporte de cassete dos
  outros): monta um `FinalState` à mão, com `facts` reais do fixture e uma resposta envenenada
  (`"o Palmeiras venceu por 2 x 0"` quando `facts` diz `1 x 3`), roda `critique` **de verdade** e
  verifica que a checagem determinística sinalizou, que a refação aconteceu e que o texto final não
  contém mais o número sem lastro. É a prova ponta a ponta do loop 2 sem depender de o redator
  alucinar por conta própria;
- `tests/integration/recall.test.ts` (inalterado) — `recall@5` continua **0.929**. Esta tarefa não
  toca em retrieval; qualquer mudança aqui é regressão.

### 16. O que roda no fim

Nenhuma CLI nova: `src/cli/ask.ts` já imprime o traço, e o traço é onde os dois loops ficam
visíveis.

```
$ npm run ask -- "como está a rodada do Brasileirão?"
```

O caminho feliz, e a primeira coisa a olhar: o traço mostra `grader` aprovando a maioria dos trechos
e `critic` dizendo `orphan numbers: none` com `0.00s` e **sem chamada de modelo**. É a prova de que
o desenho da seção 2 não cobra nada de quem já estava certo.

```
$ npm run ask -- "como está a fase do Palmeiras no futsal?"
```

A demonstração do **loop 1** disparando de verdade, sem cenário artificial: o índice só tem notícia
de futebol, então os trechos recuperados falam do time errado para a pergunta, o grader reprova, o
traço imprime `→ rewriting the query` com o motivo de cada reprovação, aparece um passo
`queryRewrite` com o `from:`/`to:` e um segundo `search_vector_context (attempt 2)`. No teto, a
resposta sai mesmo assim, com o aviso de baixa confiança dizendo que não há contexto relevante. (O
resultado depende do julgamento do grader; se numa rodada ele aprovar, a própria decisão fica
legível no traço — que é o ponto.)

```
$ npm run demo:loops
```

A demonstração do **loop 2** disparando, que `npm run ask` não consegue produzir sob demanda — o
redator, funcionando, não inventa número. O script (`tests/eval/loops-demo.ts`, no mesmo espírito do
`tests/eval/chunking-report.ts` que já existe e roda por `npm run eval:chunking`) monta um estado
com fatos reais e uma resposta envenenada à mão, e imprime, em sequência: o conjunto permitido, os
números órfãos encontrados pela checagem determinística, a resposta antes e depois da refação, e —
num segundo cenário, com uma resposta que o crítico não consegue salvar — a frase removida e o
aviso de baixa confiança. Custa uma chamada de `opus-5` medium por cenário e é a única forma honesta
de ver o loop 2 inteiro rodando.

### 17. Fora de escopo

- **Feedback humano persistido** (discovery, 2026-09-08): exige armazenar avaliações e um mecanismo
  para usar esse sinal; é projeto próprio.
- **O crítico julgar qualquer coisa além de número.** Estilo, completude, se a resposta responde a
  pergunta — nada disso. O escopo dele é o invariante da regra de ouro.
- **Número por extenso** na checagem determinística (seção 7). Limitação declarada, coberta por
  outro teste.
- **Re-buscar fatos na retentativa do loop 1.** A API já respondeu e a rodada não muda no meio da
  pergunta; a retentativa refaz só a busca vetorial.
- **Graduar o pool de candidatos inteiro** no modo `team_form` (seção 4).
- **Fazer `runFanOut` respeitar `plan.tools`** — dívida da tarefa 00, e continua sendo.
- **Distinguir "busca falhou" de "busca não achou nada"** no gatilho de reescrita (seção 13).
  Exigiria propagar erro pelo fan-out; o custo do engano é 2 chamadas, visíveis no traço.
- **Limitar a concorrência do grader.** N ≤ `k` (padrão 5) chamadas simultâneas não pedem fila.
- **Mudanças em retrieval**: filtro, decaimento, pool, `recall@k` e `questions.json` ficam como
  estão. O loop 1 muda *a query*, nunca a configuração de retrieval do modo.
- **Persistir o traço em disco** ou mudar a CLI. O traço continua sendo impresso e nada mais.
- **`peso_metadado`** da fórmula de scoring continua pendência aberta, como a tarefa 05 registrou.

## Implementação

Implementada em 2026-09-13, contra a spec fechada acima, na branch `feat/06-feedback-loops`, a
partir de `main` já com as tarefas 00-05 mergeadas. Uma primeira rodada (`implementador` anterior)
caiu por rate limit de sessão a meio caminho, com trabalho real já commitado/não commitado; esta
rodada revisou esse trabalho contra a spec inteira e completou o que faltava.

### O que a primeira rodada já tinha feito

- **`src/agent/nodes/grade.ts`** (novo): `gradePassages`, `shouldRewriteQuery`,
  `summarizeRejections`, `GRADER_APPROVAL_THRESHOLD = 0.4`, `MAX_QUERY_REWRITES = 2`. Uma chamada
  de `haiku-4-5` por trecho, `Promise.all` sobre `gradeOne` (que já captura toda falha
  internamente e nunca rejeita — comportamento idêntico ao `Promise.allSettled` que a spec
  descreve, só sem a etapa extra de desembrulhar `PromiseSettledResult`).
- **`src/agent/nodes/critic.ts`** (novo): `allowedNumbers`, `findOrphanNumbers`,
  `redactOrphanSentences`, `critique`, `MAX_ANSWER_REWRITES = 1`, `REDACTED_ANSWER_NOTICE`,
  `REDACTION_NOTICE`. A checagem determinística roda sempre primeiro; o `opus-5 medium` só é
  chamado quando ela já sinalizou algo.
- **`src/config/models.ts`**: `grader` e `critic` preenchidos, exatamente como a tabela da seção 3.
- **`src/agent/nodes/plan.ts`**: segundo parâmetro opcional `QueryRewriteContext` (`previousQuery`,
  `rejected`, `attempt`); a chamada original (`plan(state)`) não muda de forma.
- **`src/agent/graph.ts`**: `runSearch` extraído de `runContextCall` (a retentativa refaz só a
  busca, nunca os fatos); `runGradingLoopWithBestAttempt`/`runGradingLoop` (o loop 1 completo, com
  a regra "melhor tentativa vence, empate para a mais antiga"); `critique` plugado em `answer()`
  depois do `write`.
- **`src/generation/writer.ts`**: instrução nova proibindo o redator de derivar número
  (somas/médias/sequências); `buildFactsSection` passou a `export`.
- **`src/agent/trace.ts`**: variantes `grader`, `queryRewrite` e `critic` na união de `TraceEntry`;
  `search_vector_context` ganhou `attempt`/`query`; `writer` ganhou `contextFromAttempt`;
  impressão dos três nós novos; `describeCriticReason` composto em `describeLowConfidence`.
- **Testes**: `tests/agent/grade.test.ts`, `tests/agent/critic.test.ts` (novos, cobrindo os casos
  da seção 15 quase integralmente); `tests/graph.test.ts`, `tests/trace.test.ts`,
  `tests/writer.test.ts`, `tests/integration/golden-rule.test.ts` (alterados — este último já
  promovido para importar `allowedNumbers`/`findOrphanNumbers` de produção, em vez da cópia local).
- `npm test` já passava 303/303 (typecheck incluso) quando esta rodada começou.

Essa parte foi conferida linha a linha contra a spec (não só contra os testes) nesta rodada — sem
achado de divergência de comportamento. Uma única diferença mecânica, sem efeito observável: a spec
descreve `Promise.allSettled` para as N chamadas do grader (seção 4); a implementação usa
`Promise.all`, o que é equivalente porque `gradeOne` já captura toda exceção internamente e nunca
rejeita — mantido como está, por ser mais direto sem `PromiseSettledResult` para desembrulhar.

### O que esta rodada completou

- **`tests/eval/loops-demo.ts`** (novo) + `"demo:loops"` em `package.json`: a demonstração
  executável do loop 2 (seção 16), no mesmo espírito de `tests/eval/chunking-report.ts`. Constrói
  dois cenários com fatos reais (`getFacts({})`) e resposta envenenada à mão — um número derivado
  ("4 vitórias seguidas") ao lado de um placar real, e uma estatística inventada sem lastro nenhum —
  e roda `critique()` de verdade em cada um, imprimindo o conjunto permitido, os números órfãos, a
  resposta antes/depois e, quando acontece, a frase removida e o aviso de baixa confiança. Rodado
  manualmente (`npx tsx tests/eval/loops-demo.ts`) para confirmar que executa e imprime o esperado.
  **Nota sobre o segundo cenário**: forçar de forma 100% determinística que o `opus-5` real *não*
  consiga limpar a resposta (o teto do loop 2) não é algo que uma chamada de rede não controlada
  possa garantir — o modelo pode sempre optar por remover a alegação inteira em vez de deixar um
  número novo. O script documenta essa realidade no comentário (mesmo espírito da seção 16 sobre o
  `npm run ask` do loop 1, cujo resultado "depende do julgamento do grader") e imprime o resultado
  real de cada execução, o que quer que seja, em vez de fingir uma garantia que uma chamada de LLM
  de verdade não pode dar.
- **`docs/learning/07-feedback-loops.md`** (novo): Corrective RAG, por que o grader julga um trecho
  por vez em paralelo, por que proporção e não contagem, por que o self-check é verificação
  determinística e não "LLM as a judge", o que um teto compra num loop de correção, e o bloco
  "Por que não X?" (crítico decidir se há erro; graduar o pool inteiro; regenerar do zero;
  autoavaliação na mesma chamada; framework de agente; persistir feedback humano).
- **`docs/learning/README.md`**: linha nova apontando para o doc acima.
- **`docs/architecture.md`**: diagrama mermaid emendado (o crítico agora aparece como checagem
  determinística seguida do nó que refaz a resposta, com o nó de remoção determinística no teto,
  em vez do antigo `CR -->|numero sem lastro na API| RED`); glossário com as 7 linhas novas
  (`queryRewrite`, `answerRewrite`, `orphanNumber`, `redaction`, `approved`/`rejected`,
  `approvalThreshold`, `attempt`) e a nota "dois termos, não um"; a prosa de "Os dois loops de
  feedback" ganhou a frase sobre o self-check começar determinístico. A seção "## Status" não foi
  tocada — não é sobre os loops, e a spec não pediu.
- **`tests/integration/feedback-loops.test.ts`** (novo — não listado na tabela "Arquivos a criar" da
  seção 14, mas descrito por extenso na seção 15/"Integração" como arquivo novo; tratado como
  omissão da lista, não como pendência aberta, e implementado). Monta um `FinalState` à mão com os
  fatos reais do fixture (`tests/fixtures/fixture-source.ts`) e uma resposta envenenada
  ("o Palmeiras venceu por 2 x 0" quando o fixture diz 1 x 3), roda `critique()` de verdade e
  verifica que a checagem determinística sinalizou o `2`, que o modelo reescreveu, e que nenhum
  número órfão sobrevive na resposta final — independente de a limpeza ter vindo da reescrita do
  modelo ou da remoção determinística no teto. Gravado (`LLM_CASSETTE=record`) e reproduzido
  (`LLM_CASSETTE=replay`) com sucesso.

### Resultado dos testes

- `npm test` (typecheck + vitest, sem rede): **303/303**, verde, nesta rodada e ao final dela.
- `tests/integration/feedback-loops.test.ts` (novo): gravado e reproduzido com sucesso
  (`LLM_CASSETTE=record` e depois `=replay`), 1/1.
- `tests/integration/golden-rule.test.ts`: **não fechou verde nas 3 rodadas dentro desta sessão**,
  por um motivo de infraestrutura, não de comportamento — ver "Obstáculo encontrado" abaixo. Uma
  execução real isolada (1 rodada em vez de 3, alteração temporária revertida antes do commit)
  passou integralmente: placar certo presente, placar armadilha ausente, nenhum número órfão.
- `tests/integration/recall.test.ts`, `ingestion-incremental.test.ts`, `live-sources.test.ts`: não
  executados nesta rodada (nenhum toca em `answer()`/`critique()`/`grade.ts`, e esta tarefa não
  altera retrieval — rodá-los consumiria mais da mesma cota de Voyage já escassa sem checar nada
  que esta tarefa mudou).

### Obstáculo encontrado: cota do Voyage free tier

A conta usada neste projeto está no free tier do Voyage (3 requisições/min, sem cartão cadastrado).
Antes desta tarefa, `golden-rule.test.ts` fazia **1** chamada de embedding por rodada (3 no total,
espaçadas por um `sleep` de 20s entre rodadas quando `LLM_CASSETTE` não está definido). Com o loop 1,
uma única chamada a `answer()` pode fazer até **3** chamadas de embedding (busca inicial + até 2
reescritas) — o pior caso que a própria spec já previa e aceitava (seção 6, "Custo no pior caso").
Isso approxima ou ultrapassa o teto de 3 RPM **dentro de uma única rodada**, antes mesmo do `sleep`
entre rodadas ajudar. Em várias tentativas de gravar o cassete de `golden-rule.test.ts` (necessário
porque o prompt do redator mudou — nova instrução contra derivar número — e os nós `grader`/`critic`
são chamadas novas, nunca gravadas antes), a própria primeira busca de várias rodadas retornou 429
do Voyage, mesmo depois de esperas de mais de 2 minutos entre tentativas.

Isolando a variável (rodando com `run <= 1` em vez de `run <= 3`, alteração só para diagnóstico,
revertida antes de qualquer commit), uma execução real completa — sem cassete, API de verdade —
**passou integralmente**: o placar certo (1 x 3) apareceu, o placar armadilha (2 x 0, em toda
grafia) não apareceu, e `findOrphanNumbers` voltou vazio. Isso confirma que o mecanismo (grading +
crítico) preserva a regra de ouro; o que não foi possível nesta sessão foi consumir cota de Voyage
suficiente para fechar as 3 rodadas em sequência sem 429, nem regravar um cassete completo para
`golden-rule.test.ts` (o cassete ganhou entradas novas reais de `grader`/`critic`/`writer` ao longo
das tentativas, mas não uma passagem íntegra de ponta a ponta gravável em `LLM_CASSETTE=replay`).
**Isto fica registrado como pendência de infraestrutura para quem revisar**: rodar
`LLM_CASSETTE=record npm run test:integration -- tests/integration/golden-rule.test.ts` de novo
quando a cota do Voyage estiver livre (ou com um método de pagamento cadastrado, que já eleva o
limite), de preferência isolado (não em sequência com outras suites que também usam Voyage).

### Desvios da spec

Nenhum desvio de comportamento. As únicas duas notas registradas acima (`Promise.all` em vez de
`Promise.allSettled` no grader, comportamentalmente idêntico; e `tests/integration/feedback-loops.test.ts`
como arquivo novo não listado na tabela da seção 14, mas exigido pela prosa da seção 15) são
mecânicas ou de lista, não de comportamento ou contrato.

### Visto e não corrigido (fora de escopo desta tarefa)

- `README.md` não ganhou uma linha para `npm run demo:loops` (o padrão que `eval:chunking` segue
  ali). A seção 14 da spec ("Arquivos a criar ou alterar") não lista `README.md`, e o script já é
  descoberto por quem lê `package.json` — não tocado, para não ampliar o escopo de uma lista que a
  spec já fechou.
- `peso_metadado` continua pendência explícita (mencionada de novo na seção 17 da spec) — não é
  desta tarefa.

### Rodada de correção (revisão local, 2026-09-13)

O `revisor` apontou 4 achados. Todos corrigidos, na branch `feat/06-feedback-loops`, sem criar
branch nova:

1. **(Achado mais sério) Falha na chamada do crítico deixava o número órfão vazar** —
   `src/agent/nodes/critic.ts`, `critique()`: quando a checagem determinística sinaliza número
   órfão e a chamada a `callText` para reescrever a resposta falhava, o código devolvia o estado
   intacto — resposta original com o número órfão, sem elevar `lowConfidence`. Único ponto em que
   a regra de ouro podia ser violada de verdade em produção. **Corrigido** por decisão já tomada
   por quem orquestrou o ciclo: a falha da chamada agora converge no mesmo caminho de remoção
   determinística que já existia para "refação ainda tem número órfão" — `rewrittenText` recebe o
   próprio texto original quando `callText` rejeita, o `remaining` calculado sobre ele reproduz os
   mesmos órfãos, e a função cai direto em `redactOrphanSentences` com `lowConfidence: true`. O
   traço já distinguia os dois motivos por construção (`report.error` só existe no caso de falha
   de chamada; `report.remainingOrphanNumbers`/`redactedSentences` cobrem os dois), sem precisar
   de campo novo. `tests/agent/critic.test.ts`: o teste "callText rejeitando" foi reescrito para
   verificar que o número órfão não aparece mais na resposta final e que `lowConfidence` vira
   `true`, em vez de esperar a resposta original intacta.

2. **Teste do "invariante da segmentação" não testava nada** — `tests/agent/critic.test.ts`
   chamava `redactOrphanSentences(text, [])`, que já retorna cedo em `critic.ts` antes de a regex
   de fatiamento rodar (`orphans.length === 0`); era um teste duplicado do "orphans vazio devolve
   texto idêntico" sob outro nome. Confirmado rodando: com `orphans: [99]` (número que não bate
   com frase nenhuma), o comportamento anterior de fato anexava `REDACTION_NOTICE` mesmo sem
   remover nada. **Corrigido pela opção (a)**: `redactOrphanSentences` agora só anexa o aviso
   quando `removedSentences.length > 0` — não faz sentido avisar "uma afirmação foi removida"
   quando nada foi removido. Não muda nenhum caminho de produção: `critique()` só chama essa
   função com `remaining` vindo de `findOrphanNumbers` sobre o próprio texto, que por construção
   sempre bate com pelo menos uma frase. O teste foi reescrito para exercitar a segmentação de
   verdade com um orphan que não casa com frase nenhuma.

3. **Segmentação por frase cortava dentro de número com separador de milhar** —
   `redactOrphanSentences` tratava qualquer `.` como fim de frase, inclusive o `.` de "1.500",
   produzindo uma frase truncada e falsa ("O time marcou 1."). **Corrigido**: a regex de
   fatiamento agora usa um "átomo de frase" que trata `.` entre dois dígitos como parte do número
   (via lookbehind/lookahead), não como terminador — só `.`/`!`/`?`/`…` que não estejam cercados
   de dígitos terminam uma frase. Dois testes novos cobrem o caso: um número de milhar sozinho
   (nada é removido, o texto sai intacto) e um número de milhar numa frase mantida ao lado de uma
   frase removida por outro motivo (o número sobrevive inteiro).

4. **Doc de aprendizado prometia garantia absoluta que só ficou verdadeira depois do achado 1** —
   `docs/learning/07-feedback-loops.md`: o parágrafo sobre o teto do loop 2 agora menciona
   explicitamente que a falha da própria chamada ao crítico cai no mesmo caminho determinístico
   (antes da correção, esse era o buraco que tornava a frase "nunca uma resposta com número
   inventado" falsa nesse caminho específico). Acrescentada também uma frase curta sobre a
   limitação residual do achado 3 (a remoção por frase, mitigada para o caso de milhar mas não um
   tokenizador de frases completo).

**Não avaliei como necessário** um teste de integração novo para o achado 1 (a `feedback-loops.test.ts`
já existente exercita o loop 2 fim a fim com dados reais; o comportamento de falha de chamada é
melhor coberto por unidade, com o `callText` mockado para rejeitar, que é exatamente o que o teste
de unidade reescrito faz — reproduzir uma falha de rede real de propósito numa suíte de integração
seria frágil sem trazer cobertura adicional).

**Resultado dos testes desta rodada**: `npm test` — **305/305**, verde (303 antes da correção,
+3 testes novos, -1 teste que não testava nada e foi reescrito no lugar = líquido +2).

### Rodada de correção 2 (revisão local, 2026-09-13)

A segunda revisão achou 3 problemas remanescentes na correção acima:

1. **(Achado mais sério) O traço afirmava "answer unchanged" quando a resposta tinha sido de
   fato redigida** — `src/agent/trace.ts`, `formatTrace`: no ramo do `critic`, quando
   `entry.error !== undefined` (a chamada rejeitou), o código imprimia sempre
   `"answer unchanged (critic call failed)"` e retornava antes de checar
   `entry.redactedSentences` — mesmo nos casos em que a correção da rodada 1 fez a remoção
   determinística rodar de qualquer forma sobre a resposta. Resultado: a mesma saída dizia
   "answer unchanged" numa linha e, mais abaixo, no aviso de baixa confiança, "1 claim removed
   from the answer" — contradição que escondia justamente a frase removida (que a spec promete
   imprimir, seção 11). **Corrigido**: o status da linha e o corpo agora são decididos por dois
   booleanos (`isCleanRewrite` / `isRedacted`) independentes de `entry.error` — a linha `ERROR:`
   imprime sempre que `error` estiver presente, e a seção "after the rewrite: still orphan ...
   removed" imprime sempre que `redactedSentences.length > 0`, **nos dois casos ao mesmo tempo**
   quando os dois forem verdadeiros. "answer unchanged" só sai no único caso em que é verdade: a
   chamada falhou **e** a redação não encontrou frase nenhuma pra remover (`orphans` não bate com
   texto nenhum). Teste novo em `tests/trace.test.ts` ("critic entry with a call error that still
   got redacted") cobre exatamente essa combinação.

2. **Os 2 testes novos do achado 3 (rodada 1) não discriminavam a correção** — confirmado pelo
   `revisor` por mutação (reintroduzindo a regex antiga): a suíte inteira passava, 305/305, porque
   um teste usava um `orphans` que não batia com frase nenhuma (caí no retorno antecipado do
   achado 2, sem passar pela segmentação) e o outro usava um `orphans` cujo resultado, por
   coincidência, ficava igual nos dois lados depois do `join`. **Corrigido**: novo teste
   `redactOrphanSentences("O time marcou 1.500 gols na temporada. Foram 4 vitórias seguidas.",
   [500])` — 500 é um dos blocos de dígitos dentro de "1.500", então com a regex certa a frase
   inteira sai (sem cortar o número no meio) e com a regex antiga sairia mutilada
   ("O time marcou 1." separado de "500 gols..."). Validado por mutação eu mesmo: revertida a
   regex para a versão antiga localmente, o teste novo falhou exatamente como esperado
   (`removedSentences` veio `["500 gols na temporada. "]` em vez de
   `["O time marcou 1.500 gols na temporada. "]`); regex restaurada antes do commit, sem diff
   remanescente. Também renomeado/comentado o teste "invariante da segmentação" (que na verdade só
   trava o comportamento do achado 2 — nenhum aviso sem remoção — não a segmentação) para deixar
   isso explícito.

3. **Documentação (código e spec) ainda descrevia o comportamento antigo** — o JSDoc de
   `CriticReport.error` em `src/agent/nodes/critic.ts` (e a cópia dele na seção 8 desta spec) dizia
   "a resposta original é mantida como estava", falso desde a correção do achado 1 da rodada 1.
   **Corrigido**: texto agora descreve que a remoção determinística roda mesmo nesse caminho.
   Também corrigidos a seção 8 item 3 e a tabela da seção 13 desta spec, que ainda diziam "devolve
   o estado intacto"/"resposta original preservada" — ajustados para descrever o comportamento
   atual (cai na remoção determinística, `lowConfidence: true`), com nota apontando para esta
   seção em vez de duplicar a explicação.

**Resultado dos testes desta rodada**: `npm test` — **307/307**, verde (305 antes desta rodada,
+1 teste novo em `tests/trace.test.ts` para o achado 1, +1 teste novo em `tests/agent/critic.test.ts`
para o achado 2, mantendo o teste antigo do achado 3 da rodada 1 ao lado do novo).

## Revisão
_A preencher._

## Testes
_A preencher._
