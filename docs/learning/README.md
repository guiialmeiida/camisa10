# Aprendizado

Este projeto existe para aprender RAG. Cada peça construída ganha aqui um doc explicando o
**conceito** por trás dela — não o que o código faz (isso o código diz), mas por que a decisão
foi essa e o que teria acontecido se fosse outra.

A regra é que o doc venha **junto** com a implementação, não depois. Um doc escrito depois vira
descrição; escrito junto, vira a razão da escolha.

Cada doc termina com um bloco **"Por que não X?"** — as alternativas descartadas e o motivo. É
onde mora a maior parte do aprendizado, porque é o que não aparece no código final.

## Índice

| Doc | Conceito | Tarefa |
|---|---|---|
| [01-embeddings-and-vector-search.md](01-embeddings-and-vector-search.md) | O que é um embedding e por que busca vetorial não é busca por palavra | 00 |
| [02-data-sources.md](02-data-sources.md) | Por que fato e narrativa vêm de fontes separadas, por que duas APIs de futebol, o que o RSS pode e não pode alimentar | 01 |
| [03-ingestion-pipeline.md](03-ingestion-pipeline.md) | Por que ingestão é convergência, não reconstrução — id determinístico, digest de conteúdo, e onde classificar com LLM é seguro | 02 |
| [04-chunking.md](04-chunking.md) | Por que um vetor por documento longo dilui o assunto, o que a sobreposição compra, por que tamanho fixo (não parágrafo/sentença), e por que chunking quebra "um passage = um point" | 03 |
| [05-rigid-filters.md](05-rigid-filters.md) | Por que similaridade não sabe que dia é hoje, pré-filtrar vs. pós-processar, por que `publishedAt` e não `payload.matchweek`, e o custo em paralelismo de um filtro que depende de fato | 04 |

_(cresce conforme as tarefas andam)_
