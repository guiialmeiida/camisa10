# Tarefa 03: Índice vetorial

Corresponde ao nó "Índice vetorial" do diagrama em `docs/architecture.md`. Depende da tarefa 02:
**substitui o chunking ingênuo e o schema mínimo da fatia vertical pelos definitivos.**

## Status
- [x] Discovery
- [x] Refinamento técnico  ← spec aprovada pelo usuário em 2026-09-11, ver nota no início da seção
- [x] Implementação
- [ ] Revisão
- [x] Testes

## Discovery

Concluído no grilling de 2026-09-11. Das perguntas originais, só "estratégia de chunking" e o
metadado `status` continuavam de verdade em aberto — o resto do schema (`competition`,
`matchweek`, `teams`, `publishedAt`, `type`) já foi resolvido nas tarefas 01/02 e não é reaberto
aqui.

Um fato levantado antes de perguntar, que mudou a decisão: os textos reais da Gazeta Esportiva
**não são curtos** — mediana de 2.007 caracteres, máximo de 8.222 (medido contra as 36 notícias
indexadas hoje). E um fato técnico: `stripHtml` (tarefa 01) já colapsa toda quebra de parágrafo
num espaço só, então chunking por parágrafo exigiria reabrir esse código.

1. **Chunking: tamanho fixo de caracteres com overlap**, respeitando fronteira de palavra (nunca
   corta no meio). Ponto de partida: ~800-1.000 caracteres por chunk, ~15-20% de overlap — dá
   ~2-3 chunks pro passage mediano, ~8-10 pro mais longo medido hoje. O tamanho exato é ajustável
   via `recall@k` depois de medido (item 2). Descartado chunking por parágrafo (exigiria mexer em
   `stripHtml`, já shippado) e por sentença (parser de fim de sentença em português é uma
   superfície de erro nova, sem ganho claro sobre tamanho fixo).

2. **Avaliação de chunking: conjunto separado e não-obrigatório, contra snapshot do índice real,
   rodado manualmente — não entra no `npm test`/CI.** O `recall@k` do fixture (tarefa 00) não
   exercita chunking nenhum, porque o fixture continua sendo um passage por chunk (decisão da
   tarefa 01/02, não reaberta) — ele mede regressão de pipeline de retrieval, não qualidade de
   chunking. Reabrir o fixture pra incluir um passage que precise de chunking foi descartado:
   arrisca a armadilha da regra de ouro que o fixture foi desenhado com cuidado pra manter.
   Escopo desta tarefa: essa avaliação separada não precisa de harness automatizado nem de gate
   de CI — é uma ferramenta de inspeção ocasional, não um portão de qualidade.

3. **`status` do jogo (finished/live/scheduled/postponed) não entra no payload.** Bakear um
   estado que muda no tempo dentro de um metadado estático do índice vetorial vai contra o
   espírito da regra de ouro (fato variável deveria vir de `getFacts`, sempre fresco, não
   congelado até o próximo reindex) — e não há caso de uso concreto ainda que `matchId` +
   `matchweek` não resolvam. Se as tarefas 04/05 encontrarem necessidade real de filtrar busca
   por status, essa decisão volta lá, com o caso de uso na mão.

**Consequência técnica que não é decisão do usuário, mas precisa ser resolvida no refinamento**:
chunking quebra a premissa "um passage = um point" que a tarefa 02 assumiu. `pointIdFromPassageId`
precisa virar algo como `pointIdFromChunk(passageId, chunkIndex)`, e o dedup por `contentHash` da
tarefa 02 precisa lidar com o caso de um texto editado produzir **menos** chunks que antes (chunks
órfãos do point antigo). Registrado aqui como contexto para o `refinador`, não decidido.

Decidido no grilling de 2026-09-08 (não reaberto):

- **Embedding**: `voyage-3.5` (trocado do `text-embedding-3-small`/OpenAI original na tarefa 00 —
  ver `docs/tasks/00-vertical-slice.md` § Implementação). A dimensão do vetor é fixada na
  criação da coleção do Qdrant — trocar depois obriga a reindexar tudo.
- **Qdrant**: real desde a tarefa 00.

## Refinamento técnico

> **Spec aprovada pelo usuário em 2026-09-11.** Os 3 pontos em aberto da seção 17 foram
> decididos, seguindo a recomendação dada na aprovação:
>
> 1. **`CHUNK_SIZE = 900`, `CHUNK_OVERLAP = 150`**, como a spec propunha — meio da faixa que o
>    discovery já tinha aprovado, sem intuição forte de que devesse ser diferente. Ajuste fino
>    fica pra depois de medir com a ferramenta da seção 11.
> 2. **`contentHash` passa a cobrir os chunks**, como a spec propunha — consistente com o padrão
>    já estabelecido nas tarefas 00 e 02 de falhar alto (reindexar sozinho ao trocar o parâmetro
>    de chunking) em vez de vazar em silêncio (índice ficar com chunking velho sem sinal).
> 3. **`chunkCount` entra no payload**, como a spec propunha — serve o trace como artefato de
>    aprendizado (`CLAUDE.md`), custo de um inteiro por point.

Spec fechada em 2026-09-11 a partir do discovery acima. Nada aqui reabre decisão do discovery. A
"consequência técnica" que o discovery registrou sem decidir (um passage deixa de ser um point) é
resolvida nas seções 3 a 8.

### 0. O que esta tarefa é, em uma frase

O texto de um passage deixa de entrar inteiro no índice e passa a ser cortado em pedaços de
tamanho fixo com sobreposição; o point do Qdrant passa a ser **um chunk**, não um passage; e o
pipeline incremental da tarefa 02 aprende a convergir quando o número de chunks de um passage
muda — inclusive limpando os chunks que sobraram da versão anterior.

### 1. O que continua exatamente igual

- **A fronteira `src/sources/` não muda em nada.** `stripHtml`, `parseFeed`, `listPassages`,
  `tagTeams`, `getFacts` — nenhum arquivo tocado. Confirmado no código: `stripHtml`
  (`src/sources/rss.ts`, linha 44) faz `.replace(/\s+/g, " ")`, ou seja, **colapsa quebra de
  parágrafo num espaço só** — o discovery estava certo, e é por isso que chunking por parágrafo
  exigiria reabrir aquele arquivo. Não reabrimos.
- **O que entra no índice continua sendo exatamente o mesmo texto.** Chunking decide *onde
  cortar*, não *o que indexar*. Nenhuma fonte nova, nenhum campo novo vindo de `getFacts`.
- **`contentHash` continua sendo a única chave de "mudou?"**, e o id de point continua
  determinístico. A idempotência sem transação da tarefa 02 é preservada — ver seção 8.4.
- **`search()`, `searchContext()` e `src/retrieval/` não mudam.** O lado da pergunta continua
  recebendo `SearchResult[]`; o que muda é que cada resultado agora é um chunk (ver seção 16 para
  a consequência que fica para as tarefas 04/05).
- **O fixture (`tests/fixtures/`) não muda**, e nenhum passage dele é reescrito para exercitar
  chunking (discovery, item 2 — mexer nele arrisca a armadilha da regra de ouro). O passage mais
  longo do fixture tem ~230 caracteres; com o tamanho default desta spec, **todo passage do
  fixture produz exatamente um chunk**, e o índice de avaliação fica byte a byte equivalente ao de
  hoje, fora os dois campos novos de payload. Isso é um invariante testado (seção 15).
- **`recall@5` não pode mudar**: continua `>= 0.8`, com a linha de base **0.929** das tarefas
  01/02. Se o número mexer nesta tarefa, é regressão, não ajuste de chunking.
- **`status` do jogo continua fora do payload** (discovery, item 3).
- **Embedding continua `voyage-3.5`**, dimensão inalterada (discovery, decisão de 2026-09-08).

### 2. O modelo mental: por que cortar, e o que cortar quebra

Um embedding é um vetor só para o texto inteiro que você mandou. Quanto mais assunto cabe num
texto, mais o vetor vira a média de tudo e menos ele se parece com a pergunta específica de
alguém. Uma notícia de 2.000 caracteres da Gazeta fala do jogo, da lesão, da tabela e da próxima
rodada no mesmo vetor: a pergunta "o zagueiro se machucou?" compete com todo o resto do texto.
Cortar em pedaços dá um vetor por assunto e, de quebra, entrega ao redator um trecho curto em vez
de uma matéria inteira.

O preço é que a premissa mais barata da tarefa 02 — **um passage = um point** — deixa de valer. Ela
estava em três lugares:

1. `pointIdFromPassageId(passageId)`: um id por passage. Agora são N ids por passage.
2. O diff `new`/`changed`/`unchanged`: hoje pergunta "este point existe e bate?". Agora precisa
   perguntar "**todos** os N chunks deste passage existem e batem?".
3. A escrita: o `upsert` por id estável cobria 100% do que o passage produzia. Agora, se o texto
   editado produzir **menos** chunks que antes, os chunks do fim ficam órfãos no Qdrant — points
   que ninguém mais escreve, ninguém mais compara, e que a busca continua devolvendo com o texto
   velho. É o problema que esta tarefa precisa resolver de verdade; o resto é aritmética.

### 3. O algoritmo de chunking — `src/ingestion/chunk.ts` (novo)

Função **pura**, sem rede, sem estado, testável sozinha.

```ts
export interface ChunkOptions {
  /** Maximum characters per chunk. Default CHUNK_SIZE. */
  size?: number | undefined;
  /** How many characters the next chunk goes back into the previous one. Default CHUNK_OVERLAP. */
  overlap?: number | undefined;
}

/** ~2-3 chunks for the median Gazeta article (2.007 chars), ~9 for the longest measured. */
export const CHUNK_SIZE = 900;

/** ~17% of CHUNK_SIZE — enough to carry a sentence across the cut. */
export const CHUNK_OVERLAP = 150;

/**
 * Splits a passage text into overlapping fixed-size chunks, never cutting inside a word.
 * Pure and deterministic: same input, same output, always.
 */
export function chunkText(text: string, options?: ChunkOptions): string[];
```

#### As regras, em ordem

1. O texto de entrada é `trim()`ado antes de qualquer coisa. Texto vazio ou só espaço em branco
   **lança** `Error("chunkText: empty text")` — um passage com zero chunks quebraria o invariante
   "todo passage tem pelo menos o chunk 0", do qual o diff da seção 8 depende.
2. **Se o texto couber em `size`, o resultado é `[text]`** — um chunk, idêntico à entrada. É o caso
   de todo passage do fixture, e é o que preserva o `recall@5` de hoje.
3. Senão, o corte é guloso da esquerda para a direita. Para uma janela que começa em `start`:
   - o fim duro é `start + size`;
   - o fim real é o **último espaço em branco** dentro da janela, de modo que o chunk nunca termine
     no meio de uma palavra;
   - **se não houver nenhum espaço em branco na janela** (uma URL de 900 caracteres, por exemplo),
     corta no fim duro. Não há fronteira de palavra disponível, e travar é pior que cortar.
4. O próximo `start` é `fimReal - overlap`, **avançado para o começo da próxima palavra** (o
   primeiro caractere depois do espaço em branco seguinte), para que nenhum chunk *comece* no meio
   de uma palavra. Se esse avanço passar de `fimReal`, o próximo `start` é `fimReal` — sobreposição
   vira zero antes de o algoritmo abrir um buraco no texto.
5. Cada chunk é `trim()`ado antes de entrar no resultado.
6. Validação das opções, antes de tudo: `size` inteiro `>= 1`, `overlap` inteiro `>= 0` e
   `< size`. Fora disso, **lança** (`chunkText: overlap (900) must be smaller than size (900)`).
   `overlap >= size` não é um parâmetro ruim, é um laço infinito.

#### Os invariantes que a implementação precisa garantir (e que os testes checam)

- **Progresso**: `start` cresce estritamente a cada iteração. Nenhuma entrada produz laço infinito.
- **Cobertura**: todo caractere do texto de entrada aparece em pelo menos um chunk. Chunking que
  perde texto é pior que chunking ruim, porque o texto perdido some em silêncio.
- **Ordem**: os chunks estão na ordem do texto original.
- **Tamanho**: `chunk.length <= size` para todo chunk.
- **Fronteira de palavra**: nenhum chunk começa ou termina no meio de uma palavra, exceto no caso
  degenerado da regra 3 (nenhum espaço em branco na janela inteira).
- **Nunca vazio**: o resultado tem pelo menos um elemento, e nenhum elemento é string vazia.
- **Sem chunk-cotoco**: não existe "último chunk de 20 caracteres". Isso sai de graça da regra 4 —
  o último chunk sempre começa `overlap` caracteres **dentro** do chunk anterior, então tem pelo
  menos ~`overlap` caracteres (menos o comprimento de uma palavra, pelo avanço da regra 4). Não é
  preciso nenhum parâmetro `minChunkSize` para isso, e é por isso que a spec não tem um.

#### Por que 900/150, e não outro número

O discovery fixou a faixa (~800-1.000 caracteres, ~15-20% de sobreposição) e disse que o valor
exato é ajustável depois de medido. 900 é o meio da faixa e 150 é 16,7% dela. Contra o corpus
medido no discovery, isso dá 1 chunk para o passage curto, ~3 para o mediano (2.007 caracteres) e
~11 para o mais longo (8.222). A ferramenta de ajuste é a seção 11; a consequência de mudar o
número depois está na seção 5 (muda o `contentHash`, logo a próxima execução reindexa tudo — de
propósito).

### 4. Id de point por chunk — `src/vectorstore/point-id.ts` (alterado)

`pointIdFromPassageId` **é substituída**, não acrescentada:

```ts
/**
 * Deterministic Qdrant point id for one chunk of a passage. Same 48-bit sha1 truncation as
 * before (Qdrant only takes an unsigned integer or a UUID as a point id), now over
 * `${passageId}#${chunkIndex}` — so every chunk of a passage gets its own stable id, and the
 * id of chunk i can be recomputed without knowing how many chunks the passage has.
 */
export function pointIdFromChunk(passageId: string, chunkIndex: number): number;
```

- **Entrada**: `passageId` não vazio (vazio → lança `pointIdFromChunk: empty passage id`);
  `chunkIndex` inteiro `>= 0` (fora disso → lança
  `pointIdFromChunk: invalid chunk index ${chunkIndex}`).
- **Saída**: inteiro `>= 0`, `< 2^48`, sempre `Number.isSafeInteger` — igual a hoje.
- **Determinismo**: mesma entrada, mesma saída, entre execuções e entre máquinas.
- Implementação: o mesmo `sha1(...).digest("hex").slice(0, 12)` de hoje, sobre
  `${passageId}#${chunkIndex}`.

**Por que hashear a string concatenada, e não empacotar bits** (por exemplo `hash40(passageId) *
256 + chunkIndex`): empacotar limitaria o número de chunks por passage a um teto arbitrário e
transformaria "passage com mais de 256 chunks" num bug silencioso de sobrescrita. Hashear a
concatenação não tem teto, e o risco que ela adiciona (colisão) já tem guarda desde a tarefa 02 —
que esta tarefa mantém, agora sobre o par `(passageId, chunkIndex)`.

**Por que a função antiga não sobrevive ao lado da nova:** dois esquemas de id para a mesma coleção
é o começo de um índice com metade dos points inalcançáveis. Além disso, o payload muda nesta
tarefa (seção 6), então **um `npm run index -- --recreate` já é obrigatório depois do merge de
qualquer jeito** — não há nada a preservar.

### 5. `contentHash` passa a cobrir os chunks — `src/ingestion/content-hash.ts` (alterado)

```ts
export interface HashedContent {
  title: string;
  /** The chunks exactly as they will be indexed — chunkText's output. */
  chunks: string[];
}

/**
 * Fingerprint of what was actually indexed for a passage: the title plus the chunk texts.
 * Covering the chunks (and not the raw text) means that changing CHUNK_SIZE/CHUNK_OVERLAP
 * changes every hash, so the next `npm run index` reindexes everything instead of silently
 * keeping the old chunking. Still deliberately does NOT cover `type`, `teams`, `matchweek`
 * or `competition` — same reasoning as task 02.
 */
export function contentHash(content: HashedContent): string;
```

- Saída: sha1 em hex, 40 caracteres minúsculos, de `${title}\n${chunks.join("\n")}`.
- `chunks` vazio → **lança** `contentHash: empty chunk list`.
- Sem normalização (trim, lowercase, colapso de espaço), igual à tarefa 02.

**Por que mudar a assinatura em vez de manter `(title, text)`.** Porque o discovery pede que o
tamanho do chunk seja ajustado depois, com medição. Se o hash cobrisse só o texto cru, editar
`CHUNK_SIZE` e rodar `npm run index` não faria **nada**: todos os hashes bateriam, todo passage
seria `unchanged`, e o índice ficaria com o chunking antigo sem nenhum sinal. O projeto já escolheu
"falhar alto em coleção desatualizada" em vez de vazar em silêncio (tarefas 00 e 02); esta é a mesma
escolha, só que barata: o parâmetro de chunking entra no fingerprint porque **ele determina o que
foi indexado**. O preço é explícito e aceito: mudar o parâmetro custa reembeddar o corpus inteiro.

### 6. O payload — `src/vectorstore/types.ts` (alterado)

```ts
export const passagePayloadSchema = z.strictObject({
  passageId: z.string().min(1),
  contentHash: z.string().length(40),
  chunkIndex: z.number().int().min(0),     // novo — posição deste chunk no passage, 0-based
  chunkCount: z.number().int().positive(), // novo — quantos chunks o passage produziu
  text: z.string().min(1),                 // agora é o texto DO CHUNK, não do passage inteiro
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

- **`passageId` continua sendo o id do passage, não do chunk.** É o que o redator cita
  (`[passageId]`), o que a avaliação compara e o que o trace imprime. Um chunk não é uma fonte
  citável; ele é um pedaço de uma.
- **`contentHash` é o mesmo nos N chunks de um passage** — é fingerprint do passage, não do chunk.
- **`text` é o texto do chunk.** O nome do campo não muda: ele sempre significou "o texto deste
  point", e renomear custaria tocar redator, trace e seis arquivos de teste para ganhar nada.
- Todo o resto do payload é do passage e se repete idêntico nos N chunks.
- **`chunkCount` não é usado pelo diff** (a seção 8 explica por que não precisa dele). Ele existe
  por dois motivos concretos: o trace imprime "chunk 2/5", que é o artefato de aprendizado desta
  tarefa (a pessoa **vê** que a busca devolveu um pedaço, não a matéria), e um point inspecionado
  sozinho com `curl` se descreve inteiro. Custa um inteiro por point.

Exemplo literal de um point (chunk 2 de um passage de 4 chunks):

```json
{
  "passageId": "9f2c41ab77de",
  "contentHash": "3d5a1f0b9c2e47a86f1d0b3c5e7a9d2f4b6c8e01",
  "chunkIndex": 1,
  "chunkCount": 4,
  "text": "o técnico admitiu que a equipe perdeu a confiança depois do intervalo e prometeu mudanças na escalação para o próximo compromisso, enquanto a diretoria evitou falar em demissão",
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

**Nenhum campo de placar entra aqui**, e o `z.strictObject` mantém isso como erro de parse.
`chunkIndex`, `chunkCount` e `matchweek` são os três inteiros do payload, e nenhum deles é citável
— ver seção 13.

`IndexedDigest` e o `digestPayloadSchema` de `fetchDigests` **não mudam**: o diff precisa saber
"este point existe e com que hash?", e isso continua sendo `passageId` + `contentHash`. O que muda
é quem chama: em vez de N ids de passage, o indexer manda os ids de todos os chunks.

### 7. Limpeza de chunk órfão — `deleteOrphanChunks()` em `src/vectorstore/qdrant.ts`

```ts
export interface OrphanSweep {
  passageId: string;
  /** How many chunks the passage produces *now*. Anything at a higher index is an orphan. */
  chunkCount: number;
}

/**
 * Deletes the points of a passage whose chunkIndex is >= its current chunk count — the
 * leftovers of a longer previous version of the same text. Returns how many points were
 * deleted. Counts first and skips the delete entirely when there is nothing to remove,
 * which is the common case.
 */
export async function deleteOrphanChunks(sweeps: OrphanSweep[]): Promise<number>;
```

- `sweeps` vazio → devolve `0` **sem nenhuma requisição**.
- Monta **um** filtro por lote, com uma cláusula `should` por passage:

```json
{
  "should": [
    {
      "must": [
        { "key": "passageId", "match": { "value": "9f2c41ab77de" } },
        { "key": "chunkIndex", "range": { "gte": 2 } }
      ]
    }
  ]
}
```

- Lotes de **64 sweeps** (`ORPHAN_SWEEP_BATCH_SIZE`), pelo mesmo motivo de `RETRIEVE_BATCH_SIZE` e
  `UPSERT_BATCH_SIZE`: um filtro com milhares de cláusulas é o que funciona no teste e falha em
  produção.
- Para cada lote: `count(collection, { filter, exact: true })`; se `0`, não chama `delete`. Se
  `> 0`, chama `delete(collection, { filter, wait: true })` e soma o `count` ao retorno.
- Erro de rede/Qdrant: **lança**, com a mesma formatação já usada no arquivo
  (`could not reach Qdrant at ${url}: ...`). Nunca devolve `0` por erro — `0` significa "não havia
  órfão", e engolir o erro deixaria lixo no índice sem sinal nenhum.
- **Por que contar antes**: o `delete` do Qdrant não devolve quantos points apagou, e "2 orphan
  chunks deleted" na saída da CLI é a única evidência visível de que a limpeza aconteceu. A conta
  extra custa uma requisição barata por execução e evita a requisição de `delete` no caso comum.

`ensureCollection`, `fetchDigests`, `insertPoints`, `search` e `countPoints` **não mudam**.

**Por que filtro em vez de apagar por id**: para apagar por id seria preciso saber quantos chunks a
versão anterior tinha — ou seja, confiar num `chunkCount` guardado que a própria escrita nova
sobrescreve. O filtro `chunkIndex >= M` não precisa saber nada sobre o passado: ele descreve o
estado desejado ("não existe chunk além do índice M-1"), o que é exatamente o que torna a operação
repetível sem efeito colateral.

### 8. O novo `indexPassages()` — `src/ingestion/indexer.ts` (alterado)

```ts
export interface IndexReport {
  collection: string;
  mode: "incremental" | "recreate";
  /** How many passages the source returned. */
  passages: number;
  /** How many chunks those passages produce in total — indexed or not. */
  chunks: number;
  /** Not in the collection yet. */
  newPassages: number;
  /** Already there, but incomplete or with a different contentHash. */
  changed: number;
  /** Skipped: every chunk present with the same contentHash. No embedding, no write. */
  unchanged: number;
  /** Chunk points upserted. */
  points: number;
  /** Leftover chunks of a previous, longer version of a passage, removed by the sweep. */
  orphanPointsDeleted: number;
  classificationFallbacks: number;
  /** Per PassageType, counted per *passage* indexed — sums to newPassages + changed. */
  typeCounts: Record<PassageType, number>;
}
```

`IndexOptions` não muda (`{ recreate?: boolean }`).

#### 8.1 A sequência, passo a passo

1. `const [passages, facts] = await Promise.all([listPassages(), getFacts({})])` — igual a hoje.
2. Guard de lista vazia, antes de tocar o Qdrant — igual a hoje (lança).
3. Guard de `passage.id` duplicado vindo da fonte — igual a hoje (lança).
4. **Chunking, uma vez só, para todo passage**: `chunks = chunkText(passage.text)`,
   `hash = contentHash({ title: passage.title, chunks })`,
   `pointIds[i] = pointIdFromChunk(passage.id, i)`. O total de chunks aqui é o campo `chunks` do
   relatório.
5. **Guarda de colisão intra-lote**, agora sobre o par: dois `(passageId, chunkIndex)` diferentes
   produzindo o mesmo point id → **lança**, citando os dois (`"9f2c41ab77de#3"` e `"a1b2c3d4e5f6#0"`).
6. **O diff**:
   - Modo `recreate`: `await ensureCollection()` (não destrutivo, só verificação de saúde barata
     antes de gastar dinheiro), `digests = []`, todo passage é `new`.
   - Modo incremental: `digests = await fetchDigests(<todos os point ids de chunk do passo 4>)`,
     virando um `Map<number, IndexedDigest>`. É também a verificação de saúde deste modo.
   - Para cada passage, com `M = chunks.length`:
     - algum digest presente com `digest.passageId !== passage.id` → **lança** (colisão entre
       execuções);
     - nenhum dos M ids tem digest → **`new`**;
     - alguns têm e outros não (`present < M`) → **`changed`** — é uma escrita parcial de uma
       execução anterior que morreu no meio, e reescrever o passage inteiro é o que retoma;
     - todos presentes, mas algum `digest.contentHash !== hash` → **`changed`**;
     - todos presentes e todos com o mesmo hash → **`unchanged`**, descartado do resto do pipeline.
7. `toIndex = [...new, ...changed]`. Se vazio: devolve o relatório com `points: 0`,
   `orphanPointsDeleted: 0`, **sem chamar embedding, LLM, upsert ou sweep**.
8. `classifications = await classifyPassageTypes(toIndex)` — uma classificação **por passage**, não
   por chunk. O `type` é gênero da matéria; classificar o mesmo texto N vezes seria pagar N vezes
   pela mesma resposta.
9. `vectors = await embedAll(<os chunks de todo passage de toIndex, achatados, na ordem>,
   "document")`. O loteamento por orçamento de tokens de `embedAll` (tarefa 02) continua valendo e
   não muda.
10. `ensureCollection({ recreate: true })` se `recreate`, senão `ensureCollection()`. A destruição
    continua acontecendo o mais tarde possível, depois de embedding e classificação terem dado
    certo.
11. **Sweep de órfãos, se e só se não for `recreate`**:
    `orphanPointsDeleted = await deleteOrphanChunks(toIndex.map((p) => ({ passageId: p.id,
    chunkCount: M(p) })))`. Em `recreate` a coleção acabou de nascer; não há o que varrer.
12. Monta os `Point[]` — um por chunk, com o payload da seção 6 — e chama `insertPoints` em lotes
    de 64 (`UPSERT_BATCH_SIZE`, inalterado), somando os retornos.
13. Devolve o `IndexReport`.

#### 8.2 A ordem entre o sweep e o upsert é a parte que importa

**O sweep (11) vem antes do upsert (12).** Não é detalhe de estilo; é o que preserva a propriedade
central da tarefa 02 (idempotente, retomável, sem transação):

- Se o processo morrer **entre** o sweep e o upsert, os chunks `0..M-1` que estão no índice ainda
  têm o `contentHash` **antigo** → a próxima execução vê `changed` → reindexa e varre de novo.
  Converge.
- Na ordem inversa (upsert primeiro), morrer no meio deixaria os chunks `0..M-1` já com o hash
  **novo** → a próxima execução veria `unchanged` → **os órfãos ficariam lá para sempre**, e
  nenhuma execução futura olharia para eles. Essa é exatamente a armadilha que a tarefa pediu para
  resolver, e é invisível se não se pensar na ordem.
- O sweep só apaga `chunkIndex >= M`, então durante a janela o passage nunca some do índice: ele
  fica, no pior caso, truncado na versão antiga.

#### 8.3 Exemplo literal de relatório

```json
{
  "collection": "camisa10",
  "mode": "incremental",
  "passages": 38,
  "chunks": 97,
  "newPassages": 4,
  "changed": 2,
  "unchanged": 32,
  "points": 17,
  "orphanPointsDeleted": 2,
  "classificationFallbacks": 1,
  "typeCounts": { "article": 3, "chronicle": 1, "matchReport": 2, "preview": 0 }
}
```

`typeCounts` soma `newPassages + changed` (6), **não** `points` (17) — a contagem é de passages
classificados, e é isso que a linha `classified:` da CLI sempre quis dizer. O comentário do campo
e o teste correspondente mudam junto.

#### 8.4 O que continua verdadeiro sobre idempotência

Rodar `npm run index` duas vezes seguidas continua dando o mesmo índice, e a segunda execução
continua custando zero. As três propriedades que sustentam isso seguem de pé: id de point
determinístico (agora por chunk), fingerprint guardado no próprio point, e nenhuma operação que
precise ser desfeita. O sweep entra nesse conjunto porque ele é declarativo ("não exista chunk
além de M-1") e não incremental ("apague dois points") — rodá-lo duas vezes dá o mesmo resultado
que rodá-lo uma.

### 9. A CLI — `src/cli/index-passages.ts` (alterado)

Sem flag nova. Só a saída muda, para mostrar chunking e a limpeza:

```
$ npm run index
collection camisa10 (incremental)
  38 passages from the source -> 97 chunks (900 chars, 150 overlap)
  4 new, 2 changed, 32 unchanged
  6 classified: 3 article, 2 matchReport, 1 chronicle  (1 fallback)
  17 points upserted, 2 orphan chunks deleted
```

```
$ npm run index
collection camisa10 (incremental)
  38 passages from the source -> 97 chunks (900 chars, 150 overlap)
  0 new, 0 changed, 38 unchanged
  nothing to do — no embeddings, no LLM calls, no writes
```

```
$ npm run index -- --recreate
collection camisa10 (recreate)
  36 passages from the source -> 94 chunks (900 chars, 150 overlap)
  36 to index (full rebuild)
  36 classified: 27 article, 4 matchReport, 1 chronicle, 4 preview  (0 fallbacks)
  94 points upserted
```

- A linha de chunking imprime os parâmetros importando `CHUNK_SIZE`/`CHUNK_OVERLAP` de
  `src/ingestion/chunk.ts` — quem mexeu no número vê o número que valeu naquela execução.
- A linha `classified:` passa a usar `newPassages + changed` no lugar de `points`.
- `, N orphan chunks deleted` aparece **sempre** no modo incremental, inclusive com `0`, pelo mesmo
  motivo que `(0 fallbacks)` aparece desde a tarefa 02: número que só aparece quando é diferente de
  zero é número que ninguém sabe se foi medido. No modo `recreate` a cláusula não existe.

### 10. O trace — `src/agent/trace.ts` (alterado)

Uma linha, no bloco `search_vector_context`: um resultado com `chunkCount > 1` passa a mostrar de
qual pedaço ele veio.

```
        #1  0.612  9f2c41ab77de  chunk 2/4  matchReport  "o técnico admitiu que a equipe perdeu…"
        #2  0.571  p03           article    "Foi a terceira derrota seguida do alviverde…"
```

- `chunkCount === 1` → nada é impresso (o passage não foi cortado; é o caso do fixture inteiro, e
  poluir a saída com `chunk 1/1` não ensina nada).
- `chunkCount > 1` → `chunk ${chunkIndex + 1}/${chunkCount}`, 1-based na impressão porque é texto
  para humano; o campo continua 0-based.
- O bloco `sources:` **não muda**: ele lista `passageId` citado, e citação é do passage.

### 11. Avaliação de chunking, separada e não-obrigatória — `tests/eval/chunking-report.ts` (novo)

Discovery, item 2: conjunto separado, contra o índice real, rodado à mão, **fora do `npm test` e
do CI**, sem harness e sem portão de qualidade. É uma ferramenta de inspeção.

```
npm run eval:chunking                                  # só a distribuição, com os parâmetros default
npm run eval:chunking -- --size=600 --overlap=100      # distribuição com outros parâmetros, offline
npm run eval:chunking -- "como o Palmeiras vem jogando?"  # distribuição + top-k contra o índice atual
```

Novo script no `package.json`: `"eval:chunking": "node tests/eval/chunking-report.ts"`. Mora em
`tests/eval/` ao lado de `recall.ts`, que também é módulo de avaliação e também não é arquivo de
teste — o `vitest` só coleta `tests/**/*.test.ts`, então ele **nunca** entra no `npm test`.

Duas seções no relatório:

1. **Distribuição** (chama `listPassages()`, sem embedding e sem Qdrant): quantos passages, quantos
   chunks, chunks por passage (mín/mediana/máx), comprimento de chunk (mín/mediana/máx), e quantos
   passages produzem um chunk só. Com `--size`/`--overlap` a conta é refeita localmente, sem tocar
   no índice — é assim que se compara "900/150 vs. 600/100" antes de pagar um reindex.
2. **Inspeção de recuperação** (só quando há pergunta): uma chamada de embedding, `search({ vector,
   k })` contra a coleção configurada, e uma linha por resultado com score, `passageId`,
   `chunk i/N`, `type` e os primeiros ~120 caracteres do chunk. `--k=8` ajusta o `k` (default 5).

Regras: **nunca escreve no índice**, não tem limiar, não tem "passou/falhou", sai com código 0 (ou
1 em erro). Se a coleção não existir, a mensagem já existente do `search()` (`run: npm run index`)
sobe como está.

**Por que não um arquivo de perguntas versionado**: o `tests/eval/questions.json` existe para o
fixture, cujos passages não estão no índice real, e inventar um segundo arquivo de perguntas com
schema, validação e curadoria é exatamente o harness que o discovery disse que não precisa. A
pergunta vem da linha de comando; se a inspeção virar rotina, um arquivo é uma tarefa de dez
minutos depois.

### 12. Tratamento de erro

| onde | situação | comportamento |
|---|---|---|
| `chunkText` | texto vazio ou só espaço | **lança** — passage sem chunk quebraria o diff |
| `chunkText` | `overlap >= size`, `size < 1`, valores não inteiros | **lança** na entrada, antes do laço |
| `chunkText` | janela inteira sem espaço em branco (URL gigante) | corta no fim duro, **não lança** — degradação previsível em vez de travar |
| `contentHash` | lista de chunks vazia | **lança** |
| `pointIdFromChunk` | `passageId` vazio, `chunkIndex` negativo ou não inteiro | **lança** |
| `indexPassages` | colisão de point id, intra-lote ou contra o indexado | **lança**, citando os dois `passageId#chunkIndex` |
| `fetchDigests` | qualquer situação | inalterado (tarefa 02, §9) |
| `deleteOrphanChunks` | Qdrant fora do ar / erro HTTP | **lança**. A execução morre antes do upsert; a próxima retoma porque os chunks no índice ainda têm o hash antigo |
| `deleteOrphanChunks` | não há órfão | `0`, sem chamar `delete`. Não é erro |
| `insertPoints` | um lote falha no meio | **lança** com quantos points entraram, como hoje. Sem rollback: a próxima execução vê o passage como `changed` (chunks faltando ou com hash antigo) e reescreve |
| `embedAll` | Voyage falha | **lança** — e no modo `recreate` a coleção ainda está intacta (passo 10) |
| `classifyPassageType` | LLM falha | inalterado: `"article"` + aviso, nunca derruba a ingestão |

A regra continua: ingestão é batch disparado à mão, então falhar alto e ser retomável é melhor que
produzir um índice parcial em silêncio. A única exceção segue sendo a classificação.

### 13. Regra de ouro: chunking mexe em onde corta, não no que entra

O que esta tarefa acrescenta ao caminho do dado é uma função pura de string e dois inteiros de
posição. Nenhuma fonte nova, nenhuma chamada nova, nenhum campo vindo de `getFacts`.

1. **O texto indexado é o mesmo.** `chunkText` só particiona: a união dos chunks é o texto do
   passage (invariante de cobertura, seção 3). Nada é resumido, reescrito ou sintetizado — não há
   LLM nenhum no caminho do chunking.
2. **Nenhum número novo entra no payload.** `chunkIndex` e `chunkCount` são posição, não fato de
   futebol, e o `z.strictObject` continua fazendo de um `score` esquecido um erro de parse.
3. **Eles não chegam ao redator.** `buildPrompt` renderiza `passageId`, `type`, `source`, `title` e
   `text` — e **não** renderiza `chunkIndex`/`chunkCount`. Isso é explícito na spec e testado: um
   "2/4" na seção `<context>` seria um número sem lastro na API dentro do prompt, do lado errado da
   assimetria que a tarefa 00 construiu. Quem imprime a posição do chunk é o trace, que não vai
   para LLM nenhum.
4. **O risco novo e real é o corte no meio de uma frase que cita número.** Um chunk terminado em
   "…venceu por dois a" é um fragmento que parece um placar amputado. Três contenções, nesta ordem:
   (a) a fronteira de palavra garante que o corte nunca parte um token — nenhum "3" vira "3" de
   "3-1"; (b) a sobreposição de 150 caracteres faz com que a frase cortada apareça **inteira** no
   chunk seguinte, então nenhuma informação existe só na forma mutilada; (c) a contenção que
   realmente importa continua sendo a de sempre — o prompt do redator proíbe copiar número do
   `<context>`, e o `golden-rule.test.ts` verifica isso de ponta a ponta.
5. **O fixture e a armadilha (`p07`) não mudam de forma**: 218 caracteres, um chunk só. O teste da
   regra de ouro continua exercitando exatamente o mesmo texto de hoje.

### 14. Arquivos a criar ou alterar

**Criar**
```
src/ingestion/chunk.ts                    chunkText + CHUNK_SIZE/CHUNK_OVERLAP + ChunkOptions
tests/ingestion/chunk.test.ts
tests/eval/chunking-report.ts             a avaliação manual da seção 11
docs/learning/04-chunking.md
```

**Alterar**
```
src/vectorstore/point-id.ts               pointIdFromPassageId -> pointIdFromChunk
src/vectorstore/types.ts                  chunkIndex + chunkCount no payload
src/vectorstore/qdrant.ts                 deleteOrphanChunks + OrphanSweep
src/ingestion/content-hash.ts             assinatura passa a receber { title, chunks }
src/ingestion/indexer.ts                  diff por chunk, sweep antes do upsert, IndexReport novo
src/cli/index-passages.ts                 linha de chunking, linha de órfãos, classified por passage
src/agent/trace.ts                        "chunk i/N" quando chunkCount > 1
package.json                              script eval:chunking
tests/vectorstore/point-id.test.ts        casos da seção 15
tests/vectorstore/qdrant-digests.test.ts  casos de deleteOrphanChunks (cliente mockado)
tests/ingestion/content-hash.test.ts      nova assinatura + o caso do split diferente
tests/ingestion/indexer.test.ts           casos da seção 15
tests/integration/vectorstore.test.ts     samplePoint + prova do filtro de sweep no Qdrant real
tests/integration/ingestion-incremental.test.ts   passos 4 e 5 (cresce e encolhe)
tests/{graph,trace,writer}.test.ts        chunkIndex/chunkCount nos payloads de amostra
README.md                                 o "rode --recreate uma vez" pós-merge; npm run eval:chunking
docs/learning/README.md                   linha nova no índice
docs/architecture.md                      glossário: chunk, overlap, chunk órfão
```

**Nada a apagar.**

`docs/learning/04-chunking.md` cobre o conceito: por que um vetor por documento longo dilui o
assunto, o que a sobreposição compra (a frase cortada existe inteira em algum lugar), por que
tamanho fixo em caracteres e não parágrafo/sentença (o motivo concreto: `stripHtml` já colapsou os
parágrafos, e parser de sentença em português é superfície de erro nova), e por que chunking
quebra "um passage = um point" e o que isso obriga no pipeline incremental. Termina no bloco
**"Por que não X?"**: por que não chunking semântico com LLM, por que não parágrafo, por que não
sentença, por que não empacotar `chunkIndex` nos bits do id, por que não apagar órfão por id, por
que não colocar o `chunkCount` no `contentHash`, e por que a avaliação de chunking não virou gate
de CI.

### 15. Casos de teste

Unidade (`npm test` = `tsc --noEmit && vitest run`, sem rede e sem Docker):

`tests/ingestion/chunk.test.ts` (novo)
- Texto menor que `size` → **exatamente um chunk**, igual ao texto (com `trim`).
- Texto de comprimento exatamente `size` → um chunk.
- Texto de ~2,5x `size` → 3 chunks, **todos com `length <= size`**.
- **Cobertura**: num texto construído como `w0 w1 … wN` (palavras numeradas), a união ordenada das
  palavras dos chunks é exatamente `w0…wN`, sem buraco e sem reordenação.
- **Fronteira de palavra**: a primeira e a última palavra de cada chunk são palavras completas do
  texto original.
- **Sobreposição**: chunks consecutivos compartilham pelo menos uma palavra, e a parte repetida não
  passa de `overlap` + o comprimento de uma palavra.
- **Sem chunk-cotoco**: para um texto de `size * 2 + 30` caracteres, o último chunk tem pelo menos
  `overlap` caracteres — a propriedade que dispensa um `minChunkSize`.
- **Palavra maior que a janela**: 2.000 caracteres sem nenhum espaço → termina (não trava), chunks
  de tamanho `size`, cobertura preservada.
- **Não parte token numérico**: num texto onde "3.500" cai exatamente na posição de corte, o token
  aparece inteiro em algum chunk e não aparece partido em nenhum — a regra de ouro virando teste de
  unidade do chunking.
- **Determinismo**: duas chamadas com a mesma entrada devolvem arrays iguais.
- Texto vazio / só espaço → lança. `overlap >= size` → lança. `size < 1` → lança. `overlap < 0` →
  lança.
- **Todo passage do fixture (`tests/fixtures/brasileirao-2026-matchweek-12.json`) produz exatamente
  um chunk** com os parâmetros default — o invariante que segura o `recall@5` em 0.929 e mantém a
  armadilha `p07` intacta. O teste lê o JSON do fixture, não uma cópia.

`tests/vectorstore/point-id.test.ts` (alterado)
- Mesma `(passageId, chunkIndex)` → mesmo id em duas chamadas.
- `chunkIndex` diferente do mesmo passage → ids diferentes.
- Mesmo `chunkIndex` de passages diferentes → ids diferentes.
- Os 14 ids do fixture × `chunkIndex` 0..4 (70 pares) → 70 ids distintos.
- `"p03"` (não hexadecimal) funciona; resultado é `Number.isSafeInteger`, `>= 0`, `< 2 ** 48`.
- `passageId` vazio lança; `chunkIndex` `-1`, `1.5` e `NaN` lançam.

`tests/ingestion/content-hash.test.ts` (alterado)
- Mesmo `{ title, chunks }` → mesmo hash, `/^[0-9a-f]{40}$/`.
- Título diferente com os mesmos chunks → hash diferente (mantido da tarefa 02).
- **Mesmo texto total, corte diferente → hash diferente**: `{ title: "a", chunks: ["bc"] }` e
  `{ title: "a", chunks: ["b", "c"] }` não colidem. É a decisão da seção 5 virando teste, e o que
  garante que mudar `CHUNK_SIZE` reindexa.
- `chunks: []` lança.

`tests/ingestion/indexer.test.ts` (alterado; sources, embed, qdrant, classify e chunk mockáveis)
- **(mantido)** Fonte com `[]` lança antes de `ensureCollection` e de `fetchDigests`.
- **(mantido)** `matchweek` vem de `facts.matchweek`; `matchId: null` passa pelo payload.
- Um passage que produz 3 chunks vira **3 points**, com ids `pointIdFromChunk(id, 0..2)`,
  `chunkIndex` 0/1/2, `chunkCount: 3` em todos, e `passageId`, `contentHash`, `title`, `teams`,
  `type`, `competition`, `matchweek` **idênticos** nos três; `text` de cada point é o chunk
  correspondente, na ordem.
- Relatório: `points` conta chunks upsertados; `chunks` conta o total produzido pela fonte;
  **`typeCounts` soma `newPassages + changed`**, não `points`.
- Incremental com tudo inalterado (todos os digests de chunk presentes e com o mesmo hash):
  `embedAll`, `classifyPassageTypes`, `insertPoints` e `deleteOrphanChunks` **não são chamados**;
  `points: 0`, `orphanPointsDeleted: 0`.
- **Escrita parcial**: um passage de 3 chunks com só 2 digests presentes (hash igual) →
  `changed: 1`, e os **3** chunks são reembeddados e reescritos. É a prova da retomada.
- **Passage que encolheu** (4 chunks indexados, 2 agora): `deleteOrphanChunks` é chamado com
  `[{ passageId, chunkCount: 2 }]` e **antes** de `insertPoints` (asserção de ordem entre os dois
  mocks — se alguém inverter, o teste falha); 2 points upsertados.
- **Passage que cresceu** (2 → 4 chunks): 4 points upsertados, sweep chamado com `chunkCount: 4`
  (não apaga nada).
- `recreate: true`: `fetchDigests` e `deleteOrphanChunks` **não** são chamados;
  `ensureCollection({ recreate: true })` é chamado.
- `recreate: true` com `embedAll` rejeitando: `ensureCollection({ recreate: true })` não chega a
  ser chamado — a coleção sobrevive.
- Colisão de point id (mock de `point-id.ts` devolvendo constante) → lança, com os dois
  `passageId#chunkIndex` na mensagem.
- Digest com `passageId` diferente do passage que mapeia para aquele id → lança.
- `orphanPointsDeleted` do relatório é exatamente o que `deleteOrphanChunks` devolveu.
- **Invariante da regra de ouro**: para todo point construído,
  `passagePayloadSchema.parse(payload)` passa e `Object.keys(payload)` é exatamente o conjunto de
  chaves do schema — nenhum campo de placar, nenhum campo a mais.

`tests/vectorstore/qdrant-digests.test.ts` (alterado, cliente mockado)
- `deleteOrphanChunks([])` → `0`, **sem nenhuma requisição**.
- `count` devolvendo 0 → `delete` **não** é chamado; retorno `0`.
- `count` devolvendo 3 → `delete` chamado com o **mesmo filtro** do `count`; retorno `3`.
- Forma do filtro: uma cláusula `should` por sweep, cada uma com `must` de
  `{ key: "passageId", match: { value } }` + `{ key: "chunkIndex", range: { gte } }`.
- 70 sweeps → 2 lotes (64 + 6).
- Erro de rede → **lança** com `could not reach Qdrant at ...`, nunca devolve `0`.

`tests/trace.test.ts` (alterado)
- Resultado com `chunkCount: 1` → a linha **não** contém "chunk".
- Resultado com `chunkIndex: 1, chunkCount: 4` → a linha contém `chunk 2/4`.

`tests/writer.test.ts` (alterado)
- Payloads de amostra ganham os dois campos (typecheck), e um caso novo: **`buildPrompt` não
  contém `chunkIndex` nem `chunkCount`** em lugar nenhum do `user` — a contenção 3 da seção 13
  virando teste.

Integração (`npm run test:integration`, Qdrant real):

`tests/integration/vectorstore.test.ts` (alterado)
- `samplePoint` ganha `chunkIndex: 0, chunkCount: 1`.
- Caso novo, **a prova de que o filtro do sweep funciona no Qdrant de verdade** (filtro aninhado
  `should`/`must` com `range` é o tipo de coisa que passa no mock e falha no servidor): insere 3
  points do mesmo `passageId` com `chunkIndex` 0/1/2, chama
  `deleteOrphanChunks([{ passageId, chunkCount: 1 }])` → devolve `2`, `countPoints()` cai 2, e o
  point que sobrou é o de `chunkIndex: 0`.

`tests/integration/ingestion-incremental.test.ts` (alterado) — continua sendo o teste que prova a
tarefa. Os passos 1-3 de hoje continuam valendo com os mesmos números (o fixture dá 14 passages de
um chunk → 14 points). Dois passos novos:
4. O dublê passa a devolver, para `p03`, um texto longo o bastante para produzir **3 chunks** →
   `changed: 1`, `points: 3`, `orphanPointsDeleted: 0`, `countPoints() === 16`, e uma busca pelo
   vetor daquela indexação devolve um point com `chunkCount: 3`.
5. O dublê volta `p03` para um texto curto (1 chunk) → `changed: 1`, `points: 1`,
   **`orphanPointsDeleted: 2`**, `countPoints() === 14` de novo. É a prova do órfão limpo, e é o
   caso que o discovery apontou como consequência não resolvida.
   - Atenção operacional: cada execução dessas gasta uma chamada de embedding, e o tier gratuito da
     Voyage é de 3 requisições/minuto (tarefa 02). Os passos 4 e 5 são precedidos de uma pausa de
     21s, no mesmo padrão já usado em `golden-rule.test.ts`, e o timeout do `it` sobe para 180s.

`tests/integration/recall.test.ts` (não muda o código)
- **`recall@5` continua `0.929`.** Não é "acima do limiar": é o mesmo número. O fixture inteiro é
  de um chunk por passage, então qualquer variação aqui significa que chunking mexeu em algo que
  não deveria ter mexido.

`tests/integration/golden-rule.test.ts` (não muda o código)
- Continua 3/3. `measureRecall` **não muda**: ela continua comparando `payload.passageId`, e o
  fixture não produz dois chunks do mesmo passage, então não há caso de id repetido no top-k aqui.
- **Cassettes**: nenhum prompt de LLM muda nesta tarefa (o classificador não muda, o redator não
  recebe campo novo), então `tests/integration/__cassettes__/llm-calls.json` não precisa ser
  regravado. Se a implementação descobrir o contrário, regravar com o cuidado documentado na
  tarefa 01.

### 16. Fora de escopo desta tarefa

- **Deduplicar chunks do mesmo passage no top-k.** A partir desta tarefa, dois chunks de uma mesma
  notícia podem ocupar duas das `k` posições da busca. Isso é real e vai importar — mas mexer nisso
  é mexer em `src/retrieval/`, que é o objeto das **tarefas 04/05** (a fórmula
  `similarity x weight x timeDecay` e os filtros vivem lá). Aqui fica registrado o fato e o campo
  que a solução vai usar (`chunkIndex`/`chunkCount` no payload), não a solução.
- **Prefixar o título ao texto de cada chunk antes de embeddar** ("chunking contextual"). É uma
  técnica conhecida e provavelmente boa, mas muda *o que é embeddado*, não *onde se corta* — é uma
  decisão de qualidade de retrieval que merece ser medida antes (a ferramenta da seção 11 existe
  para isso) e que não foi levantada no discovery.
- **Chunking semântico** (cortar por mudança de assunto, com LLM ou com distância entre embeddings
  de sentença). Descartado no discovery, item 1.
- **Reescrever `stripHtml` para preservar parágrafo.** Descartado no discovery, item 1.
- **Tornar a avaliação de chunking um gate de CI** ou dar a ela um arquivo de perguntas versionado.
  Discovery, item 2, explicitamente.
- **`status` no payload.** Discovery, item 3.
- **Remover do índice passage que sumiu do feed.** Continua a política da tarefa 02 (nada é
  removido por obsolescência). O sweep desta tarefa só apaga chunk órfão **de um passage que a
  fonte ainda devolve**; um passage que desapareceu da fonte não entra em `toIndex` e continua
  intocado.
- **Ajustar `CHUNK_SIZE`/`CHUNK_OVERLAP` com base em medição.** Esta tarefa entrega o valor default
  e a ferramenta de medir; o ajuste é um commit de uma linha depois, e ele custa um `npm run index`
  completo (seção 5).
- **Mexer em `embedAll`, `classify.ts`, `tagTeams`, `matchId`, cache de `getFacts`, `--dry-run`,
  `tsconfig.json`.** Nada disso é tocado.
- **Migração automática da coleção.** Depois do merge, **`npm run index -- --recreate` uma vez, à
  mão**: os ids de point mudam (seção 4) e o payload ganha dois campos obrigatórios (seção 6),
  então os points antigos ficariam inalcançáveis pelo diff e fariam `search()` lançar. Entra no
  README, como na tarefa 02.

### 17. Pontos em aberto para o usuário

Três coisas que não são minhas para decidir sozinho. A primeira não bloqueia a implementação; a
segunda e a terceira, sim, se a resposta for diferente do que assumi.

1. **Os números: `CHUNK_SIZE = 900`, `CHUNK_OVERLAP = 150`.** O discovery deu a faixa e chamou o
   valor de "ponto de partida ajustável", então travei o meio da faixa em vez de te devolver a
   pergunta — mas travar um número tem consequência: é ele que vai valer no índice real até alguém
   medir. Se você já tem intuição de que a notícia da Gazeta pede pedaço maior (1.000/200, menos
   chunks e mais contexto por chunk) ou menor (800/120, mais preciso e mais ruidoso), é melhor
   mudar agora do que depois — trocar o número custa um reindex completo (seção 5), que hoje leva
   alguns minutos por causa do loteamento da Voyage.

2. **Estendi o `contentHash` para cobrir os chunks, e não só o texto (seção 5).** Isso é uma mudança
   de contrato de um módulo que você aprovou na tarefa 02, então merece confirmação explícita. O
   ganho: mudar o parâmetro de chunking reindexa sozinho, em vez de deixar o índice com o chunking
   velho em silêncio. O preço: o `contentHash` deixa de ser "fingerprint do texto" e vira
   "fingerprint do que foi indexado" — e qualquer mexida nos parâmetros invalida o corpus inteiro,
   inclusive uma mexida acidental. A alternativa seria manter o hash como está e documentar no
   README que, depois de mudar `CHUNK_SIZE`, é preciso rodar `--recreate` à mão. Eu acho pior
   (passo manual invisível é exatamente o que o projeto evita nas tarefas 00 e 02), mas é o seu
   índice.

3. **Guardo `chunkCount` no payload mesmo sem o diff precisar dele (seção 6).** Depois de desenhar
   a ordem sweep-antes-do-upsert (seção 8.2), o campo deixou de ter papel na correção: ele sobrou
   como informação para o trace ("chunk 2/4"), para inspeção com `curl` e para as tarefas 04/05.
   Mantive porque o trace é o artefato de aprendizado do projeto e "a busca devolveu um pedaço de
   uma matéria" é exatamente o que esta tarefa ensina. Se você prefere o payload mínimo, dá para
   remover — o trace passa a imprimir só `chunk #2`, e nada mais muda.

## Implementação

Implementado em 2026-09-11 contra a spec da seção "Refinamento técnico", sem reabri-la.

### O que foi criado

Todos os arquivos novos da seção 14: `src/ingestion/chunk.ts` (`chunkText` + `CHUNK_SIZE`/
`CHUNK_OVERLAP` + `ChunkOptions`); `tests/ingestion/chunk.test.ts`; `tests/eval/chunking-report.ts`
(a avaliação manual da seção 11); `docs/learning/04-chunking.md`.

### O que foi alterado

`src/vectorstore/point-id.ts` (`pointIdFromPassageId` → `pointIdFromChunk(passageId, chunkIndex)`);
`src/vectorstore/types.ts` (`chunkIndex`/`chunkCount` no `passagePayloadSchema`);
`src/vectorstore/qdrant.ts` (`deleteOrphanChunks` + `OrphanSweep` + `ORPHAN_SWEEP_BATCH_SIZE`);
`src/ingestion/content-hash.ts` (assinatura `{ title, text }` → `{ title, chunks }`);
`src/ingestion/indexer.ts` (reescrito: chunking por passage, diff por chunk, sweep antes do
upsert, `IndexReport` com `chunks`/`orphanPointsDeleted` novos); `src/cli/index-passages.ts`
(linha de chunking com os parâmetros, linha de órfãos, `classified:` por `newPassages + changed`);
`src/agent/trace.ts` (`chunk i/N` quando `chunkCount > 1`); `package.json` (script
`eval:chunking`); `tests/vectorstore/point-id.test.ts`; `tests/vectorstore/qdrant-digests.test.ts`
(casos de `deleteOrphanChunks`, cliente mockado); `tests/ingestion/content-hash.test.ts`;
`tests/ingestion/indexer.test.ts` (reescrito, chunk.ts mockável); `tests/integration/
vectorstore.test.ts` (`samplePoint` com `chunkIndex`/`chunkCount` + prova do filtro de sweep
contra Qdrant real); `tests/integration/ingestion-incremental.test.ts` (passos 4-5: cresce para 3
chunks, depois encolhe e prova o sweep); `tests/{graph,trace,writer}.test.ts` (payloads de amostra
com os dois campos novos, mais os dois casos novos da seção 15 em `trace`/`writer`); `README.md`;
`docs/learning/README.md`; `docs/architecture.md` (glossário: `chunk`, `overlap`, `orphan chunk`).

**Nada foi apagado.**

### Decisões tomadas dentro do espaço que a spec deixou em aberto

- **Interpretação exata da regra 4 do algoritmo de chunking** (avançar o próximo `start` até o
  início da próxima palavra): a spec descreve isso em prosa ("avançado para o começo da próxima
  palavra, o primeiro caractere depois do espaço em branco seguinte"), mas não define o
  pseudocódigo exato. Minha primeira implementação tratava isso literalmente — sempre buscar o
  *próximo* espaço em branco a partir de `fimReal - overlap`, mesmo quando essa posição já caía
  exatamente no início de uma palavra — e isso continha um bug real: quando o corte do chunk
  anterior caía justo sobre um espaço em branco (comum, já que é exatamente onde a regra 3 corta),
  a busca "sempre avance" pulava a palavra seguinte inteira, o que podia empurrar o próximo
  `start` para além do fim do chunk atual e cair no ramo "abriria um buraco" — cujo destino,
  usando `end` (a posição do espaço) como teto, reintroduzia corte no meio de palavra. Encontrei
  isso com um teste de verificação (`3.500` sendo partido em `"3.500"`, `".500"`, `"500"`, `"00"`,
  `"0"` ao longo de vários chunks) antes de escrever o teste de unidade oficial. Corrigido com
  duas mudanças: (a) "avançar" só pula à frente quando a posição de partida não está *já* no
  início de uma palavra (ou seja, não é precedida por espaço em branco); (b) o teto do avanço
  passou a ser `advanceToWordStart(text, end)` (o início da próxima palavra depois do fim do chunk
  atual), não `end` em si — porque `end`, quando é um espaço em branco, não é uma posição válida
  de início de chunk, e usá-lo como teto reabria a possibilidade de corte no meio de palavra que a
  regra inteira existe para evitar. O teste `"não parte um token numérico"` da seção 15 cobre
  exatamente este caso e teria pego o bug.
- **Mensagens de erro de `chunkText` para `size`/`overlap` inválidos**: a spec fixa o texto exato
  só para o caso `overlap >= size` (`"overlap (900) must be smaller than size (900)"`). Para
  `size < 1` e `overlap < 0`, escrevi mensagens análogas (`"size (0) must be an integer >= 1"`,
  `"overlap (-1) must be an integer >= 0"`) seguindo o mesmo padrão — a spec não fixa esse texto,
  só exige que a função lance.
- **`chunk.ts` mockável em `tests/ingestion/indexer.test.ts`**: a spec (seção 15) pede
  explicitamente "sources, embed, qdrant, classify e chunk mockáveis". Implementei mockando o
  módulo inteiro (`vi.mock("../../src/ingestion/chunk.ts", () => ({ chunkText: vi.fn() }))`) com
  um padrão default de identidade (`(text) => [text]`, um chunk por passage) e overrides por texto
  de entrada nos testes que precisam de múltiplos chunks — o mesmo padrão já usado para
  `pointIdFromChunk`/`pointIdFromPassageId` desde a tarefa 02.
- **Números do teste de "chunks consecutivos compartilham pelo menos uma palavra"** (seção 15):
  a spec descreve a propriedade, não os parâmetros. Usei palavras de largura fixa (`w000`, `w001`,
  ...) para poder calcular o limite `overlap + comprimento de uma palavra` exatamente, em vez de
  aproximar.
- **Texto de ~2,5x `size` para o teste de "3 chunks"**: escolhi `size=100`/`overlap=20` e
  50 palavras numeradas (249 caracteres, ~2,49x), verificado empiricamente para produzir
  exatamente 3 chunks — a spec não fixa os parâmetros nem o texto exato, só a proporção e o
  resultado esperado.
- **Ordem dos passos 4/5 do teste de integração de ingestão**: o crescimento (2/4) usa um texto
  gerado com 20 parágrafos numerados repetidos (`Array.from({length:20}, ...)`), calibrado
  empiricamente contra `chunkText` real para produzir exatamente 3 chunks com os parâmetros
  default (900/150) — a spec pede "3 chunks" sem fixar o texto.

### Onde a implementação se desviou da spec, e por quê

**Um desvio, no teste de integração, não no código de produção**: adicionei uma pausa de 21s
**antes do passo 3** (o passage com texto alterado) de `tests/integration/
ingestion-incremental.test.ts`, além das duas pausas que a spec já pedia explicitamente antes dos
passos 4 e 5. A spec só menciona pausa para os passos 4/5. Na prática, rodando contra a Voyage
real hoje, duas chamadas de `embedAll` de costas uma para a outra (o `recreate` do passo 1 e o
passo 3 imediatamente em seguida, sem pausa) disparavam `429` de forma consistente e repetível (3
tentativas, sempre no mesmo ponto), mesmo somando só 3 chamadas dentro de uma janela de ~25
segundos — dentro do que "3 RPM" deveria permitir em teoria. `golden-rule.test.ts`, que já espaça
suas 4 chamadas por ~20s cada, nunca bateu nesse erro nas mesmas condições. Preferi replicar o
cadenciamento que já é comprovadamente estável a insistir no espaçamento mínimo que a spec
descreve — o comportamento observado (rate limit real, não hipotético) pesou mais que a letra
exata da seção 15, que já avisa que a única motivação da pausa é operacional, não uma asserção do
teste. Não é uma reinterpretação de contrato: as asserções continuam exatamente as que a spec
pede, só o tempo entre duas chamadas de rede mudou.

Fora isso, nenhum desvio de comportamento. As decisões acima são preenchimento de lacuna (a spec
não fixa string de erro literal, número de teste específico ou detalhe de implementação de teste),
não reinterpretação de contrato — em particular, a ordem sweep-antes-do-upsert (seção 8.2) foi
implementada exatamente como especificada, e é a asserção de ordem no teste "passage que encolheu"
(seção 15) que verifica isso.

### O que eu vi e não fiz, por estar fora de escopo

- **Deduplicar chunks do mesmo passage no top-k da busca** — seção 16, explicitamente das tarefas
  04/05.
- **Prefixar o título ao texto de cada chunk antes de embeddar** ("chunking contextual") — seção
  16, não levantado no discovery.
- **Ajustar `CHUNK_SIZE`/`CHUNK_OVERLAP` com base em medição** — a ferramenta (`npm run
  eval:chunking`) foi entregue, mas não rodei um ajuste de parâmetro; o valor que ficou no índice
  real é o default 900/150 aprovado.
- **Migração automática da coleção** — rodei `npm run index -- --recreate` manualmente, como a
  spec pede, e documentei os números abaixo; não escrevi nenhum script de migração.

## Revisão
_A preencher._

## Testes

- **Unidade** (`npm test` = `tsc --noEmit && vitest run`, sem rede/Docker): **162 testes, 19
  arquivos, todos passando** (eram 113 testes/16 arquivos depois da tarefa 02; a diferença é
  `tests/ingestion/chunk.test.ts` (16 testes novos) mais os casos novos em `point-id`,
  `content-hash`, `indexer`, `qdrant-digests`, `trace` e `writer`). `tsc --noEmit` limpo.
- **Integração — vetorstore** (`tests/integration/vectorstore.test.ts`, Qdrant real): **5/5
  passando**, incluindo o caso novo (`deleteOrphanChunks` contra um servidor real: insere 3 points
  de `chunkIndex` 0/1/2 do mesmo `passageId`, varre com `chunkCount: 1`, confirma 2 apagados e o
  `chunkIndex: 0` sobrevivendo) — a prova de que o filtro `should`/`must`/`range` aninhado
  realmente funciona no Qdrant, não só no mock.
- **Integração — a prova da tarefa** (`tests/integration/ingestion-incremental.test.ts`, Qdrant e
  Voyage reais): **1/1 passando** (70s). Os 5 passos confirmados contra uma coleção própria
  (`camisa10-ingestion-test`): (1) `recreate` → `points: 14`; (2) no-op → `unchanged: 14, points:
  0`, zero chamadas de embedding; (3) um passage com texto alterado → `changed: 1, points: 1`,
  ainda 14 points; (4) o mesmo passage cresce para 3 chunks → `changed: 1, points: 3,
  orphanPointsDeleted: 0`, `countPoints() === 16`, busca pelo vetor de um dos novos chunks devolve
  `chunkCount: 3`; (5) o mesmo passage volta a 1 chunk → `changed: 1, points: 1,
  orphanPointsDeleted: 2`, `countPoints() === 14` de novo — o sweep de órfãos provado de ponta a
  ponta.
- **Integração — recall@5** (`tests/integration/recall.test.ts`, Qdrant e Voyage reais): **2/2
  passando**, `recall@5 = 0.929` — **idêntico** à linha de base das tarefas 01/02. Confirma o
  invariante da seção 1: todo passage do fixture produz exatamente 1 chunk, então o chunking não
  mexeu em nada que a avaliação de retrieval meça. Confirmado também sob `LLM_CASSETTE=replay`,
  sem regravar o cassette.
- **Integração — regra de ouro** (`tests/integration/golden-rule.test.ts`, sem `LLM_CASSETTE`):
  **passou, 3/3 execuções reais** (77s). Confirmado também sob `LLM_CASSETTE=replay`, sem
  regravar — nenhum prompt de LLM mudou nesta tarefa, como a seção 15 previa.
- **Integração — fontes reais** (`tests/integration/live-sources.test.ts`): **2/2 passando**,
  sem relação direta com esta tarefa, rodado para confirmar que nada quebrou.
- **A suíte inteira via `npm run test:integration` de uma vez só bate em `429` da Voyage** quando
  as `beforeAll` de vários arquivos disparam chamadas de embedding em sequência rápida no início da
  execução — comportamento do tier gratuito (3 RPM/10K TPM), não uma regressão desta tarefa (o
  mesmo tipo de limite já documentado em `docs/learning/03-ingestion-pipeline.md`). Todos os 5
  arquivos de integração passam quando rodados individualmente, com espaçamento entre execuções —
  os números acima são dessas execuções.
- **`npm run index -- --recreate` contra a coleção real `camisa10`**: **completou com sucesso**
  (4 lotes de embedding, ~65s de espera entre cada um, dentro do orçamento de tokens/minuto de
  `embedAll` da tarefa 02). Números observados: **26 passages → 90 chunks** (900 caracteres, 150
  de overlap), **26 classificados: 20 article, 6 preview, 0 fallbacks**, **90 points upsertados**.
  `points_count` do Qdrant confirmado em 90 via `curl`. Segunda execução (incremental, ~70s
  depois): **25 passages → 84 chunks** (o feed RSS perdeu 1 item da janela deslizante entre as
  duas execuções — comportamento esperado, não um bug), **0 new, 0 changed, 25 unchanged**,
  "nothing to do — no embeddings, no LLM calls, no writes". `points_count` continuou em 90
  (nenhuma escrita), confirmando a convergência incremental contra o índice real.
