# Filtro rígido: dizer ao índice o que ele nem pode considerar

**Conceito da tarefa 04.** Continuação direta do que `01-embeddings-and-vector-search.md` e
`04-chunking.md` explicaram: até aqui, toda busca no índice era "os k vetores mais parecidos com a
pergunta, dentre todos os que existem". Esta tarefa introduz a primeira exceção: às vezes, "todos
os que existem" está errado, e é preciso recortar o conjunto *antes* de perguntar quem é parecido.

## O problema: similaridade não sabe que dia é hoje

Um embedding captura *assunto*, não *recência*. "Como está a rodada do Brasileirão?" e uma crônica
de três rodadas atrás sobre os mesmos times, com o mesmo vocabulário — "vitória", "gols",
"escalação" — produzem vetores parecidíssimos. Sem nenhum recorte, a busca devolve o trecho mais
parecido do corpus inteiro, e é perfeitamente possível que esse trecho seja de um jogo que já
terminou há um mês. O redator então escreve, com toda a confiança que o prompt permite, sobre uma
notícia velha como se fosse da rodada atual.

Isso não é falha do embedding — é exatamente o que ele promete fazer (medir parecença de assunto).
O ajuste tem que vir de fora do embedding.

## Duas formas de ajustar: pré-filtrar vs. pós-processar

Há duas famílias de solução para "o resultado mais parecido não é o resultado certo":

1. **Pré-filtrar**: reduzir o conjunto candidato *antes* da comparação de similaridade. É o
   `filter` do Qdrant — uma condição booleana sobre o payload (`publishedAt` está numa janela?
   `teams` contém este time?) que decide, ponto a ponto, quem entra na disputa pelos top-k.
   Pontos que não passam no filtro **nunca são comparados por similaridade** — não é que percam a
   disputa, é que nem competem.
2. **Pós-processar**: buscar sem restrição, trazer mais candidatos do que o necessário (um `k`
   maior) e depois reordenar ou descartar com uma segunda passada — um rerank, ou multiplicar o
   score por um fator de decaimento temporal (a fórmula `similaridade x peso_metadado x
   decaimento_temporal` do `docs/architecture.md`). Aqui, todo mundo compete; o ajuste acontece
   depois, sobre quem já venceu a primeira rodada.

Esta tarefa implementa só a primeira. `buildCurrentMatchweekFilter` (`src/retrieval/filters.ts`)
monta a condição e passa para `search_vector_context` como `filter` — puro recorte, sem tocar em
score nenhum. O decaimento temporal (peso decrescente por distância no tempo, em vez de uma janela
de corte seco) fica para a tarefa 05, onde é o conceito central de `team_form`: lá a pergunta não é
"isto é da rodada atual?" (sim/não), é "quão recente é isto?" (uma escala contínua) — uma pergunta
diferente, que pede a outra família de solução.

O `k` muda de sentido sutilmente com um filtro: sem filtro, é "os k mais parecidos entre todos os
pontos". Com filtro, é "os k mais parecidos entre os elegíveis" — pode devolver menos que k, ou
zero, mesmo que o índice tenha milhares de pontos sobre o assunto certo, só que fora da janela.

## Por que a data confiável é `publishedAt`, não `payload.matchweek`

O índice já guarda um campo `matchweek` em cada point — por que não filtrar por ele diretamente?
Porque `matchweek` não significa "a rodada de que este trecho fala". Ele significa "qual era a
rodada corrente **da última vez que este point foi escrito**". A ingestão incremental
(`docs/learning/03-ingestion-pipeline.md`) só reescreve um point quando o `contentHash` muda — uma
notícia que não muda de texto fica parada no índice com o `matchweek` congelado no valor de quando
entrou, rodadas atrás. Usá-lo como filtro filtraria pela história de escrita do índice, não pelo
conteúdo do trecho.

`publishedAt`, em contraste, é o timestamp real da fonte (a data que a notícia foi publicada,
gravada pela ingestão desde a tarefa 01) — não depende de quando o point foi escrito ou reescrito
no Qdrant. É o único campo em que "isto é recente" é uma afirmação sobre o *conteúdo*, não sobre o
*índice*. Por isso a janela de filtro (seção 3 da spec) usa `publishedAt`, e a spec proíbe
explicitamente usar `matchweek` para isso — não é um detalhe de implementação, é uma decisão que
alguém vai querer "otimizar" de volta depois, e a resposta para essa tentação já está escrita
aqui.

## A janela é `Math.min`, não `matches[0]`

A janela de datas usa a data **mínima** entre os jogos da rodada, nunca o primeiro elemento do
array de `facts.matches`. A API não garante ordem cronológica nesse array — nada no código de
`src/sources/football-data.ts` ordena por data antes de devolver. Usar `matches[0]` funcionaria em
todo teste que monta o array já ordenado (o jeito mais natural de escrever um fixture) e falharia
silenciosamente em produção, sempre que a API devolvesse os jogos fora de ordem: a janela ficaria
ancorada num jogo que não é o mais antigo, cortando fora justamente os trechos publicados nos dias
antes do primeiro jogo de verdade. `tests/retrieval/filters.test.ts` constrói o fixture com o jogo
mais antigo deliberadamente na última posição do array — é o teste que existe só para travar esse
bug de volta, caso alguém troque `Math.min` por `matches[0]` num refactor futuro achando que é a
mesma coisa.

## Por que um filtro cria uma dependência de dado — e o que isso custa em paralelismo

Até esta tarefa, o fan-out do agente (`runFanOut` em `src/agent/graph.ts`) rodava duas chamadas
genuinamente independentes em paralelo: fatos vêm da API, narrativa vem do índice, uma não sabe da
outra. O filtro de `current_matchweek` quebra essa independência — a janela de datas só existe
depois que `facts.matches` chega, então a busca vetorial passa a **esperar** a chamada de fatos
antes de poder montar o filtro e disparar a query.

A resposta não foi sequenciar o grafo inteiro (perder o paralelismo também em `team_form`, que não
precisa de nada disso) nem separar `searchContext` em `embed` + `search` para pelo menos embeddar a
pergunta em paralelo com a chamada de fatos (ganharia ~300ms de embedding, ao custo de espalhar a
composição da função por dois lugares do grafo — caro em entendimento para um ganho pequeno num
pipeline dominado por chamadas Opus de segundos). A resposta foi um meio-termo: só o modo que
precisa da dependência espera por ela, e o `Promise.allSettled` continua garantindo que uma falha
na API de fatos não derruba a busca vetorial (ela roda sem janela de data, só com o que não
depende da API — a cláusula de time). O campo `waitedForFactsMs` no traço mede exatamente esse
custo, para que ele nunca fique invisível: se um dia a espera importar de verdade, é o primeiro
número a olhar.

## Por que não X?

**Por que não filtrar por `payload.matchweek`?** Respondido acima — o campo é congelado no momento
da última escrita, não reflete a rodada real do conteúdo depois disso.

**Por que não rerank ou decaimento temporal nesta tarefa?** Porque `current_matchweek` faz uma
pergunta binária ("isto é da rodada atual?"), não uma pergunta de grau ("quão recente é isto?"). A
segunda é o conceito central da tarefa 05 (`team_form`), e implementar as duas fórmulas em tarefas
separadas, cada uma com sua própria nuance, é mais simples de entender do que uma fórmula única
tentando servir os dois casos de uso de uma vez.

**Por que não cair para busca sem filtro quando o filtro devolve zero resultado?** Um fallback
silencioso faria o traço mentir: ele mostraria um filtro que, na prática, não foi o que decidiu o
resultado. O caminho de baixa confiança já existe (`computeLowConfidence`) para exatamente este
caso — contexto vazio é contexto vazio, e a resposta sai avisando disso em vez de fingir que achou
algo relevante. Um retry com relaxamento de filtro é assunto do loop de reescrita de query da
tarefa 06, que tem teto e aparece no traço — não uma queda silenciosa aqui.

**Por que não filtrar por status do jogo** (por exemplo, só mostrar narrativa de jogos
`finished`)? A tarefa 03 já tinha decidido isso: status muda no tempo (um jogo `scheduled` vira
`live` vira `finished`) e não pode ser congelado no índice pela mesma razão que `matchweek` não
pode — o point não é reescrito só porque o status do jogo mudou.

**Por que não sequenciar o fan-out inteiro**, esperando sempre por `facts` antes de buscar? Mataria
o paralelismo em `team_form`, que não precisa de nenhuma dependência nova, só para simplificar o
código de um modo que não é o dele. `runContextCall` decide *por modo* se espera, não o grafo
inteiro.
