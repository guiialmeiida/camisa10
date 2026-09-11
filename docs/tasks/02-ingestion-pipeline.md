# Tarefa 02: Pipeline de ingestão

Corresponde ao nó "Pipeline de ingestão" do diagrama em `docs/architecture.md`. Depende das
tarefas 00 e 01: **substitui a ingestão de uma linha da fatia vertical por um pipeline real.**

## Status
- [x] Discovery
- [x] Refinamento técnico  ← spec aprovada pelo usuário em 2026-09-11, ver nota no início da seção
- [x] Implementação  ← ver seção "Implementação"; unidade 113/113; achado real de infraestrutura
      que bloqueou o `npm run index` de ponta a ponta contra o feed real, ver seção
- [ ] Revisão
- [x] Testes  ← unidade 113/113; integração real: vectorstore 4/4, `ingestion-incremental` 1/1
      (a prova da tarefa), recall@5 = 0.929 (inalterado), regra de ouro 3/3 — ver "Implementação"

## Discovery

Concluído no grilling de 2026-09-11. As quatro perguntas originais mais duas que surgiram na
própria rodada (falha de classificação, flag de recriar do zero):

1. **Deduplicação: `passage.id` (já estável, `sha1(url)`, da tarefa 01) + hash do texto para
   detectar conteúdo alterado na mesma URL.** A tarefa 01 já resolveu "é o mesmo item de novo?"
   com um id estável por URL. O que sobrava era decidir o que fazer se o conteúdo daquela URL
   mudar (matéria editada depois de publicada): comparar hash do texto novo com o já indexado, e
   só reembeddar/reindexar se divergir — barato (comparação de hash antes de gastar embedding) e
   evita servir conteúdo desatualizado em silêncio.
2. **Obsolescência: sem remoção ativa nesta tarefa.** O projeto já tem decaimento temporal
   (`timeDecay`) planejado para as tarefas 04/05 — peso menor pra passage antigo **na hora da
   busca**, não a remoção dele do índice. Esta tarefa só garante que `publishedAt` está correto e
   confiável (pré-requisito pro decaimento funcionar depois). Remoção ativa (índice não crescer
   sem limite) é decisão de política que ainda não tem informação suficiente pra tomar bem, e fica
   em aberto para quando isso virar problema de verdade.
3. **Cadência: CLI incremental, disparada manualmente — sem cron/automação real.** O projeto não
   tem servidor, é uso pessoal via CLI. Automação de verdade (cron, systemd timer, GitHub Action
   agendado) é infraestrutura adicional não justificada ainda; dá pra virar tarefa própria depois
   se fizer sentido deixar isso rodando sozinho.
4. **Tagueamento de time continua por regex** (`tagTeams`, da tarefa 01 — já testado e com um
   bug de falso-positivo corrigido na revisão dela; trocar por LLM reduziria robustez pra gastar
   dinheiro). **Classificação de `PassageType`** (`article`/`chronicle`/`matchReport`/`preview`,
   hoje sempre `"article"` — deixado explicitamente para esta tarefa pela spec aprovada da 01,
   seção 17) **via LLM**, `claude-haiku-4-5` — decidido no grilling de 2026-09-08 que tagueamento
   é classificação curta e de alto volume, cabe nessa classe de modelo (ver tabela em
   `docs/architecture.md`).
5. **Falha na classificação de `type`: cai em `"article"` (default seguro) com aviso, sem
   derrubar a ingestão.** Coerente com "no teto, o sistema responde, nunca falha" — e `"article"`
   já é o valor de hoje para tudo, então é degradação, não regressão.
6. **Mantém uma flag `--recreate`** como escape hatch pra reconstruir a coleção do zero (ex.
   mudança de schema do payload) — já aconteceu nas tarefas 00/01, é barato manter a opção.

Lembrar da regra de ouro, que não foi reaberta aqui: fatos exatos nunca entram no índice
vetorial. Dedup/obsolescência/cadência/tagueamento são todos do lado da narrativa
(`listPassages`/ingestão), nunca do lado dos fatos (`getFacts`).

## Refinamento técnico

> **Spec aprovada pelo usuário em 2026-09-11.** Os 3 pontos em aberto da seção 14 foram
> decididos, seguindo a recomendação dada na aprovação:
>
> 1. **`contentHash` obrigatório no payload**, como a spec propunha — consistente com o padrão
>    já estabelecido na tarefa 00 (falhar alto em coleção desatualizada, não vazar em silêncio).
>    Migração pós-merge: rodar `npm run index -- --recreate` uma vez.
> 2. **`recall.test.ts`/`golden-rule.test.ts` continuam chamando `indexPassages({ recreate:
>    true })`** no `beforeAll`, como a spec propunha — prioriza a coleção de avaliação sempre
>    limpa (sem risco de point órfão de uma execução anterior distorcer o `recall@5`) sobre
>    economizar uma chamada de embedding.
> 3. **A fronteira `chronicle`/`matchReport` foi ajustada**: separa por **tom**, não por escopo
>    temporal. `matchReport` = relato factual de um jogo específico, sem opinião do autor (lances,
>    escalação, cartões — o tipo de texto que quase vira súmula em prosa). `chronicle` = qualquer
>    texto com ângulo autoral/interpretativo, mesmo que seja sobre um jogo só (crítica ao time,
>    "o técnico perdeu o vestiário" etc.) — não só sobre "momento do time" em geral. O texto do
>    prompt na seção 6 já reflete essa versão.

Spec fechada em 2026-09-11 a partir do discovery acima. Nada aqui reabre decisão do discovery.
As decisões que o discovery não tomou porque são de implementação (id de point estável, onde mora
o hash, como consultar o que já está indexado) estão resolvidas aqui e marcadas como tal.

### 0. O que esta tarefa é, em uma frase

`indexPassages()` deixa de **reconstruir** a coleção a cada execução e passa a **convergir** para o
estado da fonte: cada passage é classificado como `new`, `changed` ou `unchanged`, e só os dois
primeiros custam embedding, LLM e escrita no Qdrant. O `--recreate` continua existindo como escape
hatch. De quebra, `PassageType` deixa de ser `"article"` para tudo.

### 1. O que continua exatamente igual

- **A fronteira `src/sources/index.ts` não muda em nada.** Esta tarefa não toca em `getFacts`,
  `listPassages`, `rss.ts`, `teams.ts` nem `tagTeams`. Tagueamento de time continua regex
  (discovery, item 4).
- **`search()`, `SearchResult` e `src/retrieval/` não mudam.** O lado da pergunta não sabe que a
  ingestão virou incremental.
- **Um passage = um chunk, sem corte.** Chunking é a tarefa 03.
- **`npm run index` continua sendo o comando.** Sem cron, sem daemon (discovery, item 3).
- **Regra de ouro**: o único texto que chega ao índice continua vindo de `listPassages()` (RSS), e
  o único número que existe na resposta continua vindo de `getFacts()`. Ver seção 10.

### 2. O modelo mental: reconstruir vs. convergir

Hoje o pipeline é uma função de um estado só: apaga tudo, escreve tudo. É simples porque não
precisa saber o que já existe. O custo é que toda execução paga embedding por 100% dos passages,
e o índice fica vazio durante a janela entre o `deleteCollection` e o `upsert`.

Incremental exige responder a uma pergunta que hoje ninguém faz: **"este passage já está lá, e do
mesmo jeito?"**. Ela se decompõe em duas, e as duas precisam de uma chave estável:

1. *Já está lá?* → o **id do point** precisa ser função determinística de `passage.id`. Hoje é
   `index + 1`, que muda de significado a cada execução.
2. *Do mesmo jeito?* → precisa haver, **guardado no próprio point**, um resumo do conteúdo que foi
   indexado, para comparar sem baixar e reembeddar tudo. É o `contentHash` da seção 4.

Com as duas, a ingestão vira **idempotente**: rodar duas vezes seguidas dá o mesmo índice, e a
segunda execução não gasta nada. Essa propriedade é o que torna aceitável não ter transação
(seção 9): uma falha no meio de um lote é retomada por uma nova execução, não desfeita.

### 3. Id de point estável — `src/vectorstore/point-id.ts` (novo)

O Qdrant só aceita **inteiro sem sinal ou UUID** como id de point (armadilha já registrada na
tarefa 00, §3). Nosso id de verdade é `passage.id`, uma string. Precisamos de uma função total,
determinística e injetiva na prática:

```ts
/**
 * Deterministic Qdrant point id for a passage. Qdrant only accepts an unsigned integer
 * or a UUID as a point id, and our ids are strings — so we hash the passage id and read
 * the first 48 bits of the digest as an integer. 48 bits fits in Number.MAX_SAFE_INTEGER
 * (2^53), so the value survives JSON round-trips without precision loss.
 *
 * Total on purpose: it accepts any string, not just the 12-hex ids rss.ts produces.
 * The fixture double's ids ("p03") are not hex, and Number.parseInt("p03", 16) is NaN.
 */
export function pointIdFromPassageId(passageId: string): number;
```

Contrato:

- **Entrada**: qualquer string não vazia. Vazia → lança `Error("pointIdFromPassageId: empty passage id")`.
- **Saída**: inteiro `>= 0` e `< 2^48`, sempre `Number.isSafeInteger`.
- **Determinismo**: mesma entrada → mesma saída, entre execuções e entre máquinas.
- Implementação: `Number.parseInt(createHash("sha1").update(passageId).digest("hex").slice(0, 12), 16)`.

**Por que hashear um id que já é hash** (`rss.ts` já faz `sha1(url).slice(0,12)`): porque a função
precisa valer para **qualquer** `passage.id`, e o dublê de teste (`tests/fixtures/`) usa `p01`…`p14`.
Uma função com dois caminhos ("se for hex, converte; senão, hasheia") é uma ramificação a mais para
o usuário entender e um lugar a mais para divergir. O custo de um sha1 sobre 12 caracteres é
irrelevante perto de uma chamada de embedding.

**Por que não UUID determinístico (v5):** o Node não traz UUIDv5 pronto (`crypto.randomUUID` é v4,
aleatório), então seria manipular bits de versão e variante à mão — mais código para chegar ao
mesmo lugar. Inteiro de 48 bits é legível no `curl` do Qdrant e cabe num `number` sem BigInt.

**A colisão**, que é o risco real de truncar para 48 bits: com ~10⁴ passages a probabilidade é da
ordem de 10⁻⁹, mas ela não pode virar sobrescrita silenciosa. Duas guardas, ambas no indexer
(seção 7): id de point repetido **dentro do mesmo lote** com `passageId` diferente lança; e
`passageId` guardado no point diferente do `passageId` do passage que mapeia para aquele id lança.
As duas mensagens citam os dois `passageId`.

### 4. `contentHash` — `src/ingestion/content-hash.ts` (novo) e a mudança no payload

```ts
import type { Passage } from "../sources/types.ts";

/**
 * Fingerprint of the passage content that was indexed. Covers title + text: both come
 * from the same feed item, the text is what gets embedded, and the title is what the
 * writer cites — an edited headline should refresh the point too.
 *
 * Deliberately does NOT cover `type`, `teams`, `matchweek` or `competition`:
 * `type` is produced by the classifier (hashing it would force a classification before
 * the hash, defeating the point), and `matchweek` changes every week — hashing it would
 * invalidate the whole index every Sunday.
 */
export function contentHash(passage: Pick<Passage, "title" | "text">): string;
```

- Saída: sha1 em hex, 40 caracteres minúsculos. `sha1(`${title}\n${text}`)`.
- Sem normalização (trim, lowercase, colapso de espaço): `stripHtml` já colapsa espaço no caminho
  do RSS, e normalizar aqui esconderia uma edição real do texto.
- sha1 e não sha256 por coerência com `rss.ts`, que já usa sha1 para o id. É fingerprint de
  conteúdo, não segurança.

**`src/vectorstore/types.ts` ganha o campo** (é o único jeito de a comparação sobreviver ao
processo — o Qdrant é o nosso "banco"):

```ts
export const passagePayloadSchema = z.strictObject({
  passageId: z.string().min(1),
  contentHash: z.string().length(40),   // novo — ver src/ingestion/content-hash.ts
  text: z.string().min(1),
  title: z.string().min(1),
  source: z.string().min(1),
  url: z.string(),
  type: z.enum(["article", "chronicle", "matchReport", "preview"]),
  teams: z.array(z.string()),
  matchId: z.string().min(1).nullable(),
  competition: z.string().min(1),
  matchweek: z.number().int().positive(),
  publishedAt: z.string(),
});
```

**Campo obrigatório, não opcional.** Consequência assumida: um point indexado antes desta tarefa
não tem `contentHash`, e `search()` (que valida o payload com `z.strictObject`) **vai lançar** ao
recuperá-lo. É o comportamento que a tarefa 00 já desenhou de propósito ("coleção desatualizada
depois de mudar o schema é exatamente o bug que isso pega"). Por isso: **depois do merge desta
tarefa, a primeira execução precisa ser `npm run index -- --recreate`**, uma única vez. Isso vai no
README e na mensagem do próprio erro já existente.

Exemplo literal do payload depois desta tarefa (os dois hashes são ilustrativos — os valores reais
saem do sha1):

```json
{
  "passageId": "9f2c41ab77de",
  "contentHash": "3d5a1f0b9c2e47a86f1d0b3c5e7a9d2f4b6c8e01",
  "text": "O técnico deixou o gramado vaiado. A torcida cobrou o elenco no fim da partida e...",
  "title": "Palmeiras perde para o Fluminense no Allianz e vê pressão aumentar",
  "source": "Gazeta Esportiva",
  "url": "https://www.gazetaesportiva.com/palmeiras/palmeiras-perde-para-o-fluminense/",
  "type": "matchReport",
  "teams": ["palmeiras", "fluminense"],
  "matchId": null,
  "competition": "brasileirao-serie-a",
  "matchweek": 27,
  "publishedAt": "2026-09-05T23:47:00-03:00"
}
```

**Nenhum campo numérico de placar entra aqui**, e o `z.strictObject` mantém isso como erro de parse
em vez de vazamento silencioso. `matchweek` continua sendo o único número do payload, e ele é
metadado de filtro (tarefas 04/05), não um fato citável.

**Consequência semântica do incremental, que vale registrar**: o `matchweek` de um point passa a
ser o da rodada em que ele foi indexado pela primeira vez, e não mais "a rodada corrente da última
execução". Isso é melhor — uma notícia da rodada 26 deixa de ser reetiquetada como 27 toda semana —
e é justamente o que as tarefas 04/05 vão querer filtrar. O `--recreate`, por outro lado,
reetiqueta tudo com a rodada corrente; é uma limitação conhecida do escape hatch, não um bug.

### 5. Consultar o que já está indexado — `fetchDigests()` em `src/vectorstore/qdrant.ts`

Hoje não existe forma de ler um point sem fazer busca vetorial, e busca vetorial é a ferramenta
errada: ela devolve os *k* mais parecidos, não "estes ids exatos". Como o id de point virou
determinístico (seção 3), dá para pedir exatamente os ids do lote com **uma** chamada, sem vetor
nenhum. O `@qdrant/js-client-rest` tem `retrieve(collection, { ids, with_payload, with_vector })`
(confirmado em `node_modules/@qdrant/js-client-rest/dist/types/qdrant-client.d.ts`, linha 254).

Em `src/vectorstore/types.ts`:

```ts
/** Just enough of a stored point to answer "is it already there, and unchanged?". */
export interface IndexedDigest {
  pointId: number;
  passageId: string;
  contentHash: string;
}
```

Em `src/vectorstore/qdrant.ts`:

```ts
/**
 * Digest of the points that already exist, for the given point ids. Ids that aren't in
 * the collection are simply absent from the result — missing is not an error.
 * Returns [] when the collection doesn't exist yet (first run).
 * Requests only the two payload fields it needs, never the vectors or the full text.
 */
export async function fetchDigests(pointIds: number[]): Promise<IndexedDigest[]>;
```

Regras:

- Chama `collectionExists` antes; se não existe, devolve `[]` **sem criar a coleção** — assim a
  mensagem `collection '...' does not exist — run: npm run index` do `search()` continua existindo
  para quem perguntar antes de indexar.
- `with_payload: ["passageId", "contentHash"]`, `with_vector: false`. Trazer o `text` de 40 notícias
  só para comparar seria pagar a rede duas vezes pelo mesmo texto.
- Chama em lotes de **256 ids** (`RETRIEVE_BATCH_SIZE`), concatenando os resultados. Uma URL/corpo
  com milhares de ids é o tipo de coisa que funciona no teste e falha em produção.
- Valida o payload parcial com um `z.object({ passageId: z.string().min(1), contentHash:
  z.string().min(1) })` — **não** `strictObject`, porque estamos pedindo dois campos de um payload
  que tem doze. Point cujo payload não bate (ex.: indexado antes desta tarefa, sem `contentHash`)
  é **omitido do resultado com `console.warn`**, o que o faz ser tratado como ausente e
  reindexado. Degradação graciosa em vez de falha: o pipeline se conserta sozinho no próximo
  `npm run index`.
- Erro de rede/Qdrant fora do ar: **lança**, com a mesma formatação de `search()`
  (`could not reach Qdrant at ${url}: ...`). Não devolver `[]` em caso de erro — `[]` significa
  "nada indexado" e faria o pipeline reembeddar e reescrever tudo achando que o índice está vazio.

`insertPoints()`, `ensureCollection()`, `search()` e `countPoints()` não mudam. O `upsert` do
Qdrant já é "insere ou substitui por id", que é exatamente a semântica que a seção 7 precisa —
não há função nova de update.

### 6. Classificação de `PassageType` — `src/ingestion/classify.ts` (novo)

Discovery, itens 4 e 5. Hoje `rss.ts` devolve `type: "article"` para tudo.

#### `src/config/models.ts` ganha uma linha

```ts
export const MODELS = {
  entityExtraction:     { model: "claude-haiku-4-5", maxTokens: 512 },
  passageClassification: { model: "claude-haiku-4-5", maxTokens: 128 },  // ingestão, tarefa 02
  planner:              { model: "claude-opus-5", effort: "medium", maxTokens: 1024 },
  writer:               { model: "claude-opus-5", effort: "high",   maxTokens: 2048 },
} as const satisfies Record<string, ModelConfig>;
```

`claude-haiku-4-5` vem da tabela de `docs/architecture.md`, não da memória de ninguém: é a classe
de modelo que o projeto reservou para classificação curta e de alto volume. `maxTokens: 128` porque
a saída é um objeto de um campo; um teto baixo é a rede contra um modelo que resolve "explicar".

É a primeira entrada de `MODELS` que **não** é um nó do agente em runtime. `docs/architecture.md`
ganha uma linha na tabela de modelos marcando isso (seção 11).

#### Contrato

```ts
import type { Passage, PassageType } from "../sources/types.ts";

export const passageTypeClassificationSchema = z.strictObject({
  type: z.enum(["article", "chronicle", "matchReport", "preview"]),
});

export interface Classification {
  passageId: string;
  type: PassageType;
  /** true when the LLM call failed and "article" was used as the safe default. */
  fallback: boolean;
}

/** Never throws: an LLM failure becomes { type: "article", fallback: true } + a warn. */
export async function classifyPassageType(passage: Passage): Promise<Classification>;

/** Same order as the input. Runs in chunks of CLASSIFY_CONCURRENCY. Never throws. */
export async function classifyPassageTypes(passages: Passage[]): Promise<Classification[]>;
```

- Uma chamada de LLM por passage, via `callStructured` (`src/agent/llm.ts`) — o mesmo helper e o
  mesmo padrão de `extractEntity`, com `schemaName: "passageType"`.
- Um `satisfies` no módulo garante que `z.infer<typeof passageTypeClassificationSchema>["type"]`
  não divirja de `PassageType`, no mesmo estilo de `extract-entity.ts`.
- **Concorrência limitada**: `const CLASSIFY_CONCURRENCY = 5`, como fatias sequenciais de
  `Promise.all`. 40 chamadas simultâneas contra a Anthropic é o jeito mais fácil de transformar
  "ingestão" em "rate limit".
- **Falha é por item, nunca do lote** (discovery, item 5): o `try/catch` mora dentro da função de
  um passage, então uma exceção não contamina os outros quatro da fatia. `console.warn` com o
  `passageId` e a mensagem do erro.

**Por que uma chamada por passage e não uma só com a lista inteira**: uma chamada em lote é mais
barata, mas devolve um array que precisa ser realinhado com a entrada (modelo pula item, inverte
ordem, inventa id), e uma falha perde os 40 de uma vez. Com uma chamada por item, o fallback do
discovery cai naturalmente no item que falhou. Se o custo virar problema, lote é uma otimização
localizada nesta função.

#### O prompt

`system` (prosa em português, como o do `extractEntity`; os valores são os literais em inglês do
tipo):

```
Você classifica o gênero de uma matéria de futebol brasileiro em exatamente uma categoria.

- "preview": publicado ANTES da partida — provável escalação, desfalques, expectativa, onde assistir.
- "matchReport": relato FACTUAL de uma partida já disputada, sem opinião do autor — lances,
  escalação, substituições, cartões. É quase uma súmula em prosa.
- "chronicle": texto com ÂNGULO AUTORAL ou interpretativo, mesmo que seja sobre um jogo só —
  crítica, análise, coluna assinada, "o técnico perdeu o vestiário", leitura sobre o momento do
  time. O que separa de "matchReport" é o tom (opinativo vs. factual), não o assunto.
- "article": qualquer outra notícia — contratação, lesão, bastidor, declaração, arbitragem, situação institucional. É a categoria padrão.

Na dúvida entre duas categorias, responda "article".
Não escreva placares, números nem trechos do texto: sua resposta é só a categoria.
```

`user`:

```
título: {title}
fonte: {source}
publicado em: {publishedAt}
texto:
{text, truncado em 1500 caracteres}
```

O truncamento em 1500 caracteres limita o custo e não perde nada: gênero de matéria se decide no
lead, e o texto do RSS já é um resumo.

**Contenção da regra de ouro nesta chamada**: a saída do LLM é um `z.enum` de quatro literais.
Não existe campo de texto livre na resposta, então **não há por onde um número que o modelo leu no
texto chegar ao payload**. Isso não é sorte do prompt, é o schema. Ver seção 10.

### 7. O novo `indexPassages()` — `src/ingestion/indexer.ts`

```ts
export interface IndexOptions {
  /** Drop and rebuild the collection instead of converging to the source. */
  recreate?: boolean | undefined;
}

export interface IndexReport {
  collection: string;
  mode: "incremental" | "recreate";
  /** How many passages the source returned. */
  passages: number;
  /** Not in the collection yet. */
  newPassages: number;
  /** Already there, with a different contentHash. */
  changed: number;
  /** Skipped: same contentHash, no embedding and no write. */
  unchanged: number;
  /** Points upserted — always newPassages + changed. */
  points: number;
  /** How many classifications fell back to "article" because the LLM call failed. */
  classificationFallbacks: number;
  /** How many points were written per PassageType — the CLI prints this. Sums to `points`. */
  typeCounts: Record<PassageType, number>;
}

export async function indexPassages(options?: IndexOptions): Promise<IndexReport>;
```

`newPassages` e não `new` porque `new` é palavra reservada. O campo `points` continua existindo com
o mesmo nome de hoje (passa a significar "upserted", que no modo `recreate` é o mesmo número de
antes), e `passages` continua sendo o total vindo da fonte.

#### A sequência, passo a passo

1. `const [passages, facts] = await Promise.all([listPassages(), getFacts({})])` — igual a hoje.
2. **Guard de lista vazia, antes de qualquer coisa tocar o Qdrant** (herdado da tarefa 01, continua
   valendo com força maior no modo `recreate`): `passages.length === 0` → lança a mesma mensagem
   de hoje.
3. `const pointIds = passages.map((p) => pointIdFromPassageId(p.id))`, com a **guarda de colisão
   intra-lote**: dois `passageId` diferentes para o mesmo `pointId` → lança citando os dois.
4. **O diff**:
   - Modo `recreate`: `digests = []` — todo passage é `new`, e `fetchDigests` nem é chamado. Para
     não descobrir que o Qdrant está fora só depois de gastar embedding e LLM, este ramo chama
     antes `await ensureCollection()` (**não destrutivo**, cria se não existir) como verificação
     barata de saúde.
   - Modo incremental: `digests = await fetchDigests(pointIds)`, transformado num
     `Map<number, IndexedDigest>`. Esta chamada é também a verificação de saúde do modo
     incremental: se o Qdrant não responde, a execução morre aqui, antes de gastar um centavo.
   - Para cada passage: `hash = contentHash(passage)`; `digest = map.get(pointId)`.
     - `digest === undefined` → **new**.
     - `digest.passageId !== passage.id` → **lança** (colisão entre execuções, seção 3).
     - `digest.contentHash !== hash` → **changed**.
     - senão → **unchanged**, descartado do resto do pipeline.
5. `const toIndex = [...new, ...changed]`. Se `toIndex.length === 0`: devolve o relatório com
   `points: 0` **sem chamar embedding, LLM ou upsert**. É o caminho mais comum de uma segunda
   execução no mesmo dia, e é a prova visível de que o incremental funciona.
6. `const classifications = await classifyPassageTypes(toIndex)` — só o que vai ser indexado.
7. `const vectors = await embedAll(toIndex.map((p) => p.text), "document")` — `inputType`
   continua `"document"`, como hoje.
8. Se `recreate`: **agora** `await ensureCollection({ recreate: true })`. A destruição acontece o
   mais tarde possível, depois de embeddings e classificação terem dado certo — é a mesma ordem
   defensiva que o código de hoje já usa. Se incremental: `await ensureCollection()` (cria se não
   existir; no-op no caso normal).
9. Monta os `Point[]`: `id: pointIds[i]`, `vector`, e o payload da seção 4 — `contentHash` do
   passo 4, `type` de `classifications[i].type` (com asserção de que
   `classifications[i].passageId === passage.id`), `matchweek: facts.matchweek`,
   `competition: facts.competition.id`, o resto direto do passage. Comportamento de hoje mantido.
10. `insertPoints` em lotes de **64** (`UPSERT_BATCH_SIZE`), somando os retornos.
11. Devolve o `IndexReport`.

#### Exemplo literal de relatório

```json
{
  "collection": "camisa10",
  "mode": "incremental",
  "passages": 38,
  "newPassages": 4,
  "changed": 2,
  "unchanged": 32,
  "points": 6,
  "classificationFallbacks": 1
}
```

### 8. A CLI — `src/cli/index-passages.ts`

```
npm run index                 # incremental (padrão)
npm run index -- --recreate   # apaga a coleção e reconstrói do zero
```

O `--` é exigência do npm para repassar o argumento; o `USAGE` mostra assim. Parse no mesmo estilo
de `src/cli/ask.ts`: laço sobre `process.argv.slice(2)`, flag desconhecida lança com o `USAGE`,
`process.exitCode = 2` e `return` (não `process.exit()` — a nota sobre stdout truncado em
`ask.ts` vale igual aqui). Erro de execução: mensagem e `exitCode = 1`. Sucesso: `exitCode = 0`.

Saída de sucesso, incremental:

```
$ npm run index
collection camisa10 (incremental)
  38 passages from the source
  4 new, 2 changed, 32 unchanged
  6 classified: 3 article, 2 matchReport, 1 chronicle  (1 fallback)
  6 points upserted
```

Nada a fazer:

```
$ npm run index
collection camisa10 (incremental)
  38 passages from the source
  0 new, 0 changed, 38 unchanged
  nothing to do — no embeddings, no LLM calls, no writes
```

Reconstrução:

```
$ npm run index -- --recreate
collection camisa10 (recreate)
  38 passages from the source
  38 to index (full rebuild)
  38 classified: 29 article, 6 matchReport, 3 chronicle  (0 fallbacks)
  38 points upserted
```

A linha `classified:` é o artefato de aprendizado desta tarefa, no espírito do trace da tarefa 00:
mostra o que o classificador decidiu, em agregado, sem ninguém precisar abrir o Qdrant. Ela vem do
`typeCounts` do `IndexReport` (seção 7) — por isso o campo existe lá em vez de a CLI reconsultar o
índice. Tipo com contagem zero é omitido da linha. Exemplo do campo:

```json
"typeCounts": { "article": 3, "chronicle": 1, "matchReport": 2, "preview": 0 }
```

### 9. Tratamento de erro, em uma tabela

| onde | situação | comportamento |
|---|---|---|
| `listPassages` | todos os feeds falham | **lança** (já é assim desde a tarefa 01). O guard do passo 2 continua sendo a segunda rede |
| `indexPassages` | fonte devolve `[]` | **lança antes de tocar o Qdrant** — comportamento de hoje, preservado |
| `fetchDigests` | Qdrant fora do ar / erro HTTP | **lança**, e a execução morre antes de gastar embedding ou LLM |
| `fetchDigests` | coleção não existe | `[]` — primeira execução, tudo é `new`. Não é erro |
| `fetchDigests` | payload de um point sem `contentHash` (indexado antes desta tarefa) | `console.warn` + omitido → o point é reindexado e se conserta sozinho |
| `classifyPassageType` | LLM falha, estoura timeout, ou devolve fora do schema | `console.warn` + `{ type: "article", fallback: true }`. **Nunca derruba a ingestão** (discovery, item 5) |
| `embedAll` | Voyage falha | **lança** — sem vetor não há point, e no modo `recreate` a coleção ainda está intacta (passo 8) |
| `insertPoints` | um lote falha no meio | **lança**, com quantos points já entraram na mensagem. **Sem rollback**: os lotes anteriores estão escritos com ids estáveis e `contentHash` correto, então a próxima execução os vê como `unchanged` e retoma exatamente de onde parou. Idempotência no lugar de transação |
| colisão de id de point | dentro do lote, ou contra o que está indexado | **lança**, citando os dois `passageId`. Sobrescrever em silêncio seria perder um passage sem nenhum sinal |

A regra "no teto o sistema responde, nunca falha" continua sendo do runtime do agente, não da
ingestão. Ingestão é batch disparado à mão: falhar alto e ser retomável é melhor do que produzir um
índice parcial em silêncio. A **única** exceção é a classificação, e ela é explícita no discovery.

### 10. Regra de ouro: por onde um número poderia entrar, e por que não entra

Esta tarefa acrescenta duas coisas ao caminho da ingestão — uma chamada de LLM e um campo de
payload. Ambas foram desenhadas para não abrir porta nenhuma:

1. **O classificador é o primeiro LLM a ler o texto das notícias na ingestão.** A saída dele é
   `z.strictObject({ type: z.enum([...]) })`: quatro literais, nenhum campo livre. Mesmo que o
   modelo leia "Palmeiras 1 x 3 Fluminense" e queira repetir, não há onde escrever. O
   `callStructured` valida antes de devolver; qualquer outra coisa vira exceção e cai no fallback.
2. **`contentHash` é um digest hexadecimal**, não conteúdo. Ele não é indexado, não é embeddado,
   não vai para o prompt do writer e não aparece na resposta.
3. **Nada em `getFacts` muda**, e nenhum campo novo do lado dos fatos entra no payload.
   `passagePayloadSchema` continua `z.strictObject` sem nenhum campo de placar — um `score`
   esquecido continua sendo erro de parse.
4. `matchweek` continua sendo o único inteiro do payload, e continua não sendo citável: o writer só
   pode escrever número que veio de `<facts source="api">`.

Teste executável correspondente na seção 12 (`payload keys`), e `golden-rule.test.ts` continua
sendo a rede de ponta a ponta.

### 11. Arquivos a criar ou alterar

**Criar**
```
src/vectorstore/point-id.ts               pointIdFromPassageId
src/ingestion/content-hash.ts             contentHash
src/ingestion/classify.ts                 classifyPassageType(s) + schema + prompt
tests/vectorstore/point-id.test.ts
tests/ingestion/content-hash.test.ts
tests/ingestion/classify.test.ts
tests/integration/ingestion-incremental.test.ts
docs/learning/03-ingestion-pipeline.md
```

**Alterar**
```
src/ingestion/indexer.ts             incremental + recreate; IndexOptions/IndexReport (seção 7)
src/vectorstore/qdrant.ts            fetchDigests()
src/vectorstore/types.ts             contentHash no payload; IndexedDigest
src/config/models.ts                 MODELS.passageClassification
src/cli/index-passages.ts            flag --recreate; nova saída
tests/ingestion/indexer.test.ts      casos novos (seção 12); o guard de lista vazia continua
tests/integration/vectorstore.test.ts        contentHash no samplePoint + caso de fetchDigests
tests/integration/recall.test.ts     indexPassages({ recreate: true }) + mock de classify.ts
tests/integration/golden-rule.test.ts        idem
tests/graph.test.ts                  contentHash no samplePayload (typecheck)
tests/trace.test.ts                  idem
tests/writer.test.ts                 idem
README.md                            npm run index -- --recreate; o "rode uma vez" pós-merge
docs/learning/README.md              linha nova no índice
docs/architecture.md                 tabela de modelos: linha da classificação (ingestão, não runtime);
                                     glossário: contentHash, digest, incremental
```

**Nada a apagar.**

`docs/learning/03-ingestion-pipeline.md` cobre o conceito da tarefa: por que ingestão é um problema
de convergência e não de reconstrução, o que é um id determinístico e por que ele é o que torna o
upsert possível, o que é um digest de conteúdo e por que ele vem antes do embedding (comparar hash
custa microssegundos, embeddar custa dinheiro e rede), e por que classificar com LLM é aceitável
onde taguear time com LLM não era. Termina no bloco **"Por que não X?"**: por que não `scroll` com
filtro por `passageId`, por que não UUIDv5, por que não deletar o que sumiu do feed (discovery,
item 2), por que não cron (item 3), por que não uma chamada de LLM em lote.

### 12. Casos de teste

Unidade (`npm test` — `tsc --noEmit && vitest run`, sem rede e sem Docker):

`tests/vectorstore/point-id.test.ts`
- Mesma entrada devolve o mesmo id em duas chamadas — **a propriedade que o incremental inteiro
  usa**.
- `"p03"` (não-hexadecimal, o dublê de teste) devolve um inteiro, não `NaN`.
- O resultado é `Number.isSafeInteger`, `>= 0` e `< 2 ** 48`, para uma amostra de ids de fixture e
  de ids de RSS (12 hex).
- Ids diferentes dão pontos diferentes, para os 14 ids do fixture.
- String vazia lança.

`tests/ingestion/content-hash.test.ts`
- Mesmo `{ title, text }` → mesmo hash; 40 caracteres `/^[0-9a-f]{40}$/`.
- Texto diferente → hash diferente. **Título diferente com o mesmo texto → hash diferente** (é a
  decisão da seção 4 virando teste).
- `{ title: "a", text: "bc" }` e `{ title: "a\nb", text: "c" }` **não** colidem (o separador está
  fazendo trabalho).

`tests/ingestion/classify.test.ts` (`src/agent/llm.ts` mockado)
- Devolve o `type` que o LLM produziu, com `fallback: false`.
- `callStructured` rejeitando → `{ type: "article", fallback: true }`, **sem rejeitar a promise**,
  com `console.warn` contendo o `passageId`.
- Numa lista de 3 em que a do meio falha, as outras duas mantêm o tipo do LLM — a falha é do item,
  não do lote.
- A ordem da saída é a da entrada, e `passageId` bate posição a posição.
- Usa `MODELS.passageClassification` (asserção sobre o argumento do mock) — o modelo por etapa é
  configuração, não literal solto no módulo.
- O `user` enviado contém o título e não passa de 1500 caracteres de texto.

`tests/ingestion/indexer.test.ts` (sources, embed, qdrant e classify mockados — extensão do arquivo
existente)
- **(mantido)** Fonte com `[]` lança **antes** de `ensureCollection` e antes de `fetchDigests` — o
  índice não é apagado nem consultado.
- **(mantido)** `matchweek` vem de `facts.matchweek`; `matchId: null` passa pelo payload.
- Incremental, todos os `contentHash` batendo: `embedAll`, `classifyPassageTypes` e `insertPoints`
  **não são chamados**; relatório `{ unchanged: N, points: 0 }`.
- Incremental, um passage com texto alterado: só ele é embeddado e upsertado, e **com o mesmo
  `point.id` do digest existente** — a prova de que o upsert atualiza em vez de duplicar.
- Incremental, um passage ausente do digest: contabilizado em `newPassages` e indexado.
- Incremental com a coleção inexistente (`fetchDigests` → `[]`): tudo é `new`.
- `recreate: true`: `fetchDigests` **não** é chamado, `ensureCollection` é chamado com
  `{ recreate: true }`, e todos os passages entram.
- `recreate: true` com `embedAll` rejeitando: `ensureCollection({ recreate: true })` **não** chega a
  ser chamado — a coleção sobrevive à falha de embedding.
- Dois passages cujo `pointIdFromPassageId` colide (módulo `point-id.ts` mockado para devolver
  constante) → lança, com os dois `passageId` na mensagem.
- Digest com `passageId` diferente do passage que mapeia para aquele id → lança.
- `insertPoints` falhando no segundo lote de 64 → a exceção sobe; o teste registra quantos points
  entraram.
- `classifyPassageTypes` devolvendo um `fallback: true` → `classificationFallbacks: 1` no relatório.
- **Invariante da regra de ouro**: para cada point construído, `passagePayloadSchema.parse(payload)`
  passa e `Object.keys(payload)` é exatamente o conjunto de chaves do schema — nenhum campo de
  placar, nenhum campo a mais.
- `typeCounts` soma exatamente `points`.

Integração (`npm run test:integration`, Qdrant real):

`tests/integration/ingestion-incremental.test.ts` (novo) — **é o teste que prova a tarefa**. Usa o
dublê do fixture (`vi.mock` de `src/sources/index.ts`, como `recall.test.ts` já faz),
`classify.ts` mockado com identidade (`passages.map((p) => ({ passageId: p.id, type: p.type,
fallback: false }))`) para não gastar LLM nem introduzir variância, e coleção própria
(`QDRANT_COLLECTION = "camisa10-ingestion-test"`, apagada no `afterAll`):
1. Primeira execução com `{ recreate: true }` → `points: 14`, `countPoints() === 14`.
2. Segunda execução, sem opções → `unchanged: 14, points: 0`, `countPoints()` **continua 14** e
   nenhuma chamada de embedding é feita (spy sobre `embedAll`).
3. Terceira execução com o `text` de um passage alterado no dublê → `changed: 1, points: 1`,
   `countPoints()` **continua 14** (atualizou, não duplicou), e o `search()` daquele point devolve
   o texto novo.
   Timeout generoso (60s) e atenção ao limite de 3 req/min da Voyage: o arquivo faz 2 chamadas de
   embedding no total, e `fileParallelism: false` já está ligado no `vitest.integration.config.ts`.

`tests/integration/vectorstore.test.ts` (alterado)
- `samplePoint` ganha `contentHash`.
- Caso novo: insere 2 points e chama `fetchDigests` com 3 ids (um inexistente) → devolve 2 digests,
  com `passageId` e `contentHash` corretos; o id ausente simplesmente não aparece.

`tests/integration/recall.test.ts` e `golden-rule.test.ts` (alterados)
- `beforeAll` passa a chamar `indexPassages({ recreate: true })`. Determinismo: um teste de
  avaliação não pode depender do que sobrou de uma execução anterior na coleção
  `camisa10-eval` — se o fixture mudar, o incremental deixaria points órfãos lá dentro.
- `classify.ts` mockado com identidade nos dois arquivos, para preservar os `type` curados do
  fixture (p05/p07/p10 são `chronicle`, p01/p08/p11 são `preview`) e para não somar 14 chamadas de
  LLM — e 14 entradas de cassette — a cada execução.
- **`recall@5` não pode mudar**: continua `>= 0.8`, com a linha de base `0.929` da tarefa 01.
  Fixture, modelo de embedding e chunking não mudaram nesta tarefa; se o número mexer, é regressão.
- `golden-rule.test.ts` continua 3/3, incluindo a pausa de 20s já documentada na tarefa 01.
- **Cassettes**: os prompts de `extractEntity`, `planner` e `writer` não mudam nesta tarefa e o
  classificador está mockado nos testes de integração, então
  `tests/integration/__cassettes__/llm-calls.json` **não precisa ser regravado**. Se a implementação
  descobrir o contrário, regravar seguindo o cuidado documentado na tarefa 01 (backup → tentativa →
  restaurar em caso de falha).

### 13. Fora de escopo desta tarefa

- **Remoção de passage obsoleto do índice** (discovery, item 2): nada é deletado, nem o que sumiu do
  feed. `timeDecay` nas tarefas 04/05 resolve o peso; política de retenção vira tarefa própria
  quando o índice crescer a ponto de incomodar.
- **Cron, systemd, GitHub Action, daemon, watcher** (discovery, item 3). A CLI é disparada à mão.
- **Tagueamento de time por LLM** (discovery, item 4). `tagTeams` por regex fica como está.
- **Ligar passage a partida (`matchId`)**. Continua `null` para tudo que vem do RSS.
- **Chunking, `matchweek` por análise do texto, peso de metadado, decaimento temporal, grader,
  critic** — tarefas 03 a 06.
- **Cache das chamadas de `getFacts` em tempo de pergunta.** A tarefa 01 adiou isso "para a tarefa
  02" falando de *cadência de ingestão*, que é o item 3 do discovery daqui; cache do lado da
  pergunta não foi levantado no discovery desta tarefa e não entra por tabela.
- **Reindexar quando só o metadado muda** (`teams` melhorado por um `tagTeams` corrigido,
  `publishedAt` corrigido pela fonte). O `contentHash` cobre título e texto; o resto se atualiza com
  `--recreate`. Cobrir isso exigiria hashear campos que mudam por motivos não relacionados (seção 4).
- **Evitar a chamada a `getFacts({})` quando nada mudou.** Ela continua acontecendo em toda
  execução, como hoje. É 1 requisição contra um limite de 10/min.
- **Lotear as chamadas à Voyage.** `embedAll` continua mandando o lote inteiro numa requisição, como
  hoje; o feed traz dezenas de itens, não milhares.
- **`--dry-run`** (imprimir o diff sem gastar embedding/LLM). Seria útil e é barato, mas não foi
  pedido no discovery; `npm run index` já revela o diff na primeira linha do resultado.
- **Mexer no `tsconfig.json`.** Segue sendo pré-condição.

### 14. Pontos em aberto para o usuário

Três decisões que não são minhas. As duas primeiras não bloqueiam a implementação; a terceira, sim.

1. **A migração depois do merge é `npm run index -- --recreate`, rodado à mão uma vez.** Como
   `contentHash` é campo obrigatório do payload (seção 4), todo point indexado antes desta tarefa
   passa a fazer `search()` lançar. A alternativa era `contentHash` opcional no schema, que evitaria
   o passo manual ao preço de o índice aceitar em silêncio points que o pipeline não sabe comparar.
   Escolhi o obrigatório porque é o que o projeto já faz em outros pontos (falhar alto em coleção
   desatualizada) — mas é o seu índice que precisa ser reconstruído, então a escolha é sua.

2. **`recall.test.ts`/`golden-rule.test.ts` passam a chamar `indexPassages({ recreate: true })`.**
   O incremental economizaria a chamada de embedding do `beforeAll` — o que aliviaria de verdade o
   limite de 3 req/min da Voyage que já obrigou a pausa de 20s na tarefa 01. Escolhi o `recreate`
   mesmo assim, porque teste de avaliação que depende de estado deixado por uma execução anterior é
   exatamente o tipo de teste que passa por motivo errado. Se preferir trocar velocidade da suíte
   por essa garantia, é uma linha em cada arquivo.

3. **O critério de `chronicle` vs. `matchReport` no prompt do classificador é meu, e é editorial.**
   Escrevi "`matchReport` = o que aconteceu em campo; `chronicle` = texto autoral/opinativo". Na
   Gazeta Esportiva, boa parte das matérias pós-jogo fica na fronteira dos dois, e essa etiqueta vai
   virar peso de metadado nas tarefas 04/05 — ou seja, a fronteira que você traçar aqui muda o que o
   RAG vai priorizar depois. Se a sua intenção for outra (por exemplo: `matchReport` só para súmula
   com escalação e cartões, e tudo mais vira `article`), o texto do prompt muda antes de a
   implementação começar.

## Implementação

Implementado em 2026-09-11 contra a spec da seção "Refinamento técnico", sem reabri-la.

### O que foi criado

Todos os arquivos novos da seção 11: `src/vectorstore/point-id.ts` (`pointIdFromPassageId`);
`src/ingestion/content-hash.ts` (`contentHash`); `src/ingestion/classify.ts`
(`classifyPassageType(s)` + schema + prompt); `tests/vectorstore/point-id.test.ts`;
`tests/ingestion/{content-hash,classify}.test.ts`; `tests/integration/ingestion-incremental.test.ts`;
`docs/learning/03-ingestion-pipeline.md`.

### O que foi alterado

`src/ingestion/indexer.ts` (reescrito: diff `new`/`changed`/`unchanged`, `IndexOptions`/
`IndexReport` da seção 7); `src/vectorstore/qdrant.ts` (`fetchDigests`); `src/vectorstore/types.ts`
(`contentHash` obrigatório no payload, `IndexedDigest`); `src/config/models.ts`
(`MODELS.passageClassification`); `src/cli/index-passages.ts` (flag `--recreate`, nova saída);
`tests/ingestion/indexer.test.ts` (casos novos da seção 12, o guard de lista vazia mantido);
`tests/integration/vectorstore.test.ts` (`contentHash` no `samplePoint` + caso de `fetchDigests`);
`tests/integration/{recall,golden-rule}.test.ts` (`indexPassages({ recreate: true })` + mock de
`classify.ts` com identidade); `tests/{graph,trace,writer}.test.ts` (`contentHash` nos payloads de
amostra, só para o typecheck); `README.md`; `docs/learning/README.md`; `docs/architecture.md`.

**Nada foi apagado.**

### Decisões tomadas dentro do espaço que a spec deixou em aberto

- **Mensagem de erro do `insertPoints` cita quantos points já entraram**, conforme a tabela da
  seção 9 ("lança, com quantos points já entraram na mensagem") — o texto corrido da seção 7 não
  repetia esse detalhe ao descrever o passo 10, só a tabela da seção 9 o especifica. Implementado
  como `insertPoints failed after N point(s) were already written — <erro original>`, com a
  exceção original em `cause`.
- **Recomputa `pointIdFromPassageId(passage.id)` na hora de montar o `Point[]`** em vez de
  reaproveitar o array `pointIds` calculado no passo 3 por índice do array original — porque
  `toIndex` é um subconjunto filtrado (`new` + `changed`) com índices diferentes do array
  `passages` completo, e recalcular (sha1 de 12 caracteres) é mais simples e mais barato que
  carregar um `Map<passageId, pointId>` só para essa etapa. Determinístico por construção, então
  não há risco de divergência entre as duas chamadas.
- **Ordem de log/erro nos dois guards de colisão** (intra-lote e contra o já indexado): as duas
  mensagens citam explicitamente os dois `passageId` envolvidos, como a seção 3 pede, mas o texto
  exato (`point id collision between passages "X" and "Y"` / `... between indexed passage "X" and
  new passage "Y"`) é meu, já que a spec não fixa a string literal.
- **CLI (`index-passages.ts`): a linha "N to index (full rebuild)" substitui, e não some, a linha
  "N new, M changed, K unchanged" no modo `recreate`** — os dois exemplos literais da seção 8
  mostram isso (o exemplo `--recreate` não tem a linha `new/changed/unchanged`). Implementado como
  branch condicional na função de impressão: uma linha ou outra, nunca as duas.
- **A contagem de fallback no CLI é sempre impressa**, inclusive `(0 fallbacks)`, seguindo
  literalmente o exemplo `--recreate` da seção 8 (que mostra `(0 fallbacks)` mesmo sem nenhuma
  falha) — diferente do meu primeiro rascunho, que só imprimia a contagem quando `> 0`. Corrigido
  ao reler os dois exemplos lado a lado.
- **`tests/ingestion/indexer.test.ts`, caso de colisão de `pointIdFromPassageId`**: em vez de
  `vi.doMock`/`vi.resetModules` dentro do teste (frágil, sujeita a efeito colateral nos testes
  seguintes do mesmo arquivo), `point-id.ts` inteiro entrou na lista de módulos mockados no topo
  do arquivo (`vi.mock`), com a implementação real reobtida via `vi.importActual` e usada como
  padrão em todos os outros testes (`mockPointIdFromPassageId.mockImplementation(actualPointId.
  pointIdFromPassageId)` no `beforeEach`). Só o teste de colisão sobrescreve o mock para devolver
  uma constante. Resultado equivalente ao que a seção 12 descreve ("módulo point-id.ts mockado
  para devolver constante"), sem os riscos de reset de módulo em runtime.
- **Teste de integração, passo 3 (texto alterado)**: em vez de gastar uma terceira chamada de
  embedding só para verificar via `search()` que o texto do point mudou, o teste captura o vetor
  já gerado pela própria chamada de indexação (via `vi.spyOn` sobre `embedAll`, com implementação
  real por trás — a spy intercepta sem substituir o comportamento) e usa esse vetor como query de
  `search()`. Resultado: a mesma asserção que a spec pede ("o `search()` daquele point devolve o
  texto novo"), dentro do orçamento de "2 chamadas de embedding no total" que a própria seção 12
  define para o arquivo.

### Onde a implementação não seguiu a spec ao pé da letra, e por quê

Nenhum desvio de comportamento. Os pontos acima são preenchimento de lacuna (a spec não fixa
string de erro literal nem decide entre duas formas equivalentes de escrever um teste), não
reinterpretação de contrato.

### Achado real de infraestrutura: o feed real excede o limite de tokens/minuto da Voyage em modo `recreate`

Ao rodar `npm run index` de verdade contra a coleção `camisa10` (não a de teste), a chamada a
`embedAll` falhou consistentemente com `429` e a mensagem de rate limit da Voyage — mesmo depois
de esperar até 4 minutos entre tentativas. Investigado (não é código quebrado nem timing): o feed
real tem hoje 35 passages, com ~73.900 caracteres de título+texto somados — **~18.500 tokens
estimados** (`chars/4`) numa única requisição. O tier gratuito da Voyage sem cartão cadastrado
tem **10.000 TPM** (tokens por minuto), então uma única chamada de ~18.500 tokens excede o teto
sozinha — esperar não ajuda, porque o problema não é "muitas chamadas numa janela", é **uma
chamada maior que a janela inteira**. Confirmado isolando a causa: uma chamada de `embedAll` com
8 passages reais (bem abaixo do teto) teve sucesso imediato, logo depois de quatro tentativas
reais consecutivas com os 35 passages falharem.

Isso **não é um bug desta implementação**: `embedAll` manda o lote inteiro numa única requisição
desde a tarefa 00, e a seção 13 desta spec (fora de escopo) proíbe explicitamente mudar isso
("Lotear as chamadas à Voyage... o feed traz dezenas de itens, não milhares" — a suposição de que
"dezenas de itens" caberia com folga se provou errada só quando medida contra o texto real, não
contra uma estimativa). Segui a regra "se a spec estiver impossível, pare e reporte — não
conserte por conta própria": **não** modifiquei `embedAll` nem `indexer.ts` para lotear as
chamadas à Voyage, porque isso reabriria uma decisão de escopo que a spec fechou explicitamente.

O que isso significa na prática, hoje:

- `npm run index -- --recreate` contra o feed real atual **não completa** no tier gratuito da
  Voyage sem cartão — falha em `embedAll`, antes de `ensureCollection({ recreate: true })` (passo
  8), então **a coleção real não foi tocada**: confirmado com `curl` contra o Qdrant antes e
  depois de cada tentativa, `points_count` permaneceu em 14 (o estado anterior a esta tarefa) em
  todas as tentativas.
- `npm run index` incremental contra a coleção real também não completa por este exato motivo, e
  pelo mesmo motivo qualquer execução real inicial (tudo "new") tende a bater no mesmo teto,
  porque o volume de texto novo de uma primeira convergência é comparável ao de um `--recreate`.
  Uma vez que a coleção estivesse convergida (poucos passages `new`/`changed` por execução), o
  volume por chamada cairia bastante e o problema tende a desaparecer sozinho — mas não há como
  chegar a esse estado sem que a primeira convergência complete.
- Isso é **independente** desta tarefa: o mesmo teto já bloquearia o `indexPassages()` de hoje
  (pré-tarefa 02, sempre `recreate`) contra o feed atual de 35 itens. Não é uma regressão
  introduzida aqui — é a primeira vez que alguém tentou rodar `npm run index` contra o feed real
  de verdade neste tamanho (a tarefa 01 não chegou a confirmar isso rodando: ver a nota da tarefa
  01 sobre `npm run index` nunca ter sido executado).

**Decisão que não é minha**: destravar isso exige ou (a) o usuário cadastrar um cartão na Voyage
(o aviso da própria API diz que o limite sobe "depois de alguns minutos" após isso, e os 200M
tokens grátis da série 3 continuam valendo — não é cobrança automática, é só a remoção do teto
reduzido), ou (b) reabrir a decisão de lotear `embedAll` numa tarefa própria (fora do escopo
aprovado aqui). Não fiz nenhuma das duas.

### O que foi visto e não foi feito, por estar fora de escopo

Nada além do que a seção 13 já lista. Não toquei em `tagTeams`, `matchId`, chunking, cache de
`getFacts`, `--dry-run`, `tsconfig.json`, nem lotear `embedAll` (ver achado acima — visto, não
corrigido, por decisão explícita de escopo).

## Revisão
_A preencher._

## Testes

- **Unidade** (`npm test` = `tsc --noEmit && vitest run`, sem rede/Docker): **113 testes, 16
  arquivos, todos passando** (eram 86 depois da tarefa 01; a diferença são
  `tests/vectorstore/point-id.test.ts`, `tests/ingestion/{content-hash,classify}.test.ts` e os
  casos novos de `tests/ingestion/indexer.test.ts`).
- **Integração — vectorstore** (`tests/integration/vectorstore.test.ts`, Qdrant real):
  **4/4 passando**, incluindo o caso novo de `fetchDigests` (2 points inseridos, consultados por 3
  ids incluindo um inexistente — devolve os 2 digests certos, omite o ausente).
- **Integração — a prova da tarefa** (`tests/integration/ingestion-incremental.test.ts`, Qdrant e
  Voyage reais, `classify.ts` mockado com identidade): **1/1 passando**. Sequência confirmada
  contra uma coleção própria (`camisa10-ingestion-test`, 14 passages do fixture): `recreate` →
  `points: 14`, `countPoints() === 14`; segunda execução sem opções → `unchanged: 14, points: 0`,
  **zero chamadas de embedding** (`vi.spyOn` sobre `embedAll`); terceira execução com o texto de
  um passage alterado → `changed: 1, points: 1`, `countPoints()` continua 14 (atualizou, não
  duplicou), e `search()` pelo vetor daquela indexação devolve o texto novo.
- **Integração — recall@5** (`tests/integration/recall.test.ts`, Qdrant e Voyage reais,
  `beforeAll` chamando `indexPassages({ recreate: true })` + `classify.ts` mockado com
  identidade): **2/2 passando**, `recall@5 = 0.929` — **idêntico** ao número da tarefa 01,
  confirmando que trocar `indexPassages()` sem opções por `indexPassages({ recreate: true })` e
  mockar a classificação não mudou retrieval. O único miss continua sendo `e01` (o caso
  adversarial do apelido "alviverde" sem o nome do time, já registrado nas tarefas 00/01).
- **Integração — regra de ouro** (`tests/integration/golden-rule.test.ts`, sem `LLM_CASSETTE`):
  **passou, 3/3 execuções reais** (85s de execução, incluindo as duas pausas de 20s já
  documentadas na tarefa 01). Levou 6 tentativas reais até fechar limpo: 2 batidas em "invalid
  setup" (variância conhecida do score do p07 perto do corte do `k=5`, documentada na tarefa 00) e
  3 em `529 overloaded_error` da própria API da Anthropic (instabilidade transitória do lado
  deles, sem relação com o código desta tarefa — confirmado pelo `request_id` de cada erro sendo
  distinto e pela mensagem `"Overloaded"` genérica).
- **`LLM_CASSETTE=replay`** sobre `recall.test.ts` + `golden-rule.test.ts` + `vectorstore.test.ts`:
  **7/7 passando**, sem regravar `tests/integration/__cassettes__/llm-calls.json` — confirma a
  afirmação da seção 12 de que os prompts de `extractEntity`/`planner`/`writer` não mudaram nesta
  tarefa. `tests/integration/ingestion-incremental.test.ts` **não** está coberto pelo cassette (é
  arquivo novo, chama a Voyage de verdade sempre) — rodar a suíte inteira sob
  `LLM_CASSETTE=replay` falha nesse arquivo especificamente, com um erro claro de "sem gravação
  para esta requisição", não um erro silencioso; isso é esperado e não corrigido, por não estar
  no pedido de regravação de cassette desta tarefa.
- **`npm run index` contra a coleção real `camisa10`**: **bloqueado por um teto de infraestrutura
  real da Voyage** (10.000 tokens/minuto no tier gratuito sem cartão vs. ~18.500 tokens estimados
  para os 35 passages do feed real hoje, numa única requisição não loteada por desenho — spec §13,
  fora de escopo). Ver a seção "Achado real de infraestrutura" acima para os números e a
  investigação. A coleção real (`camisa10`, 14 points herdados de antes desta tarefa) não foi
  tocada por nenhuma tentativa — confirmado via `curl` no Qdrant antes/depois. O comportamento sob
  esse teto está correto (falha antes de gastar `ensureCollection`/`insertPoints`, exatamente como
  a tabela de erro da seção 9 pede), só não pôde ser demonstrado de ponta a ponta contra o volume
  real atual do feed.
