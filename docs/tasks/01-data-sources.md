# Tarefa 01: Fontes de dados

Corresponde ao nó "Fontes de dados" do diagrama em `docs/architecture.md`. Depende da tarefa 00:
**substitui o fixture JSON da fatia vertical pela fonte real**, com o conjunto de avaliação da 00
servindo de rede.

## Status
- [x] Discovery
- [ ] Refinamento técnico
- [ ] Implementação
- [ ] Revisão
- [ ] Testes

## Discovery

Concluído no grilling de 2026-09-10. As quatro perguntas originais (API estruturada, escopo de
competições, fonte de texto, cadência) mais duas que surgiram na pesquisa (apelido de time,
orquestração do dado ao vivo) foram decididas nesta ordem:

1. **Escopo do MVP: só Brasileirão Série A.** Ampliar competições depois é mudança barata (mais
   configuração, não redesenho); ampliar agora misturaria "trocar fixture por API real" com
   "cobrir mais coisa" — dois riscos ao mesmo tempo. `API_FUTEBOL_TOKEN`, que já estava no
   `.env.example` como inclinação inicial não confirmada, **não é mais a decisão** — ver item 2.

2. **API estruturada de fatos exatos (placar, tabela, rodada): `football-data.org`.**
   Pesquisado e confirmado ao vivo (não só relatório de terceiro): tier gratuito **pra sempre**,
   cobre Brasileirão Série A (código de competição `BSA`), 10 requisições/min, autenticação por
   token simples. A alternativa inicial (API Futebol) acabou descartada: não é gratuita pra uso
   contínuo (só trial), e não consegui confirmar preço/limite real na doc oficial (fetch
   bloqueado). Sportmonks também descartado: Brasileirão só entra a partir do tier pago
   (~€99/mês); free cobre só 2 ligas.

   Endpoint de partidas filtra por rodada via `?matchday=N` (confirmado na doc oficial). O
   objeto de time tem `shortName`/`tla`, mas **não** tem apelido popular (Verdão, Timão) — ver
   item 4.

3. **API estruturada de fatos exatos, só para jogo em andamento: `API-Football`
   (api-sports.io/dashboard.api-football.com), como segunda fonte.** O tier gratuito do
   football-data.org não garante placar atualizado em tempo real pra jogo em andamento
   (`IN_PLAY`) — isso é addon pago (€12/mês) lá. Testado ao vivo com uma chave real do usuário
   (plano Free, 100 req/dia): `/fixtures?live=all` funciona sem paywall, devolve minuto
   decorrido, placar parcial e eventos (gol) sem atraso aparente. Liga do Brasileirão nessa API:
   `league.id = 71`.

   **Orquestração decidida**: regra determinística, não decisão do LLM. `getFacts` sempre
   consulta o football-data.org primeiro; só quando o `status` retornado já é `IN_PLAY`, uma
   segunda chamada à API-Football busca o placar preciso daquele jogo específico. Mantém as duas
   APIs, cada uma no que comprovadamente faz melhor, em vez de consolidar tudo numa API só (a
   API-Football parece cobrir tudo, mas sua cota de 100/dia é bem mais apertada que os ~14.400/dia
   teóricos do football-data.org, e não foi confirmado se o endpoint de tabela dela tem a mesma
   qualidade).

4. **Apelidos de time (alviverde → Palmeiras, Timão → Corinthians): lista curada à mão no
   repo.** Nenhuma API tem esse campo — é dado editorial/popular. O Brasileirão tem ~20 times, é
   finito e estável; a tarefa 00 já validou esse padrão no fixture (campo `teams.nicknames`).
   Evita depender de mais uma fonte externa só pra isso.

5. **Fonte de texto/narrativa (notícias/crônicas pro índice vetorial): `gazetaesportiva.com`,
   via RSS.** Testado ao vivo: feed RSS 2.0 válido (geral e um específico de times do Brasil),
   itens recentes. `robots.txt` tem um bloco `# AI Crawlers` que **libera explicitamente**
   `GPTBot`/`ClaudeBot`/`Google-Extended`/etc. com `Allow: /` — permissão declarada, não ausência
   de bloqueio.

   Descartados no caminho: **Globo Esporte** (`ge.globo.com`) — `robots.txt` desautoriza
   `GPTBot`/`Google-Extended`/`CCBot` explicitamente. **Flashscore** — sem RSS, conteúdo é
   placar/estatística estruturada (não a crônica/matéria em prosa que o caso de uso precisa),
   `robots.txt` bloqueia por nome vários crawlers de dados/IA, ToS proíbe scraping com previsão
   de ação legal. **LANCE!**, **UAI/SuperEsportes**, **futebolinterior.com.br**,
   **colunadofla.com**, **placar.com.br**: sem RSS funcional confirmado ao vivo, ou robots.txt
   bloqueando o próprio path do feed. `meutimao.com.br` (blog do Corinthians) também tem RSS
   funcional e robots.txt neutro sobre IA — fica como candidato secundário pra somar depois, fora
   do escopo desta tarefa por ora.

6. **Cadência/cache de consulta: fica pra tarefa 02.** `fetch_facts_api` chama a API direto a
   cada pergunta por enquanto — dentro do rate limit pro volume de um projeto de aprendizado, e
   cache é otimização prematura numa tarefa que já está trocando a fonte inteira.

Lembrar da separação que a arquitetura exige e que não foi reaberta aqui: a API estruturada
alimenta `fetch_facts_api` (números exatos), as fontes de texto alimentam o índice vetorial
(narrativa). Elas não se misturam — a API-Football também entra só pelo lado de fatos, nunca
pelo lado de texto.

## Refinamento técnico
_A preencher após o discovery._

## Implementação
_A preencher._

## Revisão
_A preencher._

## Testes
_A preencher._
