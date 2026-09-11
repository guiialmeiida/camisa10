# Fontes de dados: fato separado de narrativa

**Conceito da tarefa 01.** Não é sobre como chamar uma API REST — é sobre uma escolha de
arquitetura que aparece bem antes de qualquer linha de RAG: **de onde vem cada tipo de
informação, e por que elas nunca podem se misturar.**

## O problema

Um sistema de perguntas e respostas sobre futebol precisa de duas coisas muito diferentes:

1. **Fato exato.** "Palmeiras 1 x 3 Fluminense." Um número. Ou está certo, ou está errado — não
   existe "quase certo" num placar.
2. **Narrativa.** "O time saiu de campo vaiado, terceira derrota seguida em casa." Não existe
   fonte única de verdade para isso; é interpretação, é o que um jornalista escolheu contar.

A tentação de um sistema RAG ingênuo é tratar as duas a mesma forma: jogar tudo num índice
vetorial, buscar por similaridade, deixar o LLM sintetizar a resposta. O problema é que um LLM
gerando texto a partir de um trecho recuperado **não distingue "citar uma frase" de "citar um
número"** — ele completa os dois do mesmo jeito, por probabilidade. Se uma crônica de jogo, por
erro de redação ou por estar comentando *outro* jogo, disser "venceu por 2 a 0", nada no
mecanismo de geração impede esse número de vazar para a resposta como se fosse o placar oficial.

## A regra de ouro, e por que ela vira duas fontes

A solução deste projeto não é "confiar mais no prompt". É **arquitetural**: fato exato nunca
passa pelo índice vetorial. Ele vem de uma chamada direta a uma API estruturada
(`fetch_facts_api`), que devolve um objeto tipado — `{ home: 1, away: 3 }` — sem ambiguidade
nenhuma. O índice vetorial (`search_vector_context`) só entrega texto para narrativa, e o prompt
do writer instrui explicitamente: *números do context nunca viram números da resposta.*

Na tarefa 00 isso era uma regra escrita num fixture de mentira. Nesta tarefa ela vira **código
de verdade**: `src/sources/facts.ts` só conversa com as duas APIs de futebol;
`src/sources/passages.ts` só conversa com o feed RSS. Não existe um caminho de import, de tipo
ou de função onde um `Passage` (que não tem campo de placar — nem no tipo, nem no schema
`zod` do Qdrant) alimente um número que chega ao usuário. A separação está no **desenho dos
módulos**, não numa instrução que o modelo pode ignorar num dia ruim.

## Por que duas APIs de fato, não uma

Se fato exato é tão importante, por que não usar a API que parecer mais completa e pronto? Duas
razões, as duas descobertas testando ao vivo (não supondo a partir de documentação):

- **football-data.org** é gratuito para sempre, cobre o Brasileirão Série A, e é a fonte
  primária — placar de jogo encerrado, rodada corrente, tabela. Mas no tier gratuito ele **não
  garante placar atualizado em tempo real** para um jogo em andamento; isso é um complemento
  pago lá.
- **API-Football** (api-sports.io) tem uma cota muito mais apertada (100 requisições/dia contra
  os ~14.400 teóricos do football-data.org), mas o endpoint `/fixtures?live=all` devolve minuto
  decorrido e placar parcial sem atraso perceptível, no plano gratuito.

A saída não foi escolher uma ou consolidar tudo numa API só — foi usar **cada uma só onde ela
comprovadamente é melhor**, com uma regra determinística (não uma decisão de LLM): `getFacts`
sempre pergunta primeiro ao football-data.org; só quando o status devolvido já é "jogo em
andamento", uma segunda chamada busca o placar preciso daquele jogo específico no API-Football.
Se essa segunda chamada falhar — chave ausente, API fora do ar, time que não casou — o sistema
**nunca lança erro por causa dela**. Ela é enriquecimento da fonte primária, não uma segunda
fonte de verdade concorrente; deixá-la derrubar a resposta inverteria a hierarquia.

Isso é o mesmo princípio de resiliência do `Promise.allSettled` no fan-out do agente (tarefa 00),
um nível abaixo: a fonte secundária pode cair sem que o sistema pare de responder.

## O que o RSS pode alimentar, e o que ele não pode

O feed RSS (`gazetaesportiva.com/feed/`) é a **única** fonte de narrativa deste projeto. Ele
entrega manchete, texto e data de publicação — o material bruto de onde `chunking` (tarefa 03) e
embedding tiram trechos pesquisáveis.

O que ele explicitamente **não** pode fazer:

- **Não alimenta `Facts`.** Mesmo que uma notícia mencione um placar no título, esse número não
  tem tipo para onde ir: o schema `Passage` não tem campo numérico de placar, e o `z.strictObject`
  do payload do Qdrant rejeita a tentativa de inserir um. A regra de ouro está expressa **duas
  vezes** — no tipo TypeScript e no schema `zod` — porque o tipo protege em tempo de compilação e
  o schema protege em tempo de execução (um JSON vindo de fora do processo não passa pelo
  compilador).
- **Não liga automaticamente a um jogo específico.** `Passage.matchId` é `string | null`: uma
  notícia de feed chega solta, sem saber a qual partida ela se refere. Ligar narrativa a partida
  (por texto, por data, por times mencionados) é trabalho de correlação que fica para a tarefa 02
  — aqui, o único vínculo que existe é `teams: string[]`, times citados no texto, casados contra
  a lista curada (`tagTeams`).
- **Não decide relevância.** O feed geral da Gazeta traz vôlei, Fórmula 1, basquete — qualquer
  notícia esportiva. Um item sem nenhum time do Brasileirão reconhecido no texto é descartado
  antes de entrar no índice (decisão do usuário na aprovação desta spec); mas a curadoria fina de
  "isso é relevante para responder bem" continua sendo trabalho da tarefa 02 e do grader da
  tarefa 06, não deste módulo.

## Por que apelido é dado curado, não API

Nenhuma API de futebol tem um campo "apelido popular". "Verdão", "Timão", "Mengão" são
conhecimento de torcedor, não fato de cadastro — e são exatamente o tipo de informação que o
`extractEntity` (tarefa 00) precisa para entender "o alviverde" como uma pergunta sobre o
Palmeiras. A solução é uma lista curada, versionada no repo (`src/sources/teams.json`, ~20 times
da Série A): fixa, estável, pequena o bastante para caber inteira, e sob controle de quem sabe o
domínio — o usuário, não uma chamada de rede.

Esse arquivo cumpre três papéis ao mesmo tempo: dá o vocabulário de apelido para o prompt do
`extractEntity`; traduz o id numérico de cada API de futebol para o slug interno do sistema
(`teamIdFromFootballData`); e resolve nome/sigla/variação de escrita para esse mesmo slug
(`resolveTeamId`), usado para casar o time de uma partida ao vivo do API-Football contra o time
já mapeado do football-data.org. É por isso que `resolveTeamId` **nunca** olha apelido — só nome
e sigla oficial: "Tricolor" sozinho é ambíguo (Fluminense, São Paulo, Grêmio, Bahia disputam o
apelido), e só o contexto da pergunta, que é trabalho do LLM no `extractEntity`, consegue
desambiguar isso.

## Por que não X?

**Por que não uma única API "completa" para tudo (fato e notícia)?** Nenhuma das duas APIs de
futebol pesquisadas tem endpoint de notícia em prosa — elas devolvem dado estruturado (placar,
escalação, estatística), não a crônica de jornalista que o caso de uso "forma do time" precisa.
E mesmo que existisse, misturar fato e narrativa na mesma fonte reintroduziria o problema que a
regra de ouro existe para evitar: number e texto passando pelo mesmo cano, sem separação
estrutural.

**Por que não IA generativa para "inventar" o resumo da rodada, sem RSS?** Um LLM sem fonte
externa alucina — não tem como saber o que realmente aconteceu numa partida ou o que a imprensa
está dizendo sobre um time hoje. É exatamente o problema que RAG existe para resolver: ancorar a
geração em texto real, recuperável e citável.

**Por que não fazer scraping direto de site de notícia, em vez de RSS?** RSS é um contrato
público e estável — o site já publica esse feed para ser consumido por máquina, com `robots.txt`
sinalizando permissão explícita para crawler de IA (`gazetaesportiva.com` libera
`GPTBot`/`ClaudeBot` com `Allow: /`). Scraping da página HTML depende da estrutura visual do
site, quebra a cada redesign, e — no caso de outros veículos pesquisados (Globo Esporte,
Flashscore) — esbarra em bloqueio explícito de `robots.txt` ou proibição de ToS. RSS é o caminho
que já é para isso.

**Por que não confiar só na API-Football, já que ela cobre tudo (fato, ao vivo, tudo)?** A cota
dela é muito mais apertada no plano gratuito (100 requisições/dia contra os ~14.400 do
football-data.org), e a qualidade do endpoint de tabela/rodada dela para o Brasileirão nunca foi
confirmada. Usar as duas, cada uma no que comprovadamente faz melhor, é mais barato e mais
verificado do que apostar tudo numa API só porque ela "parece" cobrir mais.

**Por que `getFacts` nunca inventa um placar quando o campo vem `null` da API?** Porque um "0 x
0" fabricado é exatamente o tipo de número sem lastro que a regra de ouro inteira existe para
impedir — e o pior lugar para ele nascer seria dentro da própria fonte de fatos, o lugar que
todo o resto do sistema trata como verdade absoluta. É melhor descartar o jogo da lista (com um
aviso) do que respondê-lo com um número errado.
