# Decaimento temporal: peso contínuo em vez de janela rígida

**Conceito da tarefa 05.** Continuação direta de `05-rigid-filters.md`: aquele doc terminou dizendo
que decaimento temporal ficaria para esta tarefa, "onde a pergunta não é 'isto é da rodada atual?'
(sim/não), é 'quão recente é isto?' (uma escala contínua)". Este doc é sobre o que muda quando a
resposta para "isto entra?" deixa de ser binária.

## O problema é o mesmo da tarefa 04, mas a pergunta certa é outra

Um embedding continua sem saber que dia é hoje — isso não muda. Para `current_matchweek`, a tarefa
04 resolveu isso com um corte: fora da janela de `publishedAt`, o trecho nem é considerado. Para
`team_form` ("como o Palmeiras está de fase?"), esse mesmo corte é a ferramenta errada, por um
motivo concreto: **não existe fronteira honesta**. Uma crônica de 20 dias atrás sobre uma virada
importante ainda explica a fase de hoje; uma nota de 3 dias atrás sobre venda de ingressos não
explica nada. Um corte em "últimos N dias" trataria as duas como iguais dos dois lados da linha —
e qualquer N escolhido teria um caso em que corta um trecho relevante de um lado e deixa passar
um irrelevante do outro.

Decaimento contínuo troca a pergunta "entra ou não entra?" por "quanto isso ainda vale?". Com
meia-vida de 14 dias, um trecho de duas semanas atrás vale metade de um trecho de hoje; um trecho
de um mês atrás vale um quarto; e nenhum trecho chega a valer exatamente zero — ele só precisa ser
**muito** mais parecido, semanticamente, para compensar a idade e ainda assim subir ao topo. É a
fórmula do `docs/architecture.md` finalmente aparecendo no código:

```
score = similaridade_semantica x peso_metadado x decaimento_temporal
             (do Qdrant)          (fixo em 1)     (0.5 ** (ageDays / 14))
```

## Pré-filtrar (tarefa 04) vs. pós-processar (esta tarefa)

As duas tarefas resolvem "similaridade não sabe que dia é hoje" de formas estruturalmente
diferentes, e vale nomear a diferença:

- **Pré-filtrar** (`buildCurrentMatchweekFilter`) muda **quem pode ser visto**. O `filter` do
  Qdrant decide o conjunto candidato antes de qualquer comparação de similaridade — um trecho fora
  da janela nunca compete, nunca é ranqueado, é como se não existisse para aquela busca.
- **Pós-processar** (`rankByTimeDecay`) muda **a ordem de quem já foi visto**, e só enxerga o que o
  pool trouxe. Todo trecho retornado pelo Qdrant entra no ranking, com peso decrescente por idade —
  nenhum é descartado por ser velho, só penalizado.

O motivo de a tarefa 05 escolher pós-processar não é estilo: é que o Qdrant **não sabe fazer peso
contínuo**. O `filter` dele é uma condição booleana (`match`, `range`) — decide dentro/fora, não
multiplica um score por um fator entre 0 e 1. Pedir ao servidor para fazer isso nativamente
exigiria um recurso de reranking específico do Qdrant (a API de `formula`/prefetch mais recente),
acoplando o projeto a um detalhe de uma versão de um servidor específico para uma conta que o
cliente já faz em três linhas de TypeScript (ver "Por que não X?", abaixo).

## Por que pós-processamento *exige* um pool maior que `k`

Se pedíssemos `k = 5` ao Qdrant e reordenássemos só esses 5 por decaimento, o decaimento teria
pouquíssimo o que fazer: ele só pode mexer na ordem de quem já está na mão. Um trecho fresco e um
pouco menos parecido que ficou de fora do top-5 por similaridade nunca teria a chance de subir —
ele simplesmente não estaria ali para competir.

Por isso o grafo pede um **pool de candidatos** maior — `k * CANDIDATE_POOL_FACTOR` (4x, então 20
candidatos para um `k` de 5) — e só depois de aplicar `similaridade x decaimento` é que corta em
`k`. O tamanho do fator não é arbitrário: com meia-vida de 14 dias, um trecho duas semanas mais
velho precisa do dobro da similaridade para empatar; como as similaridades reais deste corpus vivem
numa faixa estreita (~0.4–0.7, pelos traços da tarefa 03), o decaimento tipicamente move um
resultado algumas posições dentro do pool, não dezenas — um fator 4 cobre essa movimentação com
folga, sem pedir ao Qdrant mais do que o necessário (cada candidato a mais volta com o `text`
inteiro do chunk no payload; um pool de 200 sobre um índice de ~100 pontos seria "traga a coleção
inteira e ordene no cliente").

## O que a meia-vida de 14 dias significa, na prática

`timeDecayWeight` é `0.5 ** (ageDays / halfLifeDays)`. Ler a curva em pontos concretos ajuda mais
que a fórmula sozinha:

| idade do trecho | peso |
|---|---|
| hoje (0 dias) | 1.0 |
| 7 dias | ≈ 0.707 |
| 14 dias (uma meia-vida) | 0.5 |
| 28 dias (duas meias-vidas) | 0.25 |
| 42 dias (três meias-vidas) | 0.125 |

Nenhuma linha chega a zero — é a diferença central para uma janela rígida, que faria o dia 15 valer
0 e o dia 14 valer 1, uma descontinuidade que não existe na realidade de "quão relevante ainda é
isso". A curva também nunca dá bônus para o futuro: um `publishedAt` adiantado (relógio de feed
errado, fuso mal escrito) tem a idade fixada em 0, não em negativo — do contrário um trecho "do
futuro" teria peso maior que 1 e bateria qualquer trecho legítimo de hoje.

## Por que não X?

**Por que não uma janela rígida de N dias, como `current_matchweek`?** Porque não existe fronteira
honesta para "forma recente" — ver a seção acima. `current_matchweek` tem uma âncora natural (a
data dos jogos da rodada); `team_form` não tem nenhuma data de referência além de "agora", e
qualquer corte fixo sobre "agora" é arbitrário de um jeito que o `current_matchweek` não é.

**Por que não decaimento linear** (`peso = 1 - ageDays / N`)? Decaimento linear chega a zero (e
depois a negativo, se não for grampeado) num ponto fixo, reintroduzindo pela porta dos fundos a
mesma descontinuidade que a janela rígida tinha — só que numa inclinação em vez de um degrau. O
decaimento exponencial nunca zera: um trecho antigo *muito* mais parecido ainda pode vencer, o que
é o comportamento certo (às vezes a crônica de um mês atrás é mesmo a mais relevante).

**Por que não pedir ao Qdrant que faça isso nativamente?** Além do argumento de acoplamento
(seção acima), há um argumento de simplicidade pedagógica: a conta cabe em uma função pura de dez
linhas (`timeDecayWeight`), testável sem rede e sem Qdrant algum. Empurrar isso para dentro do
servidor trocaria uma função legível por uma configuração de query specific de uma API que muda
entre versões do client — pior para quem está aprendendo o que "decaimento temporal" realmente
significa.

**Por que não aplicar decaimento também no `current_matchweek`?** Lá a janela rígida já resolveu o
problema de recência daquele modo — tudo que sobra do filtro já está dentro de uma janela estreita
e recente por construção. Empilhar decaimento por cima não teria quase nada para reordenar (o pool
já é pequeno e homogêneo em idade) e ainda esconderia qual dos dois mecanismos decidiu o quê,
tornando o sistema menos auditável exatamente onde ele já funciona.

**Por que não medir a curva de decaimento pelo `recall@k`, como o resto do retrieval?** O discovery
desta tarefa (item 8) decidiu isso explicitamente: `recall@k` mede se o trecho certo aparece nos
top-k de um conjunto fixo de perguntas — é uma métrica de _quais_ documentos aparecem, não de
_quanto peso_ um fator contínuo aplica sobre eles. Testar `timeDecayWeight` por unidade, com
`publishedAt`/`now` fixos e o resultado comparado a `0.5 ** (ageDays / 14)`, é determinístico e
direto; forçar essa mesma verificação a passar por `recall@k` misturaria uma pergunta de fórmula
com uma pergunta de corpus, e deixaria a baseline de recall (0.929) vulnerável a uma mudança que
não tem nada a ver com quais documentos existem.

**Por que não guardar o `score` decaído no índice, já pré-calculado?** Porque ele depende do "agora"
da pergunta, não do documento. O mesmo trecho, com o mesmo `publishedAt`, tem um peso diferente se
a pergunta chegar hoje ou daqui a uma semana — guardar um valor decaído no Qdrant seria guardar uma
resposta que expira sozinha, silenciosamente, sem que nada dispare seu recálculo.
