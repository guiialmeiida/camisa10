# Chunking: um vetor por assunto, não um vetor por documento

**Conceito da tarefa 03.** Continuação direta do que `01-embeddings-and-vector-search.md`
explicou: um embedding é um vetor só, para o texto inteiro que você mandou. Chunking é a decisão
de *quanto* texto vai dentro de cada vetor.

## O problema: um vetor por notícia dilui o assunto

As notícias da Gazeta Esportiva não são curtas — mediana de ~2.000 caracteres, algumas passam de
8.000. Um texto desse tamanho fala do jogo, da lesão de um jogador, da tabela e da próxima rodada,
tudo na mesma matéria. Se o texto inteiro vira um vetor só, esse vetor é uma espécie de média de
tudo que o texto contém.

O problema aparece na hora da busca. A pergunta "o zagueiro se machucou?" é sobre um parágrafo da
notícia, não sobre a notícia inteira — mas o vetor que representa a notícia carrega o peso de
todo o resto do texto (o placar, a próxima rodada, a entrevista do técnico) competindo pelo mesmo
espaço. Quanto mais assunto cabe num vetor, menos ele se parece com qualquer pergunta específica
sobre um desses assuntos.

Cortar o texto em pedaços menores dá um vetor por assunto: o parágrafo sobre a lesão vira um vetor
que só fala de lesão, e esse vetor fica muito mais perto, no espaço, da pergunta "o zagueiro se
machucou?" do que o vetor da notícia inteira ficaria. De quebra, o redator recebe no `<context>`
um trecho de duas frases em vez de uma matéria de 2.000 caracteres — menos ruído no prompt, menos
chance de o modelo se perder no meio do texto errado.

## O que a sobreposição (overlap) compra

Cortar em pedaços fixos tem um efeito colateral óbvio: uma frase pode cair bem em cima do corte,
com metade num chunk e metade no seguinte. Sem cuidado nenhum, essa frase nunca aparece inteira em
lugar algum — o significado dela se perde nos dois pedaços truncados.

A sobreposição resolve isso sem precisar entender onde as frases começam e terminam: cada chunk
novo recua alguns caracteres para dentro do chunk anterior (nesta tarefa, 150 caracteres — ~17%
do tamanho do chunk). Uma frase que caiu perto do corte acaba **inteira** em pelo menos um dos dois
chunks, mesmo que também apareça truncada no outro. O preço é redundância: o mesmo trecho de texto
é embeddado (e pode aparecer no `<context>`) mais de uma vez. É uma troca deliberada — texto
duplicado é barato; informação perdida no meio de um corte não tem como ser recuperada depois.

## Por que tamanho fixo, e não parágrafo ou sentença

A escolha óbvia, à primeira vista, seria cortar por parágrafo — respeita a estrutura que quem
escreveu a notícia já pensou. Duas razões concretas descartaram isso:

1. **`stripHtml` (tarefa 01) já colapsou os parágrafos.** `src/sources/rss.ts` faz
   `.replace(/\s+/g, " ")` no texto da notícia — toda quebra de linha, toda tag `<p>`, vira um
   espaço só. A informação "aqui terminava um parágrafo" já foi apagada antes de chegar em
   `chunkText`. Cortar por parágrafo exigiria reabrir e reescrever `stripHtml`, um código já
   testado e em produção, só para esta tarefa.
2. **Cortar por sentença precisaria de um parser de fim de sentença em português** — que não é
   trivial ("Dr. Silva marcou aos 45 min." tem dois pontos que não terminam frase nenhuma) — e é
   uma superfície de erro nova sem ganho claro sobre tamanho fixo, dado que o overlap já resolve o
   problema de frase cortada ao meio.

Tamanho fixo em caracteres, respeitando fronteira de *palavra* (não de frase), é a opção que não
depende de reabrir código existente nem de escrever um parser novo — e ainda assim nunca corta um
número ou uma palavra ao meio, que é a única fronteira que a regra de ouro realmente precisa.

## Por que chunking quebra "um passage = um point"

Até a tarefa 02, a premissa do índice era simples: cada passage (uma notícia) vira exatamente um
point no Qdrant, com um id determinístico derivado só do `passage.id`. Chunking introduz N
chunks por passage, e cada chunk precisa do seu próprio vetor e do seu próprio point — então "um
passage = um point" vira "um passage = N points", com N variando por passage e, pior, **variando
ao longo do tempo** conforme a notícia é editada.

Isso se propaga em três lugares que a tarefa 02 tinha resolvido de um jeito mais simples:

- **O id do point** deixa de depender só do `passageId` (`pointIdFromPassageId`) e passa a
  depender também da posição do chunk (`pointIdFromChunk(passageId, chunkIndex)`) — o par inteiro
  precisa ser único, não só o passage.
- **O diff incremental** deixa de perguntar "este point existe e bate?" (uma pergunta, um point) e
  passa a perguntar "**todos** os N chunks deste passage existem e batem?" — porque um passage com
  2 de 3 chunks no índice não está nem `new` nem `unchanged`; está pela metade, e precisa ser
  tratado como `changed` para se completar.
- **A escrita ganha um jeito novo de sujar o índice.** Se uma notícia editada passa a produzir
  *menos* chunks que antes (ficou mais curta, ou o parâmetro de chunking mudou), o `upsert` sobre
  os N novos ids não toca nos ids antigos que sobraram — eles ficam no Qdrant como **chunks
  órfãos**: a busca ainda os devolve, com o texto da versão antiga da notícia, e ninguém nunca mais
  escreve nem lê aqueles points de novo.

O terceiro ponto é o que exigiu peça nova: `deleteOrphanChunks()`, um filtro que apaga, para cada
passage reindexado, todo chunk com índice maior ou igual à contagem atual (`chunkIndex >= M`).
Rodar esse filtro duas vezes seguidas dá o mesmo resultado que rodar uma vez — ele descreve um
estado ("não existe chunk além do M-1"), não uma ação incremental ("apague estes dois points")
— e é isso que permite encaixá-lo no pipeline sem quebrar a idempotência que a tarefa 02
construiu.

A ordem importa, e é sutil: o sweep roda **antes** do upsert, não depois. Se o processo morresse
no meio de uma execução, os chunks já escritos ainda carregam o `contentHash` **antigo** até o
upsert terminar — então a próxima execução ainda vê esse passage como `changed` e roda o sweep de
novo. Se a ordem fosse invertida (upsert primeiro, sweep depois) e o processo morresse entre os
dois passos, os chunks já teriam o hash **novo**, a próxima execução veria `unchanged`, e os
órfãos ficariam no índice para sempre — silenciosamente. A idempotência-sem-transação da tarefa 02
(retomar de onde parou, sem precisar desfazer nada) só sobrevive à introdução de chunking porque a
ordem entre as duas operações foi escolhida a dedo para isso.

## Por que não X?

**Por que não chunking semântico** (cortar quando o assunto muda, com um LLM ou com distância
entre embeddings de sentença)? É mais sofisticado e, no papel, corta exatamente onde faz sentido
— mas troca uma função pura e determinística por uma chamada de rede (custo, latência, mais uma
coisa que pode falhar) só para decidir *onde* cortar, sem mudar *o que* é indexado. Para o volume
de texto deste projeto (notícias de algumas centenas a poucos milhares de caracteres), tamanho
fixo com overlap já garante que nenhuma frase se perde — o ganho do chunking semântico apareceria
em textos muito mais longos e heterogêneos do que os deste índice.

**Por que não cortar por parágrafo ou por sentença?** Respondido acima — `stripHtml` já colapsou
os parágrafos, e um parser de sentença em português é superfície de erro nova sem necessidade,
porque o overlap já resolve o caso que a fronteira de sentença resolveria.

**Por que não empacotar `chunkIndex` nos bits do id** (por exemplo, `hash40(passageId) * 256 +
chunkIndex`) em vez de hashear a string `${passageId}#${chunkIndex}` inteira? Empacotar bits
impõe um teto arbitrário — nesse exemplo, no máximo 256 chunks por passage — e transformaria
"passage com mais chunks que isso" num bug silencioso de sobrescrita (dois chunks diferentes
compartilhando o mesmo id). Hashear a concatenação não tem teto nenhum; o único risco que ela
adiciona é colisão de hash, e essa colisão já tem uma guarda desde a tarefa 02, agora estendida
para o par `(passageId, chunkIndex)`.

**Por que não apagar chunk órfão por id, em vez de por filtro?** Apagar por id exigiria saber
quantos chunks a versão *anterior* de um passage tinha — ou seja, confiar num `chunkCount`
guardado que a própria escrita nova está prestes a sobrescrever. O filtro `chunkIndex >= M`
não depende de história nenhuma: ele descreve o estado desejado ("não existe chunk além do
M-1"), o que é exatamente o que faz a operação ser repetível sem efeito colateral — rodá-la duas
vezes dá o mesmo resultado de rodar uma vez.

**Por que o `contentHash` passou a cobrir os chunks, e não só o texto cru?** Se o hash cobrisse só
o texto do passage, mudar `CHUNK_SIZE` ou `CHUNK_OVERLAP` não mudaria hash nenhum — todo passage
continuaria batendo com o que já está indexado, o diff classificaria tudo como `unchanged`, e o
índice ficaria com o chunking antigo **sem nenhum sinal de que algo mudou**. Cobrir os chunks
(que já refletem o parâmetro de corte) faz o parâmetro entrar no fingerprint: mudar `CHUNK_SIZE`
muda todo hash, e a próxima `npm run index` reindexa o corpus inteiro sozinha. O preço é claro e
aceito: qualquer mexida nos parâmetros de chunking — inclusive uma acidental — custa reembeddar
tudo. O projeto já tinha escolhido esse tipo de troca antes (tarefas 00 e 02: falhar alto e
óbvio é melhor que vazar em silêncio), e esta é a mesma escolha, num lugar novo.

**Por que a avaliação de chunking (`npm run eval:chunking`) não virou gate de CI?** Ela mede uma
propriedade sem "certo" ou "errado" definido de antemão — a distribuição de chunks por passage e,
opcionalmente, o que um `k` de busca devolve para uma pergunta específica contra o índice real.
Não existe um número-alvo que separe "bom" de "ruim" aqui, ao contrário do `recall@k` do fixture
(que tem gabarito: sabemos exatamente quais passages cada pergunta deveria recuperar). Transformar
isso num gate de CI exigiria inventar um limiar arbitrário só para ter luz verde/vermelha, ou
construir um segundo conjunto de perguntas com gabarito — e esse segundo conjunto é exatamente o
harness que o discovery desta tarefa decidiu não construir, porque o índice real muda de conteúdo
toda vez que a Gazeta publica notícia nova, e um gabarito fixo contra um índice que muda de baixo
dele envelhece rápido. A ferramenta existe para *inspeção*, não para aprovação automática: você
roda quando quer ver o efeito de mudar `CHUNK_SIZE`/`CHUNK_OVERLAP`, lê a distribuição e o top-k,
e decide a olho.
