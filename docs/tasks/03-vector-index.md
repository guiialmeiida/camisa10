# Tarefa 03: Índice vetorial

Corresponde ao nó "Índice vetorial" do diagrama em `docs/architecture.md`. Depende da tarefa 02:
**substitui o chunking ingênuo e o schema mínimo da fatia vertical pelos definitivos.**

## Status
- [x] Discovery
- [ ] Refinamento técnico
- [ ] Implementação
- [ ] Revisão
- [ ] Testes

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
_A preencher após o discovery._

## Implementação
_A preencher._

## Revisão
_A preencher._

## Testes
_A preencher._
