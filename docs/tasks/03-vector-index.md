# Tarefa 03: Índice vetorial

Corresponde ao nó "Índice vetorial" do diagrama em `docs/architecture.md`. Depende da tarefa 02:
**substitui o chunking ingênuo e o schema mínimo da fatia vertical pelos definitivos.**

## Status
- [ ] Discovery
- [ ] Refinamento técnico
- [ ] Implementação
- [ ] Revisão
- [ ] Testes

## Discovery
- Confirmar o schema final de metadados (rodada, status, times_mencionados, competição,
  published_at, tipo_de_conteúdo).
- Estratégia de chunking dos textos de notícia/súmula.

Decidido no grilling de 2026-09-08:

- **Embedding**: `voyage-3.5` da Voyage AI (o `VOYAGE_API_KEY` do `.env.example` existe para
  isso — trocado a partir do `text-embedding-3-small`/OpenAI original da tarefa 00, decisão do
  usuário, ver `docs/tasks/00-vertical-slice.md` § Implementação). Modelos maiores da mesma
  família (`voyage-3-large`) ou dimensão maior (`output_dimension: 2048`) são melhores, mas **a
  dimensão do vetor é fixada na criação da coleção do Qdrant** — trocar depois obriga a
  reindexar tudo. É uma decisão a tomar com os olhos abertos, não por acidente.
- **Qdrant**: real desde a tarefa 00 (local via Docker ou em memória, a definir lá).

O chunking é a variável mais consequente desta tarefa, e a única forma honesta de avaliá-lo é o
`recall@k` do conjunto de avaliação criado na tarefa 00.

## Refinamento técnico
_A preencher após o discovery._

## Implementação
_A preencher._

## Revisão
_A preencher._

## Testes
_A preencher._
