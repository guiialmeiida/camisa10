# Embeddings e busca vetorial

**Conceito da tarefa 00.** É a peça mais fundamental do RAG: o "R" de *retrieval*.

## O problema

Você tem um monte de texto (notícias, súmulas) e uma pergunta em linguagem natural. Quer os
trechos que respondem à pergunta.

Busca por palavra-chave falha nisso de um jeito específico. A pergunta *"o Palmeiras está numa
fase ruim?"* não contém as palavras do trecho *"terceira derrota seguida do alviverde"* — nenhuma
palavra em comum, e mesmo assim é exatamente o trecho certo. Um `grep` acha zero. Um índice de
palavras (BM25, Elasticsearch) acha só se "Palmeiras" aparecer literalmente.

O que falta é **significado**, não letra.

## O que é um embedding

Um embedding é uma função que transforma texto num vetor de números — uma lista de, digamos,
1024 casas decimais. A propriedade que importa é só uma:

> **Textos com significado parecido viram vetores próximos no espaço.**

"terceira derrota seguida do alviverde" e "o Palmeiras está numa fase ruim" caem perto um do
outro, mesmo sem compartilhar palavra nenhuma. "escalação do Corinthians para domingo" cai longe
dos dois.

O modelo que faz isso (aqui, `voyage-3.5`, da Voyage AI) foi treinado justamente para arranjar o
espaço assim. Você não escolhe o que cada uma das 1024 dimensões significa — não são "time",
"emoção", "data". São eixos abstratos que o treino produziu, e nenhum humano lê um deles
isoladamente. O que se lê é a **distância entre dois vetores.**

## Como a busca funciona

O fluxo inteiro é:

1. **Na ingestão**: cada trecho de texto vira um vetor. Guardamos o par `(vetor, texto)` no
   Qdrant.
2. **Na pergunta**: a pergunta vira um vetor, pelo mesmo modelo.
3. **A busca**: o Qdrant devolve os `k` vetores mais próximos do vetor da pergunta.

"Mais próximo" quase sempre quer dizer **similaridade de cosseno**: o cosseno do ângulo entre os
dois vetores, entre -1 e 1. Cosseno mede *direção*, não tamanho — dois textos sobre a mesma coisa
apontam para o mesmo lado, mesmo que um seja um parágrafo e o outro uma frase. É por isso que o
tamanho do trecho não domina o resultado.

O `k` do "`k` mais próximos" é uma decisão sua e tem consequência real: `k` pequeno demais perde
o trecho certo, `k` grande demais enche o contexto do LLM de ruído — que é justamente o problema
que o **grader** da tarefa 06 existe para resolver.

## Três coisas que mordem

**A dimensão é permanente.** A coleção do Qdrant é criada com um número fixo de dimensões (1024
para o `voyage-3.5`). Trocar de modelo de embedding depois muda esse número e obriga
a **reindexar tudo**. Não é uma linha de config: é reprocessar a base inteira. Por isso a escolha
do modelo de embedding aparece cedo no projeto.

**O mesmo modelo dos dois lados.** Ingestão e pergunta precisam usar o mesmo modelo de embedding.
Vetores de modelos diferentes vivem em espaços diferentes; a distância entre eles não significa
nada — mas o Qdrant devolve resultados assim mesmo, sem erro. Falha silenciosa e confusa.

**Proximidade não é relevância.** O vizinho mais próximo é o *mais próximo que existe na base*,
não necessariamente um bom resultado. Se você perguntar sobre um time que não está indexado, a
busca ainda devolve `k` trechos, com scores respeitáveis, sobre outra coisa. **A busca vetorial
nunca diz "não sei".** Ela sempre devolve algo. Essa é a razão de existir do grader, e a razão
de a arquitetura proibir que números venham daqui.

## Por que não X?

**Por que não busca por palavra-chave (BM25)?** Falha no caso do "alviverde", que é o caso
típico de futebol — apelidos, sinônimos, perífrase. Vale dizer que a resposta profissional
costuma ser **híbrida** (BM25 + vetorial combinados), porque palavra-chave é imbatível para nome
próprio e número de camisa. Está fora do escopo do MVP, mas é a evolução natural.

**Por que não `voyage-3-large` (ou `output_dimension: 2048`)?** É melhor, e mais caro, e tem mais
dimensões (índice maior, busca mais lenta). Para 3 jogos de fixture a diferença não aparece. A
hora de reconsiderar é quando o `recall@k` do conjunto de avaliação empacar e o chunking já
tiver sido ajustado.

**Por que não jogar o texto todo no contexto do LLM e pular o retrieval?** Com 3 jogos, dá. Com
uma temporada inteira, não cabe — e mesmo cabendo, custa caro por pergunta e a qualidade cai com
o volume de ruído. O retrieval é o que mantém o custo constante conforme a base cresce.

**Por que o embedding não é da Anthropic?** A Anthropic não oferece endpoint de embedding; o
`VOYAGE_API_KEY` no `.env.example` existe só para isso. Os LLMs do projeto são todos Claude —
ver a tabela de modelos em `docs/architecture.md`.

**Por que Voyage AI e não OpenAI (`text-embedding-3-small`)?** A tarefa 00 foi implementada
primeiro contra a OpenAI, conforme a spec original aprovada. A troca para Voyage veio depois, a
pedido do usuário, para evitar depender de uma chave paga sem trial — a Voyage tem um tier
gratuito generoso (centenas de milhões de tokens) que cobre esse projeto de aprendizado
inteiro. A troca não muda nenhum conceito desta página: é a mesma peça, outro fornecedor. Um
detalhe técnico que ela introduz: a Voyage tem embeddings **assimétricos** de propósito — o
mesmo texto gera um vetor levemente diferente dependendo de `input_type: "document"` (na
ingestão) ou `input_type: "query"` (na pergunta), porque o modelo foi treinado sabendo qual dos
dois lados de uma busca cada texto representa. A OpenAI não faz essa distinção; a Voyage faz, e
o código (`src/ingestion/embed.ts`) respeita isso.
