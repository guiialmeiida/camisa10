# Tarefa 05: Consulta — forma do time

Corresponde ao nó "Forma do time" do diagrama em `docs/architecture.md`. Depende da tarefa 03.
Pode ser feita em paralelo com a tarefa 04.

## Status
- [x] Discovery  ← grilling de 2026-09-12, 10 decisões registradas abaixo
- [x] Refinamento técnico  ← spec fechada em 2026-09-12; emendada no mesmo dia pelo item 10 do
      discovery (verificação ao vivo do endpoint), sem pendência para o usuário
- [x] Implementação  ← 2026-09-12, `feat/05-team-form-query`
- [ ] Revisão
- [ ] Testes

## Discovery

As duas perguntas originais eram:

- Fórmula exata do decaimento temporal: janela de quantos jogos/dias, curva linear ou
  exponencial?
- Combinar com dados estruturados dos últimos N jogos (via API), além do texto recuperado no RAG?

Decidido no grilling de 2026-09-08:

- **"Qual time" já está resolvido**: a extração de entidade é um nó do agente
  (`claude-haiku-4-5`), construído na tarefa 00 e compartilhado pelos dois modos de consulta.
  Não é problema desta tarefa.
- A curva de decaimento é exatamente o tipo de mudança que só dá para avaliar com medição — usar
  o conjunto de avaliação da tarefa 00, estendido com perguntas de forma recente. **Revisto no
  grilling de 2026-09-12**, item 8 abaixo: o decaimento passa a ser testado por unidade, e o
  conjunto de avaliação não muda.

Fechado no grilling de 2026-09-12:

1. **`getTeamForm` — função nova**, chamando o endpoint por time da football-data.org:
   `GET /v4/teams/{footballDataId}/matches?status=FINISHED&limit=5`. Devolve os últimos jogos
   **encerrados** do time como fato exato: adversário, placar, data, casa/fora e resultado
   (vitória/empate/derrota). O `footballDataId` já existe em `teams.json` (curado na tarefa 01).
   **A forma real da resposta tem de ser verificada contra a API viva antes de fechar o schema**
   — é fato a confirmar, não a assumir (seção 2 do refinamento). O padrão de chamada é o que já
   existe: `fetchJson`/`HttpStatusError`/`HttpTimeoutError` de `src/sources/http.ts` e o
   tratamento de 429 (10 req/min) de `src/sources/football-data.ts`.
2. **N = 5** jogos no histórico.
3. **`getFacts()` continua rodando também no modo `team_form`**, não só `getTeamForm`. O jogo da
   rodada atual do time (via o filtro `team` que `getFacts` já suporta) soma-se aos 5 últimos
   encerrados. As duas chamadas de fato coexistem; como elas compõem no `state` e no prompt é
   decisão técnica, contanto que `Facts`/`FactsFilter` não mudem de um jeito que afete o modo
   `current_matchweek`.
4. **Decaimento temporal na busca vetorial**: exponencial, **meia-vida de 14 dias**, **sem corte
   rígido de janela** — todo trecho recuperado entra no ranking, só que com peso decrescente por
   idade. `weight = 0.5 ** (ageDays / halfLifeDays)`, com `ageDays` medido a partir de
   `payload.publishedAt` e um "agora" **injetável** (mesma razão de testabilidade do `now` da
   tarefa 04: sem relógio implícito). Esse peso multiplica o `score` de similaridade que o Qdrant
   devolve, e o resultado é reordenado por esse produto antes de cortar em `k`. Como o Qdrant não
   faz peso contínuo nativamente (o `filter` dele é booleano, não multiplicador — mesma
   constatação da tarefa 04), isso é **pós-processamento client-side**: buscar um pool de
   candidatos maior que `k`, reordenar por `similaridade × decaimento`, cortar em `k`. O tamanho
   do pool é decisão técnica, com justificativa na spec.
5. **`peso_metadado` da fórmula de `docs/architecture.md` fica em 1 nesta tarefa** — não
   implementado. Entra em `docs/architecture.md` como **pendência explícita**, não como feito.
6. **Filtro rígido obrigatório por `payload.teams`** na busca vetorial deste modo: o `filter` do
   Qdrant exige que `payload.teams` contenha `entity.team`. É sempre aplicado no modo `team_form`
   — diferente da tarefa 04, onde a cláusula de time era condicional.
7. **`entity.team === null` com `mode === "team_form"`** (extração de baixa confiança): cai no
   comportamento genérico — sem filtro de time, sem `getTeamForm` e **sem decaimento** (decaimento
   é configuração deste modo, e sem time não há "forma de quem"). A resposta sai com aviso de
   baixa confiança; se `computeLowConfidence` precisa ser estendida para cobrir isso é decisão
   técnica.
8. **`recall@k` e `tests/eval/questions.json` não mudam nesta tarefa.** O decaimento é testado por
   **unidade**, de forma determinística, sobre a função de peso isolada (dado `publishedAt` e `now`
   fixos, o peso bate com `0.5 ** (ageDays / 14)`) — não por métrica de ordem sobre o corpus real.
   Mesma lógica das tarefas 03 e 04, para não deixar mudança de retrieval mexer na linha de base
   de recall (**0.929**).
9. **O redator ganha instrução condicional**, só quando `mode === "team_form"`: abrir a resposta
   pelo retrospecto dos últimos 5 (que vem de `getTeamForm`) e só depois entrar na narrativa — o
   "porquê" da fase, que vem do RAG. Em texto corrido, sem seções fixas (mesmo espírito da
   instrução da tarefa 04, com conteúdo diferente).
10. **Os 5 são do Brasileirão; a última partida fora dele vem à parte.** Decidido em 2026-09-12,
    depois da spec já fechada — **refina o item 1**, que falava em "últimos jogos encerrados do
    time" sem prever filtro de competição; não o contradiz.

    O que forçou a pergunta: a seção 2 mandava verificar o endpoint contra a API viva antes de
    fechar o schema, e a verificação foi feita (`GET /v4/teams/1769/matches?status=FINISHED&limit=5`,
    token real). O achado: **dos 5 últimos jogos do Palmeiras, 2 eram da Copa Libertadores** e só 3
    do Campeonato Brasileiro. O endpoint por time devolve os últimos jogos do clube **em qualquer
    competição**, não só na que o projeto acompanha (`COMPETITION`, sempre o Brasileirão até hoje).
    Isso muda o que "forma recente" significa, então voltou ao usuário em vez de virar default do
    refinador.

    A decisão, literal:

    > "filtre por trazer as ultimas 5 do brasileirao + ultima partida que nao foi desse campeonato
    > tambem"

    Ou seja: o retrospecto — os 5 jogos que sustentam o V-E-D e a narrativa principal — é **só
    Brasileirão**; e, **além disso**, a resposta traz separadamente a **partida mais recente que
    não foi do Brasileirão**, se houver uma entre as buscadas. Dado extra, ao lado do retrospecto,
    nunca misturado dentro dele nem contado no V-E-D. Consequências técnicas (quanto pedir à API
    para sobrar 5 do Brasileirão depois de filtrar, e o que fazer com jogo de competição
    desconhecida) são decisão do refinador, resolvidas nas seções 5 e 12.

Lembrar: como na tarefa 04, este modo é uma **configuração de retrieval** sobre o índice
compartilhado — aqui, peso contínuo em vez de janela rígida. Não é um pipeline separado, e os
números continuam vindo só das chamadas à API.

## Refinamento técnico

Spec fechada em 2026-09-12 a partir do discovery acima. Nada aqui reabre decisão do discovery.
As três consequências que o discovery deixou como "decisão técnica" — como os dois fatos compõem
no estado (item 3), o tamanho do pool de candidatos (item 4) e o que fazer com
`computeLowConfidence` (item 7) — são resolvidas nas seções 8, 7 e 10.

**Emenda de 2026-09-12** (item 10 do discovery, posterior ao fechamento): a verificação ao vivo do
endpoint mostrou que ele mistura competições, o usuário decidiu separar "5 do Brasileirão" de "a
última partida fora dele", e as seções 2, 4, 5, 9, 10, 12, 13, 14 e 15 foram **emendadas** para
isso. O que não depende dessa mudança — a fórmula de decaimento (seção 7), o filtro rígido de time
(seção 6), `computeLowConfidence` (seção 10, item 4), o estado e o fan-out (seção 8) — continua
exatamente como estava.

### 0. O que esta tarefa é, em uma frase

O modo `team_form` deixa de ser um rótulo que ninguém lê: a pergunta sobre a fase de um time passa
a trazer, da API, o retrospecto dos últimos 5 jogos encerrados **do Brasileirão** — mais a última
partida fora dele, à parte (fato exato) —, e a busca vetorial passa a pesar cada trecho pela sua
idade — meia-vida de 14 dias — em vez de olhar só similaridade.

### 1. Sobre qual base esta spec foi escrita

Escrita contra o estado de `main`, **antes** da tarefa 04. Isso importa para cinco arquivos que a
tarefa 04 também toca (`src/agent/graph.ts`, `src/agent/trace.ts`, `src/generation/writer.ts`,
`src/retrieval/search-context.ts`, `src/vectorstore/qdrant.ts`) e para um arquivo que ela cria
(`src/retrieval/filters.ts`). Quando as duas branches mergearem, uma vai rebasear — é esperado.
Para tornar essa reconciliação barata, esta spec:

- **usa os mesmos nomes e a mesma semântica** onde as duas tarefas precisam da mesma coisa: o campo
  `filter: QdrantFilter | null` na entrada de trace de `search_vector_context` é idêntico ao da
  tarefa 04 (se a 04 mergear primeiro, essa parte daqui vira no-op);
- **não cria arquivo com o mesmo nome de um da 04**: o doc de aprendizado desta tarefa é
  `docs/learning/06-time-decay.md` (a 04 reservou o `05-`);
- **manda acrescentar, não recriar**: `src/retrieval/filters.ts` já pode existir quando esta tarefa
  for implementada. Se existir, acrescente `buildTeamFormFilter` a ele; se não, crie-o com essa
  função só;
- registra, para quem rebasear: a 04 transforma a ponta de fatos do fan-out numa promise de
  `Facts`, e esta tarefa transforma a mesma ponta numa promise de `FactsOutcome` (seção 8). O
  `runContextCall` da 04 passa a ler `outcome.facts` em vez de `settled.value`. É a única
  incompatibilidade semântica entre as duas; o resto é conflito textual.

### 2. Verificação do endpoint — feita, e o que ela devolveu

**Esta seção era uma lista de hipóteses a confirmar; agora é registro do que voltou.** A chamada
real foi executada em 2026-09-12, fora do fluxo normal (quem orquestra o ciclo rodou; o refinador
não tem shell): `GET /v4/teams/1769/matches?status=FINISHED&limit=5`, token real de `.env` no
header `X-Auth-Token`, `1769` = Palmeiras em `teams.json`.

O que se confirmou:

| # | O que se confirmou | Consequência na spec |
|---|---|---|
| 1 | **HTTP 200.** O path e os query params `status=FINISHED&limit=N` existem e funcionam como a documentação diz | `fetchTeamMatches` fica como a seção 4 descreve |
| 2 | O corpo é `{ filters, resultSet, matches: [...] }` — **sem `competition` no topo**, confirmando a hipótese que motivou o schema novo | schema novo (seção 4); `footballDataMatchesSchema`, que é de outro endpoint, continua intacto |
| 3 | Cada jogo em `matches[]` tem `id`, `utcDate`, `status`, `matchday` (**pode ser `null`**), `homeTeam.id`, `awayTeam.id`, `score.fullTime.{home,away}` | `matchday` continua não sendo lido; o resto mapeia como a seção 5 descreve |
| 4 | **Cada jogo traz seu próprio `competition`** — `{ id, name, code, type, emblem }`, ex.: `{ "id": 2013, "name": "Campeonato Brasileiro Série A", "code": "BSA", "type": "LEAGUE" }` e `{ "id": 2152, "name": "Copa Libertadores", "code": "CLI", "type": "CUP" }`. O `code` bate com o `COMPETITION_CODE = "BSA"` que `src/sources/football-data.ts` já usa | é o que torna o filtro do item 10 do discovery possível **sem chamada extra**: dá para particionar no cliente, sobre o mesmo corpo |
| 5 | Os 5 jogos vieram em ordem **crescente** de data (mais antigo primeiro) | não muda nada: a regra 6 da seção 5 já manda ordenar decrescente no cliente, justamente para não depender da ordem da API |
| 6 | **Os 5 últimos jogos do Palmeiras incluíam 2 da Copa Libertadores.** O endpoint por time devolve o clube em *qualquer* competição | é o achado que gerou o item 10 do discovery: `FORM_FETCH_LIMIT` sobe (seção 5) e `TeamForm` ganha a partição |

O ponto 6 é o importante, e é por isso que a verificação era obrigatória: com `limit=5`, **40% do
"retrospecto" não era do campeonato que o projeto acompanha**. Nenhuma leitura da documentação teria
mostrado isso.

**O implementador ainda grava o próprio corpo em `tests/fixtures/http/football-data-team-matches.json`.**
A verificação acima fechou o schema, mas o fixture é o que os testes da seção 14 consomem, e ele
precisa ser um corpo real, não transcrito à mão de uma tabela. Rode a chamada uma vez com
`limit=FORM_FETCH_LIMIT`, salve o corpo cru e **registre na seção "Implementação" o que voltou** —
em especial a proporção BSA/não-BSA daquela janela, que é o dado que o teste de partição precisa
exercitar. Cuidado com o limite de 10 req/min ao repetir a chamada.

Se a resposta real divergir do registrado aqui (a API mudou desde 2026-09-12), **ajuste o schema
novo à forma real e documente** — nunca relaxe `footballDataMatchesSchema`, que serve ao caminho da
regra de ouro em `getFacts`.

A verificação vira teste permanente em `tests/integration/live-sources.test.ts` (seção 14), no
mesmo espírito daquele arquivo: invariante estrutural, sem ground truth.

### 3. O modelo mental: por que peso contínuo, e não outra janela rígida

A tarefa 04 resolveu "similaridade não sabe que dia é hoje" cortando: fora da janela, o trecho nem
é considerado. Para "como o Palmeiras está de fase?" esse corte é a ferramenta errada, e por um
motivo concreto: **não existe fronteira honesta**. Uma crônica de 20 dias atrás sobre uma virada
importante explica a fase de hoje; uma nota de 3 dias atrás sobre a venda de ingressos não explica
nada. Um corte em "últimos N dias" trataria as duas como iguais dos dois lados da linha.

Decaimento contínuo troca a pergunta "entra ou não entra?" por "quanto isso ainda vale?". Com
meia-vida de 14 dias, um trecho de duas semanas atrás vale metade de um de hoje, um de um mês vale
um quarto, e nada nunca chega a zero — o trecho velho só precisa ser **muito** mais parecido para
ganhar. Isso é a fórmula do `docs/architecture.md` finalmente aparecendo no código:

```
score = similaridade_semantica x peso_metadado x decaimento_temporal
             (do Qdrant)          (fixo em 1)     (0.5 ** (ageDays / 14))
```

O preço é que **o Qdrant não sabe fazer isso**. O `filter` dele é booleano — decide o conjunto
candidato, não reordena por peso. Então o decaimento é pós-processamento no cliente, e
pós-processamento só consegue reordenar o que já veio: se pedirmos `k = 5` ao Qdrant, o decaimento
mexe na ordem de 5 itens e nada mais. Daí o **pool de candidatos** (seção 7): pedimos mais do que
vamos usar, justamente para que um trecho mais fresco e um pouco menos parecido tenha como subir.

Essa é a diferença conceitual entre as tarefas 04 e 05, e é o que o doc de aprendizado precisa
deixar claro: **pré-filtrar** muda quem pode ser visto; **pós-processar** muda a ordem de quem já
foi visto, e só enxerga o que o pool trouxe.

### 4. A chamada HTTP — `src/sources/football-data.ts` (alterado)

Duas adições, nenhuma alteração no que existe. Segue o padrão do arquivo: `request()` privado já
cuida de token, timeout, 429 e 403; o schema é `zod` porque é fronteira; a função `fetch*` devolve
`unknown` cru e quem mapeia é outra função, testável contra payload gravado, sem rede.

```ts
/** The competition code this project follows, as football-data.org spells it. Already a
 *  constant in this file — this task only adds the `export`. */
export const COMPETITION_CODE = "BSA";

/** Fields of a match in the *team* endpoint's response — a different shape from
 *  /competitions/BSA/matches: no top-level `competition`, `matchday` can be null, and each
 *  match carries its own `competition` (the team endpoint mixes competitions — see §2). */
const fdTeamMatchSchema = z.object({
  id: z.number().int(),
  utcDate: z.string(),
  status: z.string(),
  competition: z.object({ code: z.string(), name: z.string() }).nullish(),
  homeTeam: fdTeamSchema, // reused
  awayTeam: fdTeamSchema, // reused
  score: fdScoreSchema,   // reused — fullTime.home/away are nullable
});

export const footballDataTeamMatchesSchema = z.object({ matches: z.array(fdTeamMatchSchema) });

/** GET /v4/teams/{id}/matches?status=FINISHED&limit=N — the raw, unvalidated response body. */
export async function fetchTeamMatches(footballDataId: number, limit: number): Promise<unknown>;
```

- `z.object` (não `strictObject`) de propósito: a resposta real traz dezenas de campos que não
  interessam (`area`, `season`, `referees`, `odds`…) e nenhum deles pode derrubar a validação.
- **Não reusar `fdMatchSchema`**: ele exige `matchday: number` e o objeto `competition` no topo do
  corpo. Um schema novo de sete campos é mais barato que afrouxar o schema do outro endpoint — e
  afrouxar aquele schema enfraqueceria a validação de `getFacts`, que é o caminho da regra de ouro.
- `competition` continua **`nullish`** mesmo tendo aparecido em todos os jogos da chamada real
  (§2, ponto 4). Schema de fronteira descreve o que o cliente tolera receber, não o que ele espera;
  e a tolerância aqui é barata porque `mapTeamForm` sabe exatamente o que fazer com um jogo sem
  competição declarada (seção 5, regra 2). `name` entra junto com `code` porque é ele que aparece
  no prompt e no trace: `"CLI"` sozinho não diz nada a um leitor (nem ao redator).

E em `src/sources/teams.ts` (alterado), uma função só, no padrão das que já existem sobre
`loadIndex()`:

```ts
/** "palmeiras" -> 1769. Unknown team id -> null. */
export async function footballDataIdFor(teamId: string): Promise<number | null>;
```

(`listTeams()` não serve: ela devolve `Team`, que deliberadamente não carrega `footballDataId`.)

### 5. O fato novo — `src/sources/team-form.ts` (novo)

```ts
import type { Score } from "./types.ts";

/** How many finished matches make up a team's recent form (discovery, item 2). BSA only. */
export const RECENT_FORM_SIZE = 5;
/** How many the API is asked for, before the competition split. See "Por que 20" below. */
export const FORM_FETCH_LIMIT = 20;

export type MatchResult = "win" | "draw" | "loss";

export interface TeamFormMatch {
  id: string;             // the match's id at football-data.org, as a string
  date: string;           // ISO with a -03:00 offset (toSaoPauloIso)
  opponent: string;       // team id (slug), or a synthetic slug for an unknown club
  side: "home" | "away";  // which side the queried team played on
  score: Score;           // as played: { home, away } of the match, not of the team
  result: MatchResult;    // from the queried team's point of view
  /** Never null: a match whose competition the response doesn't declare is dropped (rule 2). */
  competition: { code: string; name: string };
}

export interface TeamForm {
  team: string;             // team id (slug)
  /** The record itself: most recent first, at most RECENT_FORM_SIZE, COMPETITION_CODE only. */
  matches: TeamFormMatch[];
  /** The single most recent match *outside* COMPETITION_CODE, or null if there was none
   *  among the FORM_FETCH_LIMIT fetched. Extra information, never part of `record`. */
  otherCompetitionMatch: TeamFormMatch | null;
  /** Counted over `matches` only — the league record, not "every game the club played". */
  record: { wins: number; draws: number; losses: number };
  source: "api";
}

/**
 * The team's recent form as exact facts. Talks only to football-data.org — never to the
 * vector index and never to the RSS feed, same as getFacts.
 * @throws when the team id isn't in teams.json, or when the API/validation fails.
 */
export async function getTeamForm(teamId: string): Promise<TeamForm>;

/** The pure half: validates a recorded body and maps it. Testable with no network. */
export function mapTeamForm(teamId: string, footballDataId: number, raw: unknown): TeamForm;
```

`getTeamForm` faz exatamente três coisas: `footballDataIdFor(teamId)` (se der `null`, **lança**
`unknown team id "x" — not in teams.json`), `fetchTeamMatches(id, FORM_FETCH_LIMIT)` e
`mapTeamForm`. Nenhum cache: a chamada roda uma vez por pergunta.

`mapTeamForm`, em ordem:

1. valida com `footballDataTeamMatchesSchema`; falha → lança com `z.prettifyError`, na mesma frase
   dos outros erros do arquivo;
2. descarta o jogo que não estiver `FINISHED`/`AWARDED` (`STATUS_MAP`), que tiver
   `score.fullTime.home/away === null`, **ou que não declarar `competition` (`code`/`name`)**, com
   `console.warn` — **nunca fabricar placar**, mesma regra de `mapMatches`, e nunca chutar
   competição (ver "O jogo sem competição declarada", abaixo);
3. decide o lado comparando `footballDataId` com `homeTeam.id`/`awayTeam.id`. Se o time pedido não
   aparecer em nenhum dos dois, o jogo é descartado com `console.warn` (resposta incoerente, não
   erro fatal);
4. resolve o adversário com `teamIdFromFootballData` (mesma degradação para slug sintético já usada
   em `mapMatches`), e a data com `toSaoPauloIso`;
5. `result`: `win` se os gols do lado do time forem maiores, `loss` se menores, `draw` se iguais;
6. **ordena todos os jogos sobreviventes por `date` decrescente**, misturando competições. Essa
   ordenação é obrigatória e não é estilo: é ela que torna a função correta independentemente de
   como a API ordena (a chamada real veio **crescente**, §2, ponto 5) e de como o `limit` corta;
7. **particiona essa lista ordenada em duas** (discovery, item 10):
   - `matches` = os primeiros `RECENT_FORM_SIZE` jogos com `competition.code === COMPETITION_CODE`;
   - `otherCompetitionMatch` = o **primeiro** jogo da mesma lista com
     `competition.code !== COMPETITION_CODE` — isto é, o mais recente fora do Brasileirão —, ou
     `null` se não houver nenhum.

   Um jogo nunca cai nos dois lados, e os jogos de outras competições que não são o mais recente
   são simplesmente descartados: o usuário pediu "a última partida", singular;
8. `record` é contado **sobre `matches`, depois do corte** — é o retrospecto dos jogos que aparecem
   na resposta, todos do Brasileirão. `otherCompetitionMatch` **não entra na conta**: somar um jogo
   de Libertadores a um V-E-D de campeonato é inventar um número que nenhuma tabela confirma, e o
   crítico da tarefa 06 estaria certo em reprovar.

Lista vazia não é erro:
`{ matches: [], otherCompetitionMatch: null, record: { wins: 0, draws: 0, losses: 0 } }` é resposta
válida (time sem jogo encerrado na temporada), e o redator diz isso. Também é válido — e esperado no
começo da temporada, ou numa semana de mata-mata — ter `matches: []` com `otherCompetitionMatch`
preenchido, ou 5 jogos do Brasileirão com `otherCompetitionMatch: null`. Os dois campos são
independentes.

#### Por que `FORM_FETCH_LIMIT = 20`

`RECENT_FORM_SIZE` é 5, mas pedir 5 à API deixou de bastar no instante em que o retrospecto passou a
ser só do Brasileirão: na chamada real, **2 dos 5 últimos jogos do Palmeiras eram de Libertadores**
(§2, ponto 6) — pedir 5 teria produzido um retrospecto de 3 jogos chamado "os últimos 5". O número
precisa cobrir a diluição do calendário, não o tamanho da saída:

- o pior caso realista de um clube brasileiro grande é a fase em que Brasileirão, Libertadores e
  Copa do Brasil correm juntos: aproximadamente **metade** dos jogos fora do campeonato. Com 20
  buscados, isso ainda deixa ~10 do Brasileirão — o dobro do necessário. Mesmo numa janela
  patológica de **70% fora**, sobram 6, e a folga só some se o clube jogar 16 de 20 fora do
  Brasileirão, o que não acontece num calendário real;
- 20 jogos são cerca de **10 semanas** para um clube que joga duas vezes por semana. Isso mantém a
  janela honesta com a palavra "recente": não há risco de o corte alcançar a temporada passada para
  preencher os 5, porque o corte para 5 é client-side e pega sempre os mais novos;
- 20 também é o que dá chance real de existir um `otherCompetitionMatch`. Com 5, um time que
  emendou cinco jogos de campeonato apareceria como se nunca tivesse disputado copa;
- o custo é **uma requisição só** — a mesma de antes, com corpo maior. Não muda o orçamento de 10
  req/min (seção 8), e o payload por jogo é pequeno (sem `text`, sem embedding). Pedir 50 ou 100
  seria trazer a temporada inteira para escolher 5: mais banda e mais jogos velhos para descartar,
  sem nenhuma resposta melhor.

Se a API impuser um teto de `limit` menor que 20, use o teto real e **registre na seção
"Implementação"** — é o mesmo espírito da seção 2: a API manda, a spec se ajusta.

#### O jogo sem competição declarada

Se `competition` vier ausente/`null` (ou sem `code`/`name`), o jogo é descartado de **ambos** os
lados da partição: não entra em `matches` nem concorre a `otherCompetitionMatch`. É a única saída
honesta — tratá-lo como Brasileirão contaminaria o `record`, que é fato exato e vai para a resposta;
tratá-lo como "outra competição" o rotularia no prompt como algo que ninguém confirmou. É a mesma
regra do placar ausente em `mapMatches`: **na dúvida, some com o jogo e deixe o `console.warn` de
rastro, nunca chute o dado que falta.** Na prática o custo é zero: a chamada real trouxe
`competition` em 100% dos jogos (§2, ponto 4), então esse caminho é uma rede, não um fluxo.

**Nota da rodada de correção (revisor, achado 1):** o bloco de código desta seção 4 tinha
`competition: z.object({ code: z.string(), name: z.string() }).nullish()` — que valida `competition`
ausente ou `null`, mas **não** um `competition` presente sem `code`/`name`. Nesse terceiro caso o
`safeParse` do corpo inteiro falhava, e `getTeamForm` perdia o retrospecto inteiro em vez de
descartar só aquele jogo, contradizendo a regra acima e a tabela da seção 12. O schema real em
`src/sources/football-data.ts` foi ajustado para
`competition: z.object({ code: z.string().optional(), name: z.string().optional() }).nullish()`, e o
guard em `mapTeamForm` passou a cobrir os três casos (ausente, `null`, ou presente sem `code`/`name`
utilizável) com o mesmo `console.warn` e descarte de um jogo só. A regra em prosa (a intenção) estava
certa desde o início; era a forma literal do bloco de código que a contradizia.

#### Exemplo literal

Entrada (recorte do corpo cru, com os jogos **fora de ordem** de propósito e com uma competição
misturada, como a resposta real de fato vem):

```json
{
  "matches": [
    {
      "id": 545231, "utcDate": "2026-09-06T00:30:00Z", "status": "FINISHED",
      "competition": { "id": 2013, "name": "Campeonato Brasileiro Série A", "code": "BSA" },
      "homeTeam": { "id": 1769, "name": "SE Palmeiras" },
      "awayTeam": { "id": 1765, "name": "Fluminense FC" },
      "score": { "fullTime": { "home": 1, "away": 3 } }
    },
    {
      "id": 545210, "utcDate": "2026-08-31T20:00:00Z", "status": "FINISHED",
      "competition": { "id": 2013, "name": "Campeonato Brasileiro Série A", "code": "BSA" },
      "homeTeam": { "id": 1777, "name": "EC Bahia" },
      "awayTeam": { "id": 1769, "name": "SE Palmeiras" },
      "score": { "fullTime": { "home": 0, "away": 2 } }
    },
    {
      "id": 551004, "utcDate": "2026-09-03T23:30:00Z", "status": "FINISHED",
      "competition": { "id": 2152, "name": "Copa Libertadores", "code": "CLI" },
      "homeTeam": { "id": 1769, "name": "SE Palmeiras" },
      "awayTeam": { "id": 6684, "name": "CA River Plate" },
      "score": { "fullTime": { "home": 2, "away": 0 } }
    }
  ]
}
```

Saída de `mapTeamForm("palmeiras", 1769, raw)`:

```json
{
  "team": "palmeiras",
  "matches": [
    {
      "id": "545231",
      "date": "2026-09-05T21:30:00-03:00",
      "opponent": "fluminense",
      "side": "home",
      "score": { "home": 1, "away": 3 },
      "result": "loss",
      "competition": { "code": "BSA", "name": "Campeonato Brasileiro Série A" }
    },
    {
      "id": "545210",
      "date": "2026-08-31T17:00:00-03:00",
      "opponent": "bahia",
      "side": "away",
      "score": { "home": 0, "away": 2 },
      "result": "win",
      "competition": { "code": "BSA", "name": "Campeonato Brasileiro Série A" }
    }
  ],
  "otherCompetitionMatch": {
    "id": "551004",
    "date": "2026-09-03T20:30:00-03:00",
    "opponent": "ca-river-plate",
    "side": "home",
    "score": { "home": 2, "away": 0 },
    "result": "win",
    "competition": { "code": "CLI", "name": "Copa Libertadores" }
  },
  "record": { "wins": 1, "draws": 0, "losses": 1 },
  "source": "api"
}
```

Três coisas para ler nesse exemplo:

- o segundo jogo é a prova de que `side` e `result` não são redundantes: o Palmeiras venceu **fora**,
  com o `score` guardando a forma literal do placar (`0 x 2`, mandante primeiro), como em `Match`;
- o jogo da Libertadores é de **03/09**, mais novo que o de 31/08, e mesmo assim não empurra nada
  dentro de `matches`: a ordenação é sobre a lista inteira, mas a partição é por competição. Ele é o
  mais recente **fora** do Brasileirão, e é só por isso que virou `otherCompetitionMatch`;
- `record` é `1V 0E 1D` — dois jogos, não três. A vitória sobre o River Plate está na resposta, mas
  **não na conta**. Esse é o invariante que o teste da seção 14 trava:
  `wins + draws + losses === matches.length`, sempre.

`ca-river-plate` é o slug sintético de `teamIdFromFootballData` para um clube que `teams.json` não
conhece — exatamente o que se espera de adversário de copa continental, e mais um motivo para o
`otherCompetitionMatch` não se misturar ao retrospecto.

#### Por que um módulo novo e não dentro de `facts.ts`

`getFacts` tem um contrato fechado desde a tarefa 01 (uma rodada de uma competição), e três testes
e um fixture dependem dele. Forma recente é outra pergunta, com outra forma de resposta, e o
discovery (item 3) pede explicitamente que as duas **coexistam** sem `Facts`/`FactsFilter` mudarem.

**`src/sources/index.ts` (o barrel) não é alterado**, e `graph.ts` importa direto de
`./team-form.ts`. Motivo prático: `tests/graph.test.ts`, `tests/integration/golden-rule.test.ts` e
`tests/integration/recall.test.ts` fazem `vi.mock("…/sources/index.ts")` com fábricas que listam os
exports um a um — acrescentar um export ao barrel quebraria os três de um jeito que não tem nada a
ver com esta tarefa. Um import direto os deixa intactos e ainda permite mockar forma e fatos
separadamente.

### 6. O filtro rígido de time — `src/retrieval/filters.ts`

Se o arquivo já existir (tarefa 04), **acrescente**; se não, crie com esta função só.

```ts
/**
 * The rigid filter for the team_form mode: the passage must mention the team.
 * Always applied in this mode (discovery, item 6) — the caller is responsible for not
 * calling it when there is no team (discovery, item 7).
 */
export function buildTeamFormFilter(team: string): QdrantFilter {
  // { must: [{ key: "teams", match: { value: team } }] }
}
```

Saída literal para `buildTeamFormFilter("palmeiras")`:

```json
{ "must": [{ "key": "teams", "match": { "value": "palmeiras" } }] }
```

`payload.teams` é um array de ids; o `match` do Qdrant casa quando **qualquer** elemento é igual ao
valor. Consequência aceita e declarada: um passage com `teams: []` nunca passa — é o preço de
perguntar sobre um time, e é o que o discovery pediu.

Diferente da tarefa 04, aqui não existe caminho que devolva `null`: neste modo, ou há time (e o
filtro é obrigatório), ou não se entra neste caminho.

### 7. O decaimento — `src/retrieval/time-decay.ts` (novo)

Módulo **puro**: sem rede, sem estado, sem relógio implícito.

```ts
import type { SearchResult } from "../vectorstore/types.ts";

/** A passage loses half its weight every 14 days (discovery, item 4). */
export const TIME_DECAY_HALF_LIFE_DAYS = 14;

/**
 * How many candidates to ask Qdrant for, per requested result. Decay can only reorder what
 * the pool already contains — see docs/learning/06-time-decay.md.
 */
export const CANDIDATE_POOL_FACTOR = 4;

export interface TimeDecayOptions {
  /** Injectable so tests don't depend on the wall clock. Defaults to new Date(). */
  now?: Date | undefined;
  /** Defaults to TIME_DECAY_HALF_LIFE_DAYS. */
  halfLifeDays?: number | undefined;
}

/** 0.5 ** (ageDays / halfLifeDays), in (0, 1]. */
export function timeDecayWeight(publishedAt: string, options?: TimeDecayOptions): number;

export interface DecayedResult extends SearchResult {
  /** The raw cosine similarity Qdrant returned, before decay. */
  similarity: number;
  /** The weight applied to it. `score` is the product of the two. */
  timeDecay: number;
}

/** Narrowing helper for the trace, which prints the two factors when they exist. */
export function isDecayedResult(result: SearchResult): result is DecayedResult;

/**
 * Reranks a candidate pool by `similarity x timeDecay` and cuts it to `k`.
 * Pure: returns a new array, never mutates `results`.
 */
export function rankByTimeDecay(
  results: SearchResult[],
  k: number,
  options?: TimeDecayOptions,
): DecayedResult[];
```

Regras de `timeDecayWeight`:

1. `ageDays = (now.getTime() - Date.parse(publishedAt)) / 86_400_000`;
2. **idade negativa é fixada em 0** (peso 1). Um `publishedAt` no futuro — relógio de feed
   adiantado, fuso mal escrito — daria peso **maior que 1** e bateria qualquer trecho legítimo.
   Ninguém ganha bônus por ser do futuro;
3. `publishedAt` impossível de parsear → peso **1**, com `console.warn`. Peso 1 e não 0: sumir
   silenciosamente com um trecho por causa de metadado ruim é pior que rankeá-lo como se fosse de
   hoje, e o `warn` deixa rastro;
4. `halfLifeDays <= 0` → lança. É erro de programação, não dado ruim.

Regras de `rankByTimeDecay`:

- calcula `similarity = result.score`, `timeDecay = timeDecayWeight(payload.publishedAt, options)` e
  **sobrescreve `score` com o produto**. Sobrescrever é deliberado: `score` significa "o número por
  que isto está nesta posição", e o trace imprime `score` em ordem. Os dois fatores continuam
  visíveis nos campos novos;
- ordena por `score` decrescente sobre uma **cópia** (`[...results].sort(...)`). O `sort` do JS é
  estável, então empate mantém a ordem que o Qdrant devolveu;
- corta em `k`. `k <= 0` → lança; pool menor que `k` → devolve o que tem.

#### Tamanho do pool: por que 4

`k * CANDIDATE_POOL_FACTOR`, com `CANDIDATE_POOL_FACTOR = 4` — no `k` padrão de 5, 20 candidatos.
O raciocínio, para o número não ser arbitrário:

- com meia-vida de 14 dias, um trecho **duas semanas** mais velho precisa de **o dobro** da
  similaridade para empatar. Como as similaridades reais deste corpus vivem numa faixa estreita
  (os traces da tarefa 03 mostram ~0.4–0.7), o decaimento tipicamente move um resultado algumas
  posições, não dezenas: um fator 4 cobre com folga a subida de um trecho fresco do fim do pool
  para o topo;
- o custo é real e cresce linear: cada candidato volta com o `text` inteiro do chunk no payload.
  20 payloads é barato; 200 seria desperdício num índice de ~100 pontos, onde um pool grande
  demais é simplesmente "traga a coleção inteira e ordene no cliente";
- não há teto absoluto sobre o pool. Se alguém rodar `--k 50`, pede-se 200 — o Qdrant devolve no
  máximo o que a coleção tem, e inventar um `MAX_POOL` seria mais um número para explicar.

#### Exemplo literal

Pool de 3 (`k = 2`, `now = 2026-09-12T12:00:00-03:00`, valores arredondados para leitura — o código
não arredonda e os testes usam `toBeCloseTo`):

| passageId | publishedAt | similarity | ageDays | timeDecay | score |
|---|---|---|---|---|---|
| p01 | 2026-09-10T08:00:00-03:00 | 0.620 | 2.167 | 0.8983 | **0.5569** |
| p02 | 2026-08-15T20:00:00-03:00 | 0.710 | 27.667 | 0.2542 | 0.1805 |
| p03 | 2026-09-12T09:00:00-03:00 | 0.480 | 0.125 | 0.9938 | **0.4770** |

Saída (`k = 2`), com o payload abreviado:

```json
[
  { "id": 11, "score": 0.5569, "similarity": 0.62, "timeDecay": 0.8983, "payload": { "passageId": "p01", "publishedAt": "2026-09-10T08:00:00-03:00" } },
  { "id": 13, "score": 0.477, "similarity": 0.48, "timeDecay": 0.9938, "payload": { "passageId": "p03", "publishedAt": "2026-09-12T09:00:00-03:00" } }
]
```

`p02` era o **mais parecido** do pool e ficou de fora: quase quatro meias-vidas de idade custaram
75% do peso dele. É exatamente o comportamento que esta tarefa existe para produzir, e é o caso de
teste central da seção 14.

### 8. O estado e o grafo — `src/agent/state.ts` e `src/agent/graph.ts` (alterados)

#### Onde a forma recente mora no estado (discovery, item 3)

```ts
export interface StateWithData extends StateWithPlan {
  facts: Facts | null;              // unchanged
  context: SearchResult[];          // unchanged
  /** null outside team_form, or when the call failed. Never merged into `facts`. */
  recentForm: TeamForm | null;
}
```

**Campo próprio no estado, não um campo dentro de `Facts`.** `Facts` é o que `getFacts()` devolve,
inteiro, de uma fonte só; se ele ganhasse `recentForm`, o objeto passaria a ser montado em dois
lugares (a fonte e o grafo) e todo consumidor de `Facts` — fixture, `fixture-schema.ts`, o teste da
regra de ouro, o crítico da tarefa 06 — teria de lidar com um campo que a fonte nunca preenche.
O estado do agente é justamente o lugar cujo trabalho é juntar resultados de nós diferentes.

#### A ponta de fatos do fan-out passa a fazer duas chamadas

```ts
interface FactsOutcome {
  facts: Facts | null;
  recentForm: TeamForm | null;
  factsError?: string;
  formError?: string;
}

/**
 * The facts branch of the fan-out: getFacts always, plus getTeamForm when the question is
 * about a team's form. The two run in parallel and settle independently — one failing
 * never costs the other, and neither ever rejects this branch.
 */
async function runFactsCall(state: StateWithPlan): Promise<FactsOutcome>;
```

- `getFacts({ team, competition, matchweek })` continua exatamente como hoje, **inclusive no modo
  `team_form`** (discovery, item 3): é dele que sai o jogo da rodada atual do time.
- `getTeamForm(team)` roda se e só se `plan.mode === "team_form"` **e** `entity.team` não for
  `null`/vazio depois de `trim()`. Fora disso, `recentForm: null` e nenhuma requisição a mais.
- `Promise.allSettled` por dentro, `try/catch` por fora de nada: uma rejeição vira `null` + a
  mensagem no campo de erro. A ponta de fatos **nunca rejeita**.
- Custo no limite de 10 req/min da football-data.org: uma pergunta em `team_form` gasta 3
  requisições (`/competitions/BSA` — em cache no processo —, `/competitions/BSA/matches`,
  `/teams/{id}/matches`). Folgado.

Em `runFanOut`, `factsCall` passa a ser `measure(() => runFactsCall(state))`; o `Promise.allSettled`
externo das duas pontas **não muda de forma**, e o `ms` dessa ponta passa a ser o galho inteiro (as
duas chamadas em paralelo). O ramo `rejected` externo continua existindo e agora significa "bug
nosso", não "API fora do ar": ele zera `facts` e `recentForm`.

#### A configuração de retrieval do modo

Dentro da ponta de busca, antes de chamar `searchContext`:

```ts
const team = state.entity.team?.trim();
if (state.plan.mode === "team_form" && team) {
  const filter = buildTeamFormFilter(team);
  const pool = await searchContext({ query: state.plan.searchQuery, k: state.k * CANDIDATE_POOL_FACTOR, filter });
  const results = rankByTimeDecay(pool, state.k, { now: new Date() });
  // ...
}
```

Caso contrário (inclusive `team_form` sem time — discovery, item 7), o caminho é **byte a byte o de
hoje**: `searchContext({ query, k })`, sem filtro, sem pool ampliado e sem decaimento.

**`searchContext` não muda** (nem assinatura nem comportamento): ela é embedding + busca, e
continua sendo. O pool e a reordenação ficam no grafo porque são *a configuração deste modo*, e é
o grafo que conhece o modo. Um wrapper `searchTeamFormContext` seria uma camada de indireção de
seis linhas escondendo justamente as três decisões que esta tarefa quer deixar visíveis.

O `now` é passado explicitamente (`new Date()`) em vez de deixar o default rodar: o parâmetro
existe para ser injetado, e um chamador que o omite ensina o contrário.

### 9. O trace — `src/agent/trace.ts` (alterado)

A entrada `fetch_facts_api` ganha dois campos; a de `search_vector_context` ganha `filter` (o mesmo
campo que a tarefa 04 introduz — ver seção 1):

```ts
| {
    node: "fetch_facts_api";
    model: null;
    /** The whole branch: getFacts and getTeamForm run in parallel inside it. */
    ms: number;
    facts: Facts | null;
    /** null outside team_form. */
    recentForm: TeamForm | null;
    error?: string;
    /** getTeamForm's own failure — independent from `error`, which is getFacts'. */
    formError?: string;
  }
```

`recentForm` é **obrigatório** (pode ser `null`), pelo mesmo motivo que a tarefa 04 deu para os
campos dela: campo que só existe quando tem valor é campo que ninguém sabe se foi medido.

Na impressão, dentro do bloco `├── fetch_facts_api`, depois das linhas de jogos e antes do `│`
final, e só quando `recentForm !== null` ou `formError !== undefined`:

```
    │   recent form (Palmeiras), BSA only: 1W 0D 1L in the last 2
    │   05/09  Palmeiras 1 x 3 Fluminense   home   loss
    │   31/08  Bahia 0 x 2 Palmeiras   away   win
    │   outside BSA: 03/09  Palmeiras 2 x 0 CA River Plate   home   win   Copa Libertadores
```

As linhas do retrospecto **não repetem a competição** — o cabeçalho já diz `BSA only`, e repetir
`BSA` cinco vezes só esconde a única linha em que a competição importa. A linha `outside BSA` mostra
`competition.name` (não o `code`): é o ponto em que a competição deixa de ser implícita, e
`Copa Libertadores` se lê, `CLI` não.

Quando `otherCompetitionMatch === null`, a linha vira `    │   outside BSA: none` — imprimir a
ausência, e não omitir a linha, é a mesma regra que fez `recentForm` ser campo obrigatório na
entrada de trace: quem lê precisa distinguir "não teve" de "ninguém olhou".

Nomes de time via `teamName(id, entry.facts?.teams ?? [])` — que já degrada para o slug quando não
acha. Data via `formatMatchDate`. Com `formError`, uma linha só:
`    │   RECENT FORM ERROR: <mensagem>`.

No bloco `└── search_vector_context`, além da linha `filter:` da tarefa 04, cada resultado que for
`isDecayedResult` ganha um sufixo com os dois fatores:

```
    └── search_vector_context    voyage-3.5    0.94s
        filter: {"must":[{"key":"teams","match":{"value":"palmeiras"}}]}
        k=5 over 97 points in collection camisa10   (pool of 20, time decay: half-life 14d)
        #1  0.557  p01  article  "o técnico admitiu que a equipe perdeu…"   (sim 0.620 × decay 0.898)
        #2  0.477  p03  chronicle  "a sequência de três jogos sem vencer…"   (sim 0.480 × decay 0.994)
```

O sufixo `(pool of N, time decay: half-life Xd)` na linha do `k=` aparece só quando há resultado
decaído — é o que torna a decisão desta tarefa auditável sem abrir o código. `N` é derivado dos
próprios dados (`k * CANDIDATE_POOL_FACTOR`), não um campo novo na entrada de trace.

`describeLowConfidence` ganha o motivo novo, **sem mexer nas três frases atuais**: calcula a frase
existente e, se `plan.mode === "team_form" && recentForm === null`, acrescenta
`; no recent form for the team` — ou, quando `entity.team === null`,
`; no team identified in the question, so no recent form and no team filter`. Se não houver nenhum
outro motivo, a frase nova entra sozinha (sem o `; ` inicial e sem o `"low confidence"` genérico).

### 10. O redator — `src/generation/writer.ts` (alterado)

A assinatura de `buildPrompt(state: StateWithData)` **não muda** — `recentForm` e `plan.mode` já
chegam pelo estado.

**1. A regra dos números passa a falar de "seções com `source="api"`".** Hoje a primeira linha do
system diz que `<facts>` traz "os únicos números que você pode escrever". Com `<recent_form>`
também vindo da API, essa frase precisaria mentir ou proibir o retrospecto. Fica:

```ts
'- <facts source="api">: números vindos de chamada direta à API (placar, rodada, data).',
...(state.plan.mode === "team_form"
  ? ['- <recent_form source="api">: o retrospecto recente do time no campeonato, mais a última partida dele fora desse campeonato, também de chamada direta à API (placar, data, vitória/empate/derrota).']
  : []),
'Só os números que aparecem nas seções com source="api" podem entrar na resposta.',
```

O resto do system (a proibição de repetir número do `context`, a citação `[passageId]`, o "se não
houver context relevante, diga isso") **não muda uma vírgula**.

**2. A instrução condicional do modo** (discovery, item 9), imediatamente antes de
`"Responda em português, de forma direta."`:

```ts
...(state.plan.mode === "team_form"
  ? [
      "A pergunta é sobre a fase recente de um time: comece pelo retrospecto de <recent_form> (quantas vitórias, empates e derrotas, e os jogos que sustentam isso) e só depois explique o que está por trás dessa fase, usando o <context>. Em texto corrido, sem seções, títulos nem listas.",
      "O retrospecto de <recent_form> é só do campeonato. Se houver uma partida de outra competição listada, ela é informação extra: mencione-a, se ajudar, deixando claro que é de outra competição, e nunca a some ao número de vitórias, empates ou derrotas.",
    ]
  : []),
```

**3. A seção nova no user message**, renderizada **se e só se** `plan.mode === "team_form"`, entre
`<facts>` e `<context>`, por uma `buildRecentFormSection(recentForm, teams)` exportada (testável
sem gastar API, como as outras):

```
<recent_form source="api">
Palmeiras — últimos 2 jogos encerrados no Campeonato Brasileiro Série A: 1V 0E 1D
05/09 — Palmeiras 1 x 3 Fluminense — casa — derrota
31/08 — Bahia 0 x 2 Palmeiras — fora — vitória
Fora do campeonato, partida mais recente: 03/09 — Palmeiras 2 x 0 CA River Plate — casa — vitória — Copa Libertadores
</recent_form>
```

O nome do campeonato no cabeçalho vem de `COMPETITION.name` (`src/sources/competition.ts`), não do
`competition.name` dos jogos: o cabeçalho descreve o **recorte** do retrospecto, que existe mesmo
quando `matches` está vazio. Cada linha de jogo do retrospecto **não** repete a competição, pelo
mesmo motivo do trace; a linha extra a diz, porque é a única em que ela muda.

- `recentForm === null` → `(não foi possível obter os últimos jogos do time — nenhum número de
  retrospecto disponível.)`, no mesmo formato do que `buildFactsSection` já faz quando `facts` é
  `null`.
- `recentForm.matches` vazio → `(nenhum jogo encerrado do campeonato encontrado para esse time.)`,
  seguido da linha `Fora do campeonato, ...` se `otherCompetitionMatch` existir. Os dois campos são
  independentes, e a seção renderiza cada um pelo que ele é.
- `otherCompetitionMatch === null` → a linha extra simplesmente **não aparece**. Aqui, diferente do
  trace, silêncio basta: o prompt é para o redator produzir texto, e uma linha dizendo "não houve
  jogo de outra competição" é um fato que ninguém perguntou e que ele poderia decidir narrar.
- Times por `teamName(id, facts?.teams ?? [])`; data por `formatMatchDate`; `V/E/D` e
  `casa/fora/vitória/empate/derrota` são **texto em português dentro do prompt**, como
  `"agendado"`/`"adiado"` já são em `formatMatchLine` — o identificador continua sendo `win`,
  `draw`, `loss`, `home`, `away`.
- Fora do modo `team_form`, a seção **não aparece**: o prompt do `current_matchweek` fica igual ao
  de hoje, tirando a reescrita da regra dos números do item 1.

**4. `computeLowConfidence`** (discovery, item 7) ganha a terceira condição:

```ts
export function computeLowConfidence(
  state: Pick<StateWithData, "context" | "facts" | "plan" | "recentForm">,
): boolean {
  // context vazio || facts null || (modo team_form && recentForm null)
}
```

Uma condição só cobre os dois casos do item 7 — o time não identificado e a chamada que falhou —
porque para o usuário eles são a mesma coisa: a pergunta era sobre a forma de um time e a forma não
veio. É o "no teto, o sistema responde, nunca falha" aplicado aqui: a resposta sai, com o aviso, e o
trace diz qual dos dois foi.

### 11. A regra de ouro nesta tarefa

1. **Todo número novo desta tarefa vem de chamada direta à API.** `getTeamForm` fala só com a
   football-data.org; o retrospecto (`record`) é contado sobre os jogos que ela devolveu, não
   inferido de texto nenhum.
2. **O decaimento não produz número para a resposta.** `similarity`, `timeDecay` e o `score` do
   produto existem para ordenar e para o trace — nenhum deles entra no prompt. O `<context>`
   continua renderizando só `passageId`, `type`, `source`, `title` e `text`.
3. **O sentido da dependência continua certo**: o fato (o time da pergunta, a data de publicação
   guardada na ingestão) restringe e pesa a narrativa; a narrativa nunca vira fato.
4. **`<recent_form>` é `source="api"`**, e é por isso que o redator pode escrever os números dele —
   **inclusive o placar de `otherCompetitionMatch`**, que veio do mesmo corpo de resposta, na mesma
   chamada, e não do índice. A separação entre o retrospecto e a partida de outra competição é sobre
   **o que o número significa** (V-E-D do campeonato não inclui copa), não sobre a procedência: as
   duas coisas são fato exato de API. Se algum dia esse retrospecto vier do índice, a regra de ouro
   morre — por isso `TeamForm` tem `source: "api"` literal, como `Facts`.
5. `tests/integration/golden-rule.test.ts` continua valendo sem alteração: a pergunta dele cai em
   `current_matchweek`, onde nada desta tarefa roda. Consequência a registrar para a tarefa 06: o
   `findOrphanNumbers` daquele arquivo só permite números de `facts` — se um dia entrar ali uma
   pergunta de `team_form`, ele precisa permitir também os de `recentForm`.

### 12. Tratamento de erro

| onde | situação | comportamento |
|---|---|---|
| `getTeamForm` | time não está em `teams.json` | **lança** — a ponta de fatos converte em `recentForm: null` + `formError` |
| `getTeamForm` | 429/403/timeout da football-data.org | **lança**, com a mensagem específica que `request()` já monta; mesma conversão acima |
| `mapTeamForm` | corpo não valida | **lança** com `z.prettifyError` |
| `mapTeamForm` | jogo sem placar, com status não-final, ou sem o time pedido | descarta **aquele jogo**, com `console.warn`. Nunca fabrica placar |
| `mapTeamForm` | jogo sem `competition` (ausente, `null`, ou sem `code`/`name`) | descarta **aquele jogo dos dois lados** da partição, com `console.warn`. Nunca chuta competição |
| `mapTeamForm` | nenhum jogo do campeonato entre os buscados | `matches: []`, `record` zerado. `otherCompetitionMatch` **não é afetado** — pode vir preenchido |
| `mapTeamForm` | nenhum jogo fora do campeonato entre os buscados | `otherCompetitionMatch: null`. Ausência de dado não é erro, e `matches`/`record` não são afetados |
| `mapTeamForm` | mais de um jogo fora do campeonato | fica só o **mais recente**; os demais são descartados em silêncio (é o que "a última partida" quer dizer) |
| `mapTeamForm` | nenhum jogo sobra | `matches: []`, `otherCompetitionMatch: null`, `record` zerado — ausência de dado não é erro |
| `runFactsCall` | `getFacts` rejeitou | `facts: null` + `error`; `recentForm` **preservado** |
| `runFactsCall` | `getTeamForm` rejeitou | `recentForm: null` + `formError`; `facts` **preservado** |
| `timeDecayWeight` | `publishedAt` não parseável | peso 1 + `console.warn` — nunca descarta o trecho |
| `timeDecayWeight` | `publishedAt` no futuro | idade fixada em 0 → peso 1 (nunca > 1) |
| `rankByTimeDecay` | `k <= 0`, ou `halfLifeDays <= 0` | **lança** — erro de programação |
| `searchContext` rejeitou | — | `context: []`, como hoje |
| busca filtrada devolve 0 | — | `context: []` → `computeLowConfidence` → resposta com aviso. **Sem retry sem filtro** (seção 16) |
| `recentForm` ausente no modo | — | resposta sai mesmo assim, com o aviso e a seção dizendo que o retrospecto não veio |

### 13. Arquivos a criar ou alterar

**Criar**
```
src/sources/team-form.ts                        getTeamForm, mapTeamForm, TeamForm, RECENT_FORM_SIZE
src/retrieval/time-decay.ts                     timeDecayWeight, rankByTimeDecay, as duas constantes
tests/sources/team-form.test.ts                 os casos da seção 14
tests/retrieval/time-decay.test.ts              idem
tests/fixtures/http/football-data-team-matches.json   corpo cru gravado na verificação da seção 2
docs/learning/06-time-decay.md                  o conceito desta tarefa
```

**Alterar**
```
src/sources/football-data.ts                fetchTeamMatches + footballDataTeamMatchesSchema + export de COMPETITION_CODE
src/sources/teams.ts                         footballDataIdFor
src/retrieval/filters.ts                     buildTeamFormFilter (criar o arquivo se a 04 não o criou)
src/agent/state.ts                           recentForm em StateWithData
src/agent/graph.ts                           runFactsCall + a configuração de retrieval do modo
src/agent/trace.ts                           recentForm/formError/filter, impressão, describeLowConfidence
src/generation/writer.ts                     seção <recent_form>, instrução do modo, computeLowConfidence
tests/graph.test.ts                          casos da seção 14
tests/trace.test.ts                          campos novos nos objetos de amostra + casos novos
tests/writer.test.ts                         seção, instrução e lowConfidence
tests/retrieval/filters.test.ts              buildTeamFormFilter (criar se a 04 não criou)
tests/integration/live-sources.test.ts       o invariante estrutural de getTeamForm (seção 2)
docs/architecture.md                         glossário + pendência na fórmula de scoring
docs/learning/README.md                      linha nova no índice
```

**Nada a apagar.** Nenhuma variável de ambiente nova, nenhum modelo novo em
`src/config/models.ts`, nenhuma mudança em ingestão ou no payload do índice.

Linhas a acrescentar no glossário de `docs/architecture.md`:

| Português | Inglês |
|---|---|
| forma recente | `recentForm` |
| meia-vida | `halfLife` |
| retrospecto (V-E-D) | `record` |
| pool de candidatos | `candidate pool` |
| mando de campo (casa/fora) | `side` |
| partida de outra competição | `otherCompetitionMatch` |
| código da competição na fonte | `competitionCode` |

(`otherCompetitionMatch` é o termo do item 10 do discovery — "a última partida que não foi desse
campeonato" —, e não `cupMatch`/`otherTournament`: o critério é "não é a competição que o projeto
acompanha", não "é copa". Uma partida de Série B ou de amistoso cairia no mesmo campo.)

Na seção "Fórmula de scoring", registrar o estado real de cada fator depois desta tarefa:
`similaridade_semantica` vem do Qdrant; `decaimento_temporal` está implementado **só no modo
`team_form`**, exponencial com meia-vida de 14 dias, como pós-processamento client-side;
**`peso_metadado` continua fixo em 1 — pendência, não implementado** (discovery, item 5), e nenhuma
tarefa o assumiu ainda.

`docs/learning/06-time-decay.md` cobre: por que recência é uma dimensão que o embedding não captura;
a diferença entre **pré-filtrar** (tarefa 04) e **pós-processar** (esta); por que exponencial com
meia-vida em vez de linear ou de uma janela; o que a meia-vida de 14 dias significa na prática ("um
trecho de duas semanas atrás precisa ser o dobro de parecido para empatar"); e por que
pós-processamento **exige** um pool maior que `k`. Termina no bloco **"Por que não X?"**: por que
não uma janela rígida de N dias; por que não decaimento linear; por que não pedir ao Qdrant que
faça isso (o `filter` é booleano, e o `formula`/prefetch da API nova seria acoplamento a um recurso
específico do servidor para uma conta que o cliente faz em três linhas); por que não aplicar
decaimento também no `current_matchweek` (lá a janela rígida já resolveu, e dois mecanismos sobre o
mesmo eixo se escondem um ao outro); por que não medir a curva pelo `recall@k` (discovery, item 8);
e por que não guardar o `score` decaído no índice (ele depende do "agora" da pergunta, não do
documento).

### 14. Casos de teste

Unidade (`npm test` = `tsc --noEmit && vitest run`, sem rede, sem Docker):

`tests/retrieval/time-decay.test.ts` (novo) — função pura, nenhum mock:
- **a fórmula é exatamente a do discovery**: `publishedAt` 14 dias antes de `now` → `0.5`;
  28 dias → `0.25`; 0 dia → `1`; 7 dias → `0.5 ** 0.5`. Tudo com `toBeCloseTo`;
- meia-vida customizada via `options.halfLifeDays` muda o resultado de acordo;
- `publishedAt` no futuro → `1` (nunca maior que 1);
- `publishedAt` impossível de parsear → `1`, e `console.warn` foi chamado;
- **o caso central**: o exemplo literal da seção 7 — o pool de 3, `k = 2`, `now` fixo → sai
  `[p01, p03]`, nessa ordem, e `p02` (o mais similar) fica de fora;
- `score` do resultado é o produto, e `similarity`/`timeDecay` são os dois fatores;
- o array de entrada **não é mutado** (nem ordem, nem `score` dos objetos originais);
- empate no produto preserva a ordem de entrada (estabilidade);
- pool menor que `k` → devolve tudo; `k <= 0` → lança;
- `TIME_DECAY_HALF_LIFE_DAYS === 14` e `CANDIDATE_POOL_FACTOR === 4` (os números do discovery
  travados por teste).

`tests/sources/team-form.test.ts` (novo) — `mapTeamForm` contra o fixture gravado:
- mapeia lado, adversário, placar literal e `result` para um jogo em casa e um fora — o caso do
  exemplo da seção 5 (vitória fora com placar `0 x 2`);
- **ordena do mais recente para o mais antigo** a partir de um fixture fora de ordem, e corta
  `matches` em `RECENT_FORM_SIZE` (o fixture precisa ter mais de 5 jogos do campeonato);
- **o caso central da emenda — a mistura de competições**, exatamente a que a chamada ao vivo
  mostrou (§2, ponto 6): dado um corpo com jogos de `BSA` e de outra competição intercalados,
  `matches` traz **só** os de `BSA`, `otherCompetitionMatch` traz **só** o mais recente dos outros,
  e nenhum jogo aparece nos dois. Este teste roda **contra o fixture real gravado**, não contra um
  corpo montado à mão — é ele que trava o comportamento que o usuário pediu;
- **o invariante do `record`**: `wins + draws + losses === matches.length`, e um
  `otherCompetitionMatch` com `result: "win"` **não** aumenta `record.wins`. É a regra de ouro
  aplicada a esta tarefa: o número da resposta tem de bater com a lista que a sustenta;
- um jogo de outra competição **mais recente que todos os do campeonato** não entra em `matches`
  nem empurra o corte de 5 (prova de que a partição não é "os 5 primeiros da lista ordenada");
- **dois ou mais** jogos fora do campeonato → `otherCompetitionMatch` é o de `date` maior, e só um;
- **nenhum** jogo fora do campeonato entre os buscados → `otherCompetitionMatch === null`, com
  `matches` e `record` intactos;
- **nenhum** jogo do campeonato, mas um de copa → `matches: []`, `record` zerado e
  `otherCompetitionMatch` **preenchido** (os campos são independentes);
- descarta jogo sem placar (`fullTime: { home: null, away: null }`) sem derrubar os outros, com
  `warn`;
- descarta jogo cujo status não é final, e jogo em que o time pedido não aparece nos dois lados;
- **`competition` ausente/`null` → o jogo é descartado dos dois lados**, com `warn`: não entra em
  `matches` e não vira `otherCompetitionMatch`, nem quando é o mais recente da lista;
- adversário fora de `teams.json` → slug sintético, jogo preservado (o caso `ca-river-plate` do
  exemplo da seção 5);
- `matches: []` → `record` zerado, sem lançar;
- `FORM_FETCH_LIMIT === 20` e `RECENT_FORM_SIZE === 5` travados por teste, como as constantes de
  decaimento;
- `getTeamForm("palmeiras")` chama `fetchTeamMatches` com `FORM_FETCH_LIMIT`, não com
  `RECENT_FORM_SIZE` — confundir os dois é justamente o bug que a emenda existe para evitar;
- `getTeamForm("time-que-nao-existe")` **lança** (`footballDataIdFor` devolve `null`).

`tests/retrieval/filters.test.ts` — `buildTeamFormFilter("palmeiras")` é igual, literalmente, ao
JSON da seção 6.

`tests/graph.test.ts` (alterado; `getFacts`, `searchContext` e `countPoints` já são mockados, e
`../src/sources/team-form.ts` passa a ser mockado também):
- **`team_form` com time**: `getFacts` **e** `getTeamForm` são chamados; `searchContext` recebe
  `k === state.k * 4` e o filtro de `teams`; `result.context.length <= state.k` e vem ordenado por
  `score` decrescente; `result.recentForm` é o objeto que `getTeamForm` devolveu;
- **`team_form` sem time** (`entity.team: null`): `getTeamForm` **não** é chamado, `searchContext`
  recebe `k === state.k` e **nenhum** `filter`, e `result.recentForm === null`;
- **`current_matchweek`**: `getTeamForm` **não** é chamado e `recentForm` fica `null`;
- **resiliência, nos dois sentidos**: `getTeamForm` rejeitando → `facts` preservado,
  `recentForm: null`, `formError` no trace, a resposta continua saindo; `getFacts` rejeitando →
  `recentForm` preservado, `facts: null`, `error` no trace. Um não derruba o outro;
- a entrada de trace `fetch_facts_api` traz `recentForm` em todos os casos;
- **(mantidos)** os casos atuais de `Promise.allSettled` e o do `QDRANT_COLLECTION` real.

`tests/trace.test.ts` (alterado):
- os objetos de amostra ganham os campos novos (typecheck);
- `recentForm` presente → a saída tem a linha `recent form (...), BSA only` e uma linha por jogo;
- `otherCompetitionMatch` preenchido → a saída tem a linha `outside BSA:` com o nome da competição
  (`Copa Libertadores`, não `CLI`); `otherCompetitionMatch: null` → a saída tem `outside BSA: none`;
- `formError` presente → a saída tem `RECENT FORM ERROR:` e **não** tem a linha de retrospecto;
- resultado com `similarity`/`timeDecay` → a saída traz `(sim 0.620 × decay 0.898)` e o sufixo
  `(pool of 20, time decay: half-life 14d)`; resultado sem eles → a saída fica como hoje;
- `describeLowConfidence`: com `mode: "team_form"` e `recentForm: null`, a frase menciona o
  retrospecto; com `entity.team: null`, menciona que nenhum time foi identificado; **as três frases
  atuais continuam idênticas** nos casos que já existiam.

`tests/writer.test.ts` (alterado):
- `mode: "team_form"` → `prompt.system` contém a instrução de abrir pelo retrospecto **e** a de não
  somar a partida de outra competição ao V-E-D, e `prompt.user` contém `<recent_form source="api">`
  com a linha `1V 0E 1D` e uma linha por jogo;
- `otherCompetitionMatch` preenchido → `prompt.user` contém a linha `Fora do campeonato, partida
  mais recente:` com o nome da competição; `otherCompetitionMatch: null` → essa linha **não**
  aparece, e a seção continua aparecendo;
- `matches: []` com `otherCompetitionMatch` preenchido → a seção traz a frase de "nenhum jogo
  encerrado do campeonato" **e** a linha da outra competição;
- `mode: "current_matchweek"` → `prompt.user` **não** contém `<recent_form>`, e `prompt.system` não
  contém a instrução deste modo;
- `recentForm: null` no modo `team_form` → a seção aparece com a frase de indisponibilidade (e não
  some);
- `computeLowConfidence`: `true` com `mode: "team_form"` e `recentForm: null` mesmo com contexto e
  fatos presentes; `false` com `recentForm` preenchido e o resto ok; **inalterada** para
  `current_matchweek` com `recentForm: null`;
- `buildFactsSection` e `formatMatchLine` **não mudaram** (teste de regressão já existente).

Integração (`npm run test:integration`):
- `tests/integration/live-sources.test.ts` (alterado), caso novo, 30s de timeout, com o mesmo
  `skipIf` do arquivo: `getTeamForm("palmeiras")` devolve **no máximo 5** jogos em `matches`, todos
  com `date` terminando em `-03:00`, em **ordem decrescente de data**, **todos com
  `competition.code === "BSA"`**, `record` somando exatamente `matches.length`, e `result` coerente
  com `score`/`side` em cada jogo. E, quando `otherCompetitionMatch` não for `null`, ele tem
  `competition.code !== "BSA"` e `id` diferente do de todo jogo de `matches`. É a verificação da
  seção 2 — inclusive o achado que gerou a emenda — virando rede permanente;
- `tests/integration/recall.test.ts` **inalterado** — `recall@5` continua **0.929** (discovery,
  item 8). Se esse número se mexer nesta tarefa, é regressão, não ajuste;
- `tests/integration/golden-rule.test.ts` **inalterado** (seção 11).

### 15. O que roda no fim

Sem CLI nova: `src/cli/ask.ts` já imprime o trace.

```
$ npm run index
$ npm run ask -- "como está a fase do Palmeiras?"
```

No trace dessa pergunta, tudo o que esta tarefa entrega fica visível em uma tela: o `planner` diz
`mode: team_form`; o bloco `fetch_facts_api` mostra o jogo da rodada atual, o retrospecto
`recent form (Palmeiras), BSA only: 2W 1D 2L in the last 5` com os cinco jogos do Brasileirão e,
logo abaixo, a linha `outside BSA: 03/09  Palmeiras 2 x 0 CA River Plate   home   win   Copa
Libertadores` (ou `outside BSA: none`); o bloco `search_vector_context` mostra o `filter` de
`teams`, o `pool of 20, time decay: half-life 14d` e, em cada resultado, o `(sim … × decay …)` que
explica a ordem. A resposta abre pelo retrospecto do campeonato e depois narra o porquê, citando as
fontes.

Esse trace é, também, a prova visível da emenda: sem ela, os cinco jogos impressos ali seriam
"os cinco últimos do clube", e dois deles não seriam do campeonato sobre o qual a pergunta foi
feita.

Para o contraste, `npm run ask -- "como está a rodada do Brasileirão?"` cai em `current_matchweek`
e não imprime nada disso — nem retrospecto, nem decaimento.

E o caso degenerado, que também tem de rodar:
`npm run ask -- "como está a fase deles?"` (sem time identificável) responde assim mesmo, com
`⚠ low confidence` explicando que nenhum time foi identificado.

### 16. Fora de escopo

- **`peso_metadado`** da fórmula de scoring (discovery, item 5). Fica em 1 e continua registrado
  como pendência em `docs/architecture.md`.
- **Decaimento no modo `current_matchweek`.** Lá a janela rígida da tarefa 04 já resolve a
  recência; empilhar os dois mecanismos sobre o mesmo eixo só tornaria cada um menos legível.
- **Ajustar a meia-vida por medição.** O discovery (item 8) trocou isso por teste de unidade
  determinístico; mudar `recall@k`/`questions.json` é regressão nesta tarefa.
- **Tabela de classificação, pontos ganhos, aproveitamento percentual.** `getTeamForm` devolve os
  jogos e o retrospecto V-E-D, nada além. Percentual de aproveitamento é conta, e conta nova pede
  fonte nova.
- **Forma do adversário, confronto direto, série de invencibilidade.** Um time por pergunta.
- **Retrospecto de outras competições.** `otherCompetitionMatch` é **uma** partida, não um segundo
  V-E-D: nada de "3V 1E 1D na Libertadores", nada de lista de copas, nada de campo por competição.
  O discovery (item 10) pediu "a última partida que não foi desse campeonato", singular, e é isso
  que a spec entrega. Generalizar para um retrospecto por competição é decisão do usuário, não do
  implementador.
- **Tornar a competição do retrospecto configurável.** O recorte é `COMPETITION_CODE`, a única
  competição que o projeto acompanha (`src/sources/competition.ts`). Enquanto houver uma só, um
  parâmetro `competitionCode` em `getTeamForm` seria indireção sem chamador.
- **Cache de `getTeamForm`.** Um processo responde uma pergunta e morre, como `fetchCompetition`
  já assume.
- **Fazer `runFanOut` respeitar `plan.tools`.** Continua chamando as duas ferramentas sempre —
  dívida da tarefa 00.
- **Fallback para busca sem filtro quando o filtro de time devolve zero trecho.** O caminho de
  baixa confiança já existe; retry com reescrita de query é a tarefa 06.
- **O crítico conferir os números de `recentForm`.** Tarefa 06; esta spec só deixa o dado no estado
  e no trace, no formato que ele vai precisar.
- **Ingestão, payload e reembedding.** Nenhum campo novo no índice; esta tarefa é só do lado da
  pergunta.

## Implementação

Implementado em 2026-09-12, contra a spec fechada acima (incluindo a emenda do item 10), na branch
`feat/05-team-form-query`, a partir de `main` já com a tarefa 04 mergeada.

### O que foi feito

- **`src/sources/football-data.ts`**: `COMPETITION_CODE` e `STATUS_MAP` passaram a `export`;
  `fdTeamMatchSchema`/`footballDataTeamMatchesSchema` (schema novo, tolerante, `competition`
  nullish) e `fetchTeamMatches(footballDataId, limit)` (`GET /v4/teams/{id}/matches?status=FINISHED&limit=N`).
- **`src/sources/teams.ts`**: `footballDataIdFor(teamId)` — direção inversa de
  `teamIdFromFootballData`.
- **`src/sources/team-form.ts`** (novo): `getTeamForm`/`mapTeamForm`, `TeamForm`/`TeamFormMatch`,
  `RECENT_FORM_SIZE = 5`, `FORM_FETCH_LIMIT = 20`. Faz a partição BSA/`otherCompetitionMatch`
  exatamente como a seção 5 descreve.
- **`src/retrieval/filters.ts`**: `buildTeamFormFilter(team)` acrescentada ao arquivo que a tarefa
  04 já criou.
- **`src/retrieval/time-decay.ts`** (novo): `timeDecayWeight`, `rankByTimeDecay`, `isDecayedResult`,
  `TIME_DECAY_HALF_LIFE_DAYS = 14`, `CANDIDATE_POOL_FACTOR = 4`.
- **`src/agent/state.ts`**: `StateWithData.recentForm: TeamForm | null`.
- **`src/agent/graph.ts`**: `runFactsCall`/`FactsOutcome` (getFacts + getTeamForm em paralelo,
  `Promise.allSettled` interno, nunca rejeita); `runContextCall` ganhou o ramo `team_form` (filtro
  obrigatório + pool `k*4` + `rankByTimeDecay`); `runFanOut` concilia a nova forma da ponta de
  fatos com o fan-out externo que a tarefa 04 introduziu — exatamente a reconciliação que a seção 1
  da spec previu (`outcome.facts` no lugar de `settled.value` dentro de `runContextCall`).
- **`src/agent/trace.ts`**: `fetch_facts_api` ganhou `recentForm`/`formError` (impressão do
  retrospecto, da linha `outside BSA:` e de `RECENT FORM ERROR:`); `search_vector_context` ganhou o
  sufixo `(pool of N, time decay: half-life 14d)` e `(sim × decay)` por resultado, via
  `isDecayedResult`; `describeLowConfidence` ganhou o motivo de `team_form` sem quebrar as três
  frases existentes.
- **`src/generation/writer.ts`**: seção `<recent_form source="api">` (`buildRecentFormSection`,
  exportada), instrução condicional do modo (abrir pelo retrospecto, nunca somar
  `otherCompetitionMatch` ao V-E-D), regra dos números reescrita para falar de "seções com
  `source="api"`", e `computeLowConfidence` com a terceira condição.
- **Testes**: `tests/retrieval/time-decay.test.ts`, `tests/sources/team-form.test.ts` (novos);
  `tests/retrieval/filters.test.ts`, `tests/graph.test.ts`, `tests/trace.test.ts`,
  `tests/writer.test.ts`, `tests/integration/live-sources.test.ts` (alterados).
- **Docs**: `docs/architecture.md` (glossário + estado real da fórmula de scoring — decaimento
  implementado só em `team_form`, `peso_metadado` continua pendência explícita),
  `docs/learning/06-time-decay.md` (novo) e `docs/learning/README.md` (índice).
- **`tests/fixtures/http/football-data-team-matches.json`** (novo): corpo cru gravado na
  verificação ao vivo, usado pelo teste central de `mapTeamForm` (seção seguinte).

### A verificação ao vivo do endpoint — o que voltou de fato

Chamada real em 2026-09-12: `GET /v4/teams/1769/matches?status=FINISHED&limit=20` (Palmeiras),
token real de `.env`, corpo gravado integralmente em
`tests/fixtures/http/football-data-team-matches.json` (a mesma chamada que a seção 2 da spec já
tinha rodado com `limit=5` para fechar o schema; esta é a repetição com `FORM_FETCH_LIMIT=20`, para
gerar o fixture que os testes consomem).

- **200 OK**, `matches.length === 20` — o teto de `limit` não impôs nenhum valor menor que 20; a
  seção 5 da spec previa registrar aqui se isso acontecesse, e não aconteceu.
- **Proporção BSA/não-BSA na janela de 20**: `resultSet.competitions` confirmou `"CLI,BSA"`; **13
  jogos BSA e 7 CLI** (Copa Libertadores) — 35% fora do campeonato, dentro da faixa que a seção 5
  da spec previu como "pior caso realista" para um clube grande disputando continental junto do
  Brasileirão.
- **Ordem**: os 20 jogos vieram em ordem **crescente** de data (mais antigo primeiro) — confirma de
  novo o achado da seção 2 (a chamada com `limit=5` já tinha mostrado isso), e é exatamente por
  isso que `mapTeamForm` ordena no cliente em vez de confiar na ordem da API.
- **Um `matchday: null`** apareceu entre os 20 (jogo de mata-mata da Libertadores, sem rodada de
  fase de grupos) — confirma que `matchday` de fato pode ser `null` neste endpoint, como a seção 4
  previa; o campo continua não sendo lido.
- Com `team = "palmeiras"`, o resultado de `mapTeamForm` sobre este corpo real: **5 jogos do BSA**
  (1V 3E 1L) e **`otherCompetitionMatch`** = a Copa Libertadores mais recente (Palmeiras 1x0 LDU de
  Quito, fora de ordem cronológica em relação aos jogos do BSA mais antigos que entraram no
  retrospecto — exatamente o caso que a seção 14 pede para travar: um jogo de outra competição mais
  recente que os 5 do campeonato não entra em `matches` nem empurra o corte).
- O adversário "LDU de Quito" não está em `teams.json` (só clubes brasileiros) → resolvido para o
  slug sintético `ldu-de-quito` por `teamIdFromFootballData`, com `console.warn` — o caminho de
  degradação já usado por `mapMatches` funcionou sem alteração nenhuma.

Nenhuma divergência do schema da seção 4 — `footballDataTeamMatchesSchema` validou o corpo real sem
ajuste.

### Desvio da spec — e por quê

**Um único desvio, mecânico, não de comportamento**: a seção 5 declara
`mapTeamForm(teamId, footballDataId, raw): TeamForm` (síncrona). A regra 4 da mesma seção manda
resolver o adversário com `teamIdFromFootballData`, que é **assíncrona** (lê `teams.json` via
`loadIndex()`/`readFile`) — a mesma função que `mapMatches` (o análogo desta função em
`football-data.ts`) já usa, e por isso `mapMatches` também é `async`. Uma função verdadeiramente
síncrona não pode `await` uma chamada assíncrona no meio do laço que resolve cada jogo.

Implementado como `export async function mapTeamForm(...): Promise<TeamForm>`, espelhando
`mapMatches`. O comportamento descrito pela spec (validação, descarte de jogos, partição
BSA/`otherCompetitionMatch`, `record`) é exatamente o mesmo — só o tipo de retorno vira `Promise`.
`getTeamForm` já esperava chamar `mapTeamForm` como parte do seu próprio corpo `async`, então a
mudança não se propaga para nenhum chamador fora deste arquivo. Nenhuma outra parte da spec (schema
do endpoint, partição, regra de ouro, testes) foi reinterpretada.

### Visto e não corrigido (fora de escopo desta tarefa)

- O exemplo literal da seção 9 (trace) e da seção 10 (prompt) mostra o oponente de
  `otherCompetitionMatch` como `"CA River Plate"` (nome bonito). Na prática, `teamName(id, teams)`
  só resolve nomes que estão em `Facts.teams` — que vem de `listTeams()` (só clubes do
  Brasileirão) mais os sintéticos daquela chamada a `getFacts`. Um clube estrangeiro de copa
  continental nunca vai estar ali, então o comportamento real e correto (documentado explicitamente
  na própria seção 9: "que já degrada para o slug quando não acha") é imprimir o slug sintético
  (`ldu-de-quito`, `ca-river-plate`) em vez do nome bonito, quando o clube não é conhecido. Os testes
  desta implementação cobrem os dois casos (nome resolvido quando o time está em `teams.json`/lista
  de teste; slug quando não está) e não travam a expectativa "sempre nome bonito", que a spec não
  garante de fato dar certo neste caso. Não é uma correção de comportamento — é registrar que o
  exemplo ilustrativo da spec é otimista nesse detalhe específico.

### Rodada de correção (revisão local, rodada 1, 2026-09-13)

O `revisor` apontou 3 achados reais, todos corrigidos nesta rodada:

1. **A spec se contradizia consigo mesma, e o schema (mais restrito) vencia em silêncio.**
   `fdTeamMatchSchema.competition` exigia `code`/`name` quando o objeto estava presente
   (`z.object({ code: z.string(), name: z.string() }).nullish()`), então um jogo com `competition`
   presente mas sem `code`/`name` (ex.: `{ id: 2013, name: "..." }`) derrubava o `safeParse` do
   **corpo inteiro**, e `getTeamForm` perdia o retrospecto inteiro — enquanto a prosa da seção 5
   (regra 2) e a tabela da seção 12 já descreviam esse terceiro caso como "descarta só aquele jogo".
   Resolvido a favor da intenção em prosa (decisão de quem orquestra o ciclo, registrada no pedido de
   correção): `competition: z.object({ code: z.string().optional(), name: z.string().optional() }).nullish()`
   em `src/sources/football-data.ts`, e o guard em `mapTeamForm`
   (`src/sources/team-form.ts`) passou a checar os três casos (ausente, `null`, ou presente sem
   `code`/`name` utilizável) descartando só o jogo, com o mesmo `console.warn`. Nota registrada na
   seção 5 (logo após "O jogo sem competição declarada"). O teste que antes só exercitava
   `competition: null` (`tests/sources/team-form.test.ts`) passou a cobrir os três casos num teste só,
   incluindo a checagem de que o corpo inteiro ainda valida.
2. **O system prompt do redator anunciava "duas seções" e listava três no modo `team_form`.**
   `src/generation/writer.ts`: a frase fixa "Duas seções de dados aparecem na mensagem do usuário:"
   ficava intacta mesmo com o bullet de `<recent_form source="api">` acrescentado logo abaixo dela em
   `team_form`. Trocada por uma frase que não conta seções ("Estas seções de dados podem aparecer na
   mensagem do usuário:"), correta nos dois modos, sem tocar em mais nada do system (spec §10, item 1).
3. **Resolver o adversário de jogos que seriam descartados gerava ruído.**
   `src/sources/team-form.ts`: `teamIdFromFootballData` (que emite o `console.warn` de "time
   desconhecido" para clube estrangeiro, em `teams.ts`) era chamado para **todos** os jogos válidos,
   antes da partição BSA/`otherCompetitionMatch` — inclusive jogos de outra competição que não
   sobrevivem ao corte de `RECENT_FORM_SIZE`. Com `FORM_FETCH_LIMIT = 20` trazendo até 7 jogos fora do
   Brasileirão (verificado ao vivo, seção "A verificação ao vivo do endpoint" acima), isso podia gerar
   até 7 avisos por pergunta, a maioria sobre jogos que nunca chegam à resposta. `mapTeamForm` foi
   reordenado: a resolução do adversário (`teamIdFromFootballData`) agora roda só depois da partição e
   do corte, sobre os jogos que sobrevivem (`matches`, até 5 do Brasileirão, mais o único
   `otherCompetitionMatch`, se houver) — no máximo 6 avisos por pergunta, tipicamente menos. O resto da
   lógica (validação, filtro de status/placar/competição, ordenação por data decrescente, cálculo de
   `record` sobre os jogos do Brasileirão pós-corte) não mudou, só a ordem de "quando resolver o
   adversário". Teste novo em `tests/sources/team-form.test.ts` trava esse invariante: com 6 jogos
   BSA e 3 CLI, todos contra adversários desconhecidos, o número de avisos "unknown footballDataId" é
   6 (5 sobreviventes do BSA + 1 `otherCompetitionMatch`), nunca 9.

`npm test`: **247/247 passando** depois das correções (typecheck + vitest; 246 + 1 pelo teste novo do
achado 3 — o teste do achado 1 substituiu um teste existente em vez de somar).
`npx vitest run --config vitest.integration.config.ts tests/integration/live-sources.test.ts` (rede
real): **3/3 passando**, confirmando que `getTeamForm` continua funcionando contra a API real depois
do ajuste de schema do achado 1.

Nenhum achado desta rodada tocou a regra de ouro nem o escopo da spec — os três eram, respectivamente,
uma contradição spec-vs-schema, uma inconsistência de texto no prompt, e uma otimização de quando uma
chamada já existente roda.

## Revisão

Duas rodadas locais, antes do PR.

**Rodada 1**: 3 achados, nenhum na regra de ouro. (1) A spec se contradizia: o schema de
`fdTeamMatchSchema.competition` exigia `code`/`name`, mas a regra/tabela de erro mandava descartar
só o jogo quando `competition` não declarasse os dois — a forma mais restrita (o schema) derrubava
a validação do corpo inteiro em vez de perder só um jogo. Resolvido a favor da intenção do texto:
schema afrouxado, guard em `mapTeamForm` cobrindo os três casos (ausente, `null`, sem `code`/`name`).
(2) O system prompt do redator anunciava "duas seções" mas listava três no modo `team_form` —
corrigido para uma frase que não conta. (3) O adversário de jogos que seriam descartados (fora do
Brasileirão, além do único `otherCompetitionMatch` mantido) era resolvido antes da partição,
gerando até 7 avisos "time desconhecido" por pergunta — reordenado para resolver só os jogos
sobreviventes; caiu pra no máximo 6, tipicamente 1.

**Rodada 2**: confirmou os 3 achados resolvidos, cada um por mutação (não só leitura) — reverter
qualquer uma das três correções faz o teste correspondente falhar. **Sem achado novo.** Duas
observações não bloqueantes, registradas para referência futura: a frase corrigida do prompt não
tem teste próprio (regressão ali passaria silenciosa); e a resolução de adversários sobreviventes
agora roda em paralelo (`Promise.all`) em vez de sequencial, sem efeito de corretude.

Veredito final: **sem achado, pronto para PR.**

## Testes

- `npm test` (`tsc --noEmit && vitest run`, sem rede/Docker): **247/247 passando**, 22 arquivos de
  teste (246/246 antes da rodada de correção acima; +1 pelo teste novo do achado 3).
- `npx vitest run --config vitest.integration.config.ts tests/integration/live-sources.test.ts`
  (rede real, football-data.org/RSS, sem `LLM_CASSETTE`): **3/3 passando**, incluindo o caso novo de
  `getTeamForm("palmeiras")` — no máximo 5 jogos, todos BSA, ordem decrescente, `record` batendo com
  `matches.length`, e (quando presente) `otherCompetitionMatch` fora do BSA e sem overlap com
  `matches`. Rodado de novo depois da rodada de correção, para confirmar o ajuste de schema do
  achado 1 contra a API real.
- `npm run test:integration` completo não foi rodado (gastaria a cota de Voyage/Anthropic de
  `golden-rule.test.ts`/`recall.test.ts`/`ingestion-incremental.test.ts`, que esta tarefa não toca e
  cuja flakiness pré-existente já está documentada na tarefa 04); o teste de integração relevante
  para esta tarefa (`live-sources.test.ts`) foi isolado e rodou verde, como acima.
