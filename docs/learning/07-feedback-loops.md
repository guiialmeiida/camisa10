# Loops de feedback: Corrective RAG e self-check determinístico

**Conceito da tarefa 06.** Até a tarefa 05, o grafo era uma linha reta:
`extractEntity → plan → fan-out → write`. Nenhum nó olhava para trás para o que um nó anterior
tinha produzido. Esta tarefa fecha os dois loops que `docs/architecture.md` desenha desde o
discovery de 2026-09-08, mas que até aqui eram só arquitetura — sem nenhum código os garantindo em
runtime. Os dois loops parecem simétricos ("gera, confere, refaz") e não são: a diferença entre
eles é a pergunta central deste doc.

## Duas perguntas, duas ferramentas

| | Loop 1 — grading | Loop 2 — self-check |
|---|---|---|
| pergunta | "este trecho ajuda a responder?" | "este número tem lastro na API?" |
| natureza | **julgamento** — depende de sentido, contexto, o que "ajudar" quer dizer | **fato verificável** — é pertencimento a um conjunto |
| quem decide *se* há problema | modelo (`grader`, `haiku-4-5`) | **código** (`findOrphanNumbers`) |
| o que o modelo faz | decide *se* reprova, e diz por quê | só decide *como* consertar, depois que o código já sinalizou |
| o que se corrige | a **entrada** (a query) | a **saída** (o texto da resposta) |

"Este trecho fala da fase recente do time que a pergunta menciona?" não tem uma resposta que um
regex ou uma comparação de conjuntos resolva — depende de entender o assunto do trecho e da
pergunta, e é exatamente para esse tipo de julgamento que existe um modelo de linguagem. "Este
número apareceu em `facts` ou não?" é outra coisa inteiramente: é pertencimento a um conjunto, uma
operação que uma função pura resolve em tempo determinístico, sem ambiguidade e sem variância
entre duas chamadas.

Tratar as duas perguntas com a mesma ferramenta seria errar em uma das duas direções. Usar uma
função para "isto é relevante?" faria o grafo perder exatamente o tipo de julgamento que só um
modelo treinado em linguagem natural consegue fazer. Usar um modelo para "este número está em
`facts`?" faria o oposto: trocaria uma verificação exata por uma amostra de uma distribuição — e
pior, cobraria uma chamada de LLM em toda resposta, mesmo nas 100% limpas, que são o caso comum.
É esse o motivo concreto de o crítico (`src/agent/nodes/critic.ts`) ser, antes de mais nada, código
determinístico, e só entrar `opus-5 medium` depois — para decidir *como* reescrever, nunca *se* há
algo errado.

## Loop 1: Corrective RAG

*Corrective RAG* é o nome que a literatura de RAG dá à ideia de graduar o que a busca trouxe antes
de gerar em cima disso, em vez de confiar cegamente no ranking de similaridade. A intuição:
similaridade semântica não é a mesma coisa que utilidade para responder a uma pergunta específica.
Um trecho pode ser o `#1` do ranking e ainda assim não ajudar (fala do assunto certo de um jeito
tangencial), e um trecho abaixo dele pode ser exatamente o que falta.

`gradePassages` (`src/agent/nodes/grade.ts`) faz uma chamada de `haiku-4-5` **por trecho**, todas em
paralelo, em vez de uma chamada só com os `k` trechos juntos. A diferença não é estilo: julgamentos
independentes não se contaminam. Num prompt com cinco trechos ao mesmo tempo, o modelo naturalmente
os compara entre si e devolve algo parecido com um ranking disfarçado de avaliação — "este é mais
relevante que aquele" — quando a pergunta que interessa é outra: "este trecho, sozinho, sem saber
que existem os outros quatro, ajuda a responder?". Perguntar um de cada vez é o que garante que a
resposta seja sobre o trecho, não sobre a posição dele entre os concorrentes.

### Por que proporção, e não contagem

O gatilho de reescrita (`shouldRewriteQuery`) olha para a **proporção** de trechos aprovados sobre
os julgados, não para um número absoluto de aprovados. A razão é que o denominador varia por um
motivo que nada tem a ver com a qualidade da query: `team_form` busca um pool de
`k * CANDIDATE_POOL_FACTOR` e corta em `k` só depois do decaimento temporal (tarefa 05);
`current_matchweek` não amplia pool nenhum; e o filtro rígido dos dois modos pode devolver menos que
`k` quando a coleção é pequena ou o time é pouco citado. Um gatilho por contagem trataria "1 de 2
recuperados" (a busca achou pouco, mas metade do pouco que achou serve) exatamente igual a "1 de 5"
(a busca achou bastante, e quase nada serve) — dois cenários que pedem reações diferentes. O
limiar (`GRADER_APPROVAL_THRESHOLD = 0.4`) captura o segundo caso sem penalizar o primeiro.

### O teto e o "melhor tentativa vence"

Até `MAX_QUERY_REWRITES` (2) reescritas, cada uma reaproveitando o nó `planner` já existente
(`plan(state, rewrite?)`) em vez de introduzir um segundo prompt de busca para manter em sincronia
com o primeiro. Uma reescrita pode piorar a situação — a tentativa 2 pode aprovar menos trechos que
a tentativa 1 aprovou. `runGradingLoop` guarda a **melhor** tentativa (mais trechos aprovados, com
empate para a mais antiga), não a última: um loop de correção que aceita cegamente o resultado mais
recente pode corrigir para pior, e o traço mostra as tentativas descartadas de qualquer jeito, para
quem quiser auditar a decisão.

## Loop 2: self-check é verificação, não "LLM as a judge"

É tentador descrever o loop 2 como "um segundo LLM revisando o primeiro" — mas essa descrição é
enganosa, e a diferença importa. "LLM as a judge" é a técnica de usar um modelo para avaliar a
qualidade de uma saída em dimensões sem resposta fechada: é bem escrito? é completo? é fiel ao
tom pedido? Nenhuma dessas perguntas tem uma resposta que dois avaliadores (humanos ou modelos)
concordem sempre, e é exatamente por isso que um modelo é a ferramenta certa para julgá-las — a
mesma lógica do grader do loop 1.

"Este número que aparece na resposta veio de uma chamada à API ou não?" não é uma dessas perguntas.
Tem uma resposta única e verificável: o conjunto de números que `facts` e `recentForm` realmente
contêm (`allowedNumbers`) é conhecido de antemão, sem precisar perguntar a ninguém, e comparar os
dígitos da resposta contra esse conjunto (`findOrphanNumbers`) é uma operação de conjuntos, não uma
avaliação de qualidade. Usar "LLM as a judge" aqui — pedir ao `opus-5` "este número está certo?" —
seria pior em dois eixos ao mesmo tempo: mais caro (uma chamada em toda resposta, mesmo nas limpas)
e menos confiável (a mesma pergunta, feita duas vezes ao mesmo modelo, pode sair com respostas
diferentes — e a regra de ouro do projeto não admite essa variância).

Por isso o crítico é, na ordem: (1) checagem determinística sobre a resposta que o redator
produziu; (2) só se ela sinalizar algo, uma chamada a `opus-5 medium` para decidir *como* consertar
— generalizar a frase, remover a alegação, reescrever em torno do número. O modelo nunca decide *se*
há um problema; ele só age depois que o código já decidiu que há.

**A consequência de custo é direta**: no caminho feliz — a grande maioria das respostas, quando o
redator segue a instrução de nunca derivar número novo — o loop 2 custa **zero** chamadas de LLM.
Um invariante de segurança que custasse uma chamada cara a cada resposta, mesmo nas que já estavam
certas, seria uma rede de proteção cara demais para o problema que resolve.

## O que um teto compra num loop de correção

Um loop sem teto é um loop que pode não terminar — ou, na prática, um loop que substitui "estourar"
por "nunca responder", o que para quem está esperando uma resposta é a mesma coisa. O teto de cada
loop (2 reescritas no grading, 1 refação no self-check) não é um número arbitrário: é o ponto em que
o sistema para de tentar melhorar e decide que já sabe o suficiente para responder, mesmo que
imperfeitamente.

**No teto, o sistema responde — nunca falha.** No loop 1, isso significa devolver o melhor contexto
já visto, mesmo que abaixo do limiar de aprovação (a resposta sai com aviso de baixa confiança,
dizendo que não achou contexto relevante). No loop 2, significa que, se a refação do modelo ainda
deixar um número sem lastro, o código — não mais um modelo — remove a frase que carrega esse
número, determinísticamente, e marca a resposta como baixa confiança. Essa segunda camada
determinística no teto é o que garante que a regra de ouro nunca seja violada por *falta de
tentativas*: mesmo que o `opus-5` erre, o pior caso é uma resposta mais curta, nunca uma resposta
com um número inventado.

## Por que não X?

**Por que não deixar o crítico (o modelo) decidir se há número sem lastro?** Porque essa não é uma
pergunta de julgamento — é pertencimento a um conjunto, coberto na seção acima. Reservar essa
decisão a um modelo reintroduziria variância numa verificação que devia ser exata, e custaria uma
chamada de LLM até no caminho feliz, que é o caso comum.

**Por que não graduar o pool de candidatos inteiro no `team_form`, em vez de só o top-`k` já
cortado?** O pool existe para o decaimento temporal (tarefa 05) reordenar antes do corte — julgar
os ~20 candidatos custaria ~20 chamadas de `haiku` por pergunta para descartar informação que o
próprio ranking (similaridade × decaimento) já descartou. O grading roda depois do corte, sobre o
que efetivamente chegaria ao redator.

**Por que não regenerar a resposta do zero com `write`, em vez de refazê-la com o crítico?**
Regenerar do zero jogaria fora tudo que a resposta já acertou — as citações corretas, os números
corretos, o tom — para consertar só a parte errada. O crítico recebe a resposta poluída e o
diagnóstico exato (quais números são o problema) e faz uma edição cirúrgica; `write` não tem esse
diagnóstico, só a pergunta e os dados desde o início, e teria de reconstruir tudo. Além disso,
regenerar com `write` não garante nada de novo: a mesma falha de instrução que produziu o número
inventado na primeira vez pode se repetir na segunda, porque é o mesmo prompt com o mesmo contexto.

**Por que não pedir ao redator que se autoavalie na mesma chamada** (ex.: "escreva a resposta e
depois confira se todo número tem lastro")? Pedir a um modelo que julgue o próprio texto, na mesma
geração, sofre do mesmo problema que prefill e autoavaliação sempre sofrem: o modelo tende a
confirmar o que acabou de escrever, porque a autoavaliação usa o mesmo contexto e o mesmo
"raciocínio" que produziu o erro em primeiro lugar. Separar em duas etapas — escrever, depois
verificar com um mecanismo que não depende do juízo do próprio redator — é o que dá alguma
independência à checagem. E, mais uma vez: a checagem em si nem precisa ser um modelo — é código.

**Por que não um framework de agente (LangGraph, Mastra) para os ciclos?** A decisão 9 de
`docs/architecture.md` já cobre isso para o grafo inteiro, e os loops não mudam o argumento: um
framework de ciclos esconderia justamente a parte que este projeto existe para deixar visível — o
"por que reescreveu", o "por que refez", o traço de cada tentativa. `runGradingLoop` é um `for`
comum com `measure`/`record` em volta de cada chamada; não há nada que um framework tornaria mais
simples que compensasse esconder essa mecânica de quem está aprendendo a ver como ela funciona.

**Por que não persistir feedback humano** (um usuário marcando "essa resposta estava errada")
**para alimentar os loops?** Ficou fora de escopo desde o discovery de 2026-09-08: isso exige
armazenar avaliações em algum lugar e um mecanismo para transformar esse sinal em ajuste do
sistema (re-treino, few-shot dinâmico, ajuste de prompt) — é um projeto à parte, com sua própria
decisão de design, não uma extensão natural dos dois loops desta tarefa, que corrigem dentro de uma
única pergunta-resposta, sem memória entre perguntas.
