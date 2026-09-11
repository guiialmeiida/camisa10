# Pipeline de ingestão: convergência, não reconstrução

**Conceito da tarefa 02.** Não é sobre como chamar o Qdrant de novo — é sobre uma mudança de
modelo mental que qualquer pipeline de ingestão incremental precisa fazer em algum momento: parar
de tratar cada execução como "o mundo começou agora" e passar a tratá-la como "o que mudou desde
a última vez que olhei?".

## O problema: reconstruir é simples, mas caro

Até esta tarefa, `npm run index` fazia a coisa mais simples possível: apaga a coleção inteira,
embedda tudo de novo, escreve tudo de novo. Funciona, e é fácil de entender — mas o custo cresce
com o tamanho do índice, não com o tamanho da mudança. Se o feed da Gazeta Esportiva trouxer 34
notícias e só 4 forem novas desde ontem, reconstruir do zero ainda assim gasta 34 chamadas de
embedding e 34 classificações. A conta não é sobre dinheiro (embedding é barato) — é sobre o que
o pipeline **precisa saber** para não pagar duas vezes pelo mesmo trabalho.

Reconstruir é simples justamente porque evita responder uma pergunta difícil: "este item que
estou vendo agora já está no índice, e do jeito certo?". Um pipeline incremental existe só para
responder essa pergunta antes de gastar dinheiro, não depois.

## A pergunta se quebra em duas, e as duas precisam de uma chave estável

1. **Já está lá?** — para responder isso sem baixar o índice inteiro, é preciso que a mesma
   entrada produza sempre o mesmo identificador no armazenamento. Se o id mudasse a cada execução
   (como o `index + 1` sequencial que este projeto usava até aqui), a pergunta "já está lá?" não
   teria resposta: o "lá" de hoje não tem nenhuma relação com o "lá" de ontem.
2. **Do mesmo jeito?** — mesmo sabendo que o item já está lá, o conteúdo pode ter mudado (uma
   notícia editada depois de publicada). Responder isso sem reembeddar exige guardar, junto com o
   dado já indexado, um resumo barato do que foi indexado da última vez — para comparar sem pagar
   o custo de gerar esse resumo de novo.

A primeira pergunta pede um **id determinístico**. A segunda pede um **digest de conteúdo**. Com
as duas, a ingestão vira **idempotente**: rodar duas vezes seguidas produz o mesmo índice, e a
segunda vez não gasta nada — porque a segunda vez não *muda* nada.

## Id determinístico: por que hashear em vez de sequenciar

O Qdrant só aceita inteiro sem sinal ou UUID como id de point — não aceita a string
`passage.id` que o projeto já usa internamente. A solução (`pointIdFromPassageId`) é hashear o
`passage.id` com sha1 e ler os primeiros 48 bits do digest como inteiro. 48 bits cabem dentro de
`Number.MAX_SAFE_INTEGER` (2^53), então o valor sobrevive a serialização JSON sem perder
precisão — nada de `BigInt`, nada de string.

O ponto interessante não é o hash em si, é que a função precisa ser **total**: aceitar qualquer
string não vazia, não só os ids hexadecimais de 12 caracteres que `rss.ts` produz. O dublê de
teste usa ids como `"p03"`, que não são hexadecimais — `Number.parseInt("p03", 16)` já dá `NaN`
antes de qualquer hash. Uma função que trata "se for hex, converte; senão, hasheia" é uma
ramificação a mais para entender e um lugar a mais para o comportamento de produção e o de teste
divergirem. Hashear sempre, incondicionalmente, custa microssegundos e elimina o problema.

Truncar para 48 bits introduz um risco real, ainda que pequeno: colisão. Com a ordem de 10⁴
passages, a chance é da ordem de 10⁻⁹ — desprezível, mas não zero, e o pior desfecho possível de
uma colisão silenciosa é sobrescrever um passage sem nenhum aviso. Por isso o indexador guarda
duas checagens explícitas: id de point repetido *dentro do mesmo lote* com `passageId` diferente
lança; e um id que já existe no índice, mas associado a um `passageId` diferente do que está
sendo processado agora, também lança. As duas viram erro alto e claro, nunca um dado perdido em
silêncio.

## Digest de conteúdo: por que ele vem *antes* do embedding

`contentHash` é um sha1 sobre `título + texto` do passage — 40 caracteres hexadecimais, guardados
no próprio payload do point. A ordem importa: comparar dois hashes custa microssegundos; gerar um
embedding custa uma chamada de rede, dinheiro e uma classificação por LLM junto. O pipeline
sempre calcula o hash primeiro e só manda para embedding/classificação o que o hash provou ser
`new` ou `changed`. É a mesma lógica de um cache: a checagem barata decide se vale a pena pagar
pela cara.

O hash cobre só `title` e `text` — deliberadamente não cobre `type`, `teams`, `matchweek` nem
`competition`. Cada exclusão tem um motivo:

- **`type`** é *produzido pelo classificador*, não uma entrada dele. Se o hash incluísse `type`,
  seria preciso classificar antes de saber se vale a pena classificar — circular.
- **`matchweek`** muda toda semana. Se o hash o incluísse, o índice inteiro seria invalidado a
  cada rodada nova, mesmo que nenhuma notícia tivesse mudado uma vírgula. A consequência aceita é
  que `matchweek` de um point passa a significar "a rodada em que ele foi indexado pela primeira
  vez" — o que é *melhor* do ponto de vista de filtro (uma notícia da rodada 26 não vira
  "rodada 27" só porque a semana virou), mas é uma mudança semântica que vale registrar.

## Por que classificar com LLM é aceitável aqui, e taguear time com LLM não era

A tarefa 01 decidiu, de propósito, **não** trocar o tagueamento de time (`tagTeams`) por LLM:
regex sobre uma lista curada de ~20 nomes e apelidos é mais barato, mais determinístico e já
funciona. Esta tarefa introduz o primeiro LLM do lado da ingestão (`classifyPassageType`,
`claude-haiku-4-5`) para decidir o gênero da matéria (`article`/`chronicle`/`matchReport`/
`preview`). Por que a resposta é diferente das duas vezes?

A diferença não é "LLM é melhor" — é o que cada tarefa está fazendo. Taguear time é **correspondência**:
"o nome 'Palmeiras' aparece no texto?" tem uma resposta objetiva, e uma lista finita e estável
resolve isso sem ambiguidade nenhuma. Classificar gênero de matéria é **julgamento**: "isso é uma
crônica opinativa ou um relato factual?" não tem uma lista de palavras-chave que resolva — dois
textos podem citar exatamente os mesmos fatos e diferir só no tom. É o tipo de tarefa em que um
regex teria que enumerar padrões de escrita jornalística, e ainda assim erraria a maioria dos
casos de fronteira.

O que torna essa chamada de LLM segura, e não uma porta nova para a regra de ouro, é o **schema
da resposta**: `z.strictObject({ type: z.enum([...]) })`. Não existe campo de texto livre. Mesmo
que o modelo leia "Palmeiras 1 x 3 Fluminense" no meio do texto e "queira" repetir o número, não
há onde escrevê-lo — a única coisa que ele pode devolver é um entre quatro literais. A proteção
não é o prompt pedindo educadamente para não inventar números; é o tipo da resposta não ter
espaço para um número existir. Isso é o mesmo princípio do resto do projeto (número exato só sai
de `getFacts`), aplicado a um lugar novo: quando a saída de um LLM é um enum fechado, a pergunta
"esse LLM pode vazar um fato?" tem resposta estrutural, não uma resposta de sorte.

## O relatório como artefato de aprendizado

`indexPassages()` devolve quantos passages foram `new`, `changed` e `unchanged`, quantos points
foram escritos, quantas classificações caíram no fallback (`"article"`, quando a chamada ao LLM
falha) e a contagem por `PassageType`. A CLI (`npm run index`) imprime isso — não é log de debug,
é o mesmo espírito do traço do agente (tarefa 00): tornar visível o que normalmente fica invisível
— quanto do trabalho de uma execução foi realmente novo, e o que o classificador decidiu, em
agregado, sem ninguém precisar abrir o Qdrant para descobrir.

## Por que não X?

**Por que não `scroll` com filtro por `passageId`, em vez de `retrieve` por id?** O Qdrant também
tem uma API de busca por filtro de payload (`scroll`), mas ela existe para "encontre pontos cujo
payload bate com esta condição", que é mais cara e menos direta do que "me dê exatamente estes N
ids", que é o que a pergunta "já está lá?" realmente é. Com o id de point determinístico
(`pointIdFromPassageId`), o pipeline já sabe exatamente quais ids perguntar — não precisa
filtrar, só buscar.

**Por que não UUIDv5 em vez de truncar um sha1?** UUIDv5 é hash determinístico por definição, e
seria a opção "mais correta" no papel. O Node, porém, não traz um gerador de UUIDv5 pronto —
`crypto.randomUUID()` é v4 (aleatório). Implementar v5 à mão significa manipular bits de versão e
variante manualmente, mais código para chegar exatamente ao mesmo lugar: um identificador
determinístico. Um inteiro de 48 bits é mais simples de ler num `curl` contra o Qdrant, não
precisa de `BigInt`, e resolve o mesmo problema com menos maquinaria.

**Por que não deletar do índice o que sumiu do feed RSS?** Um item que não aparece mais no feed
não significa necessariamente que ele "não existe mais" — RSS é uma janela deslizante de itens
recentes, não um catálogo completo. Apagar automaticamente correria o risco de remover conteúdo
ainda relevante só porque ele rolou para fora da janela do feed. Esta tarefa decidiu, no
discovery, resolver obsolescência do lado da *busca* (peso menor para passage antigo, via
`timeDecay` nas tarefas 04/05) em vez do lado da *ingestão* (remoção ativa). Política de retenção
de verdade — quando e por que apagar — fica para quando o índice crescer a ponto de isso
incomodar de verdade, com dado real sobre o tamanho do problema.

**Por que não cron, systemd timer ou GitHub Action agendado?** O projeto é de uso pessoal via
CLI, sem servidor rodando. Automatizar a cadência de ingestão é infraestrutura adicional que hoje
não tem problema nenhum para resolver — ninguém está esperando um índice sempre atualizado sem
disparar nada. Se isso mudar, é uma tarefa própria, não um acréscimo silencioso a esta.

**Por que não uma chamada de LLM em lote (todos os passages de uma vez), em vez de uma por
item?** Uma chamada em lote é mais barata em tokens, mas devolve um array que precisa ser
realinhado com a entrada — e um modelo que pula um item, inverte a ordem ou inventa um id que não
existia quebra esse realinhamento de um jeito difícil de detectar. Pior: uma falha na chamada em
lote perde a classificação de todos os itens do lote de uma vez, não só de um. Com uma chamada
por item, a falha de um passage cai naturalmente no fallback (`"article"` + aviso) sem afetar os
outros — o comportamento "no teto, ainda assim responde" fica embutido na própria forma da
função, não numa lógica de recuperação por cima.
